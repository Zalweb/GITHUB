import sqlite3
import json
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timezone
from PIL import Image
import face_recognition
import io
import os
import cv2
import onnxruntime as ort
from geo import geofence_check

app = FastAPI(
    title="FACE API",
    description="Facial recognition backend",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "faces.db"
INDEX_PATH = os.path.join(os.path.dirname(__file__), "index.html")

# =========================
# Anti-spoofing (MiniFASNet ONNX)
# =========================
ANTI_SPOOF_MODEL_PATH = os.getenv("ANTI_SPOOF_MODEL_PATH", "models/MiniFASNetV2.onnx")
ANTI_SPOOF_SCALE = float(os.getenv("ANTI_SPOOF_SCALE", "2.7"))  # 2.7 for V2, 4.0 for V1SE :contentReference[oaicite:2]{index=2}
LIVENESS_MIN_SCORE = float(os.getenv("LIVENESS_MIN_SCORE", "0.85"))  # tune this
ALLOW_LIVENESS_BYPASS_WHEN_MODEL_MISSING = os.getenv("ALLOW_LIVENESS_BYPASS_WHEN_MODEL_MISSING", "1") == "1"
MAX_ALLOWED_ACCURACY_M = float(os.getenv("MAX_ALLOWED_ACCURACY_M", "30.0"))

_anti_spoof_session = None
_anti_spoof_input_name = None
_anti_spoof_output_name = None
_anti_spoof_input_size = None  # (H, W)

def _softmax(x: np.ndarray) -> np.ndarray:
    e_x = np.exp(x - np.max(x, axis=1, keepdims=True))
    return e_x / e_x.sum(axis=1, keepdims=True)

def init_anti_spoof():
    global _anti_spoof_session, _anti_spoof_input_name, _anti_spoof_output_name, _anti_spoof_input_size
    if not os.path.exists(ANTI_SPOOF_MODEL_PATH):
        # Don’t crash the server; we’ll raise a clear error only when endpoint is hit
        return
    _anti_spoof_session = ort.InferenceSession(
        ANTI_SPOOF_MODEL_PATH,
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    inp = _anti_spoof_session.get_inputs()[0]
    out = _anti_spoof_session.get_outputs()[0]
    _anti_spoof_input_name = inp.name
    _anti_spoof_output_name = out.name
    # ONNX expects NCHW, so shape is [1,3,H,W]
    _anti_spoof_input_size = (int(inp.shape[2]), int(inp.shape[3]))  # (H, W)

init_anti_spoof()

def _xyxy2xywh(x1, y1, x2, y2):
    return [int(x1), int(y1), int(x2 - x1), int(y2 - y1)]

def _crop_face_bgr(image_bgr: np.ndarray, bbox_xywh: list[int], scale: float, out_h: int, out_w: int) -> np.ndarray:
    src_h, src_w = image_bgr.shape[:2]
    x, y, box_w, box_h = bbox_xywh

    scale = min((src_h - 1) / max(box_h, 1), (src_w - 1) / max(box_w, 1), scale)
    new_w = box_w * scale
    new_h = box_h * scale
    cx = x + box_w / 2
    cy = y + box_h / 2

    x1 = max(0, int(cx - new_w / 2))
    y1 = max(0, int(cy - new_h / 2))
    x2 = min(src_w - 1, int(cx + new_w / 2))
    y2 = min(src_h - 1, int(cy + new_h / 2))

    cropped = image_bgr[y1:y2 + 1, x1:x2 + 1]
    if cropped.size == 0:
        raise HTTPException(status_code=400, detail="Invalid face crop for anti-spoofing.")
    return cv2.resize(cropped, (out_w, out_h))

def anti_spoof_check(rgb_image: np.ndarray) -> dict:
    """
    Returns: {"label": "Real"/"Fake", "score": float}
    Uses face_recognition face_locations for bbox, MiniFASNet ONNX for liveness.
    """
    if _anti_spoof_session is None:
        if ALLOW_LIVENESS_BYPASS_WHEN_MODEL_MISSING:
            return {"label": "Bypassed", "score": 1.0, "reason": "model_missing"}
        raise HTTPException(
            status_code=500,
            detail=f"Anti-spoof model not found. Put model at: {ANTI_SPOOF_MODEL_PATH}"
        )

    # Detect face bbox using face_recognition (top, right, bottom, left)
    locs = face_recognition.face_locations(rgb_image)
    if not locs:
        raise HTTPException(status_code=400, detail="No face detected (anti-spoof).")
    if len(locs) != 1:
        raise HTTPException(status_code=400, detail="Please upload an image with exactly 1 face (anti-spoof).")

    top, right, bottom, left = locs[0]
    x1, y1, x2, y2 = left, top, right, bottom

    # Convert RGB -> BGR because OpenCV cropping/resizing + many ONNX examples use BGR :contentReference[oaicite:3]{index=3}
    bgr = rgb_image[:, :, ::-1].copy()

    bbox_xywh = _xyxy2xywh(x1, y1, x2, y2)
    H, W = _anti_spoof_input_size  # (H,W)
    face_crop = _crop_face_bgr(bgr, bbox_xywh, ANTI_SPOOF_SCALE, H, W)

    x = face_crop.astype(np.float32)
    x = np.transpose(x, (2, 0, 1))  # CHW
    x = np.expand_dims(x, axis=0)   # NCHW

    logits = _anti_spoof_session.run([_anti_spoof_output_name], {_anti_spoof_input_name: x})[0]
    probs = _softmax(logits)
    label_idx = int(np.argmax(probs))
    score = float(probs[0, label_idx])

    # In the reference ONNX inference, index 1 is treated as "Real", else "Fake". :contentReference[oaicite:4]{index=4}
    label = "Real" if label_idx == 1 else "Fake"
    return {"label": label, "score": score}


def liveness_passed(live: dict) -> bool:
    if live.get("label") == "Bypassed":
        return True
    return live.get("label") == "Real" and float(live.get("score", 0.0)) >= LIVENESS_MIN_SCORE

def init_db():
    con = sqlite3.connect(DB_PATH)

    con.execute("""
        CREATE TABLE IF NOT EXISTS faces (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            name      TEXT NOT NULL,
            embedding TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            name      TEXT NOT NULL,
            lat       REAL NOT NULL,
            lng       REAL NOT NULL,
            radius_m  REAL NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS attendance (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id    INTEGER NOT NULL,
            person_name TEXT NOT NULL,
            distance_m  REAL NOT NULL,
            lat         REAL NOT NULL,
            lng         REAL NOT NULL,
            accuracy_m  REAL,
            liveness_label TEXT NOT NULL,
            liveness_score REAL NOT NULL,
            created_at  TEXT NOT NULL,
            FOREIGN KEY(event_id) REFERENCES events(id)
        )
    """)

    con.commit()
    con.close()

init_db()

def load_rgb_from_bytes(data: bytes) -> np.ndarray:
    image = Image.open(io.BytesIO(data)).convert("RGB")
    return np.array(image)

def get_embedding_from_rgb(rgb: np.ndarray) -> list:
    encodings = face_recognition.face_encodings(rgb)
    if not encodings:
        raise HTTPException(status_code=400, detail="No face detected in image.")
    return encodings[0].tolist()


class LocationPayload(BaseModel):
    lat: float
    lng: float
    accuracy_m: float | None = None


class CheckInPayload(BaseModel):
    event_id: int
    lat: float
    lng: float
    accuracy_m: float | None = None

@app.post("/register")
async def register(name: str, file: UploadFile = File(...)):
    data = await file.read()
    rgb = load_rgb_from_bytes(data)

    # ✅ Anti-spoof gate
    live = anti_spoof_check(rgb)
    if not liveness_passed(live):
        raise HTTPException(
            status_code=403,
            detail=f"Spoof detected. label={live['label']} score={live['score']:.3f}"
        )

    embedding = get_embedding_from_rgb(rgb)

    con = sqlite3.connect(DB_PATH)
    con.execute("INSERT INTO faces (name, embedding) VALUES (?, ?)",
                (name, json.dumps(embedding)))
    con.commit()
    con.close()

    return {"message": f"Registered '{name}' successfully.", "liveness": live}

@app.post("/recognize")
async def recognize(file: UploadFile = File(...), threshold: float = 0.5):
    data = await file.read()
    rgb = load_rgb_from_bytes(data)

    # ✅ Anti-spoof gate
    live = anti_spoof_check(rgb)
    if not liveness_passed(live):
        return {"match": None, "message": "Spoof detected.", "liveness": live}

    query_embedding = np.array(get_embedding_from_rgb(rgb))

    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT name, embedding FROM faces").fetchall()
    con.close()

    if not rows:
        raise HTTPException(status_code=404, detail="No faces registered yet.")

    best_match = None
    best_distance = float("inf")

    for name, emb_json in rows:
        stored = np.array(json.loads(emb_json))
        distance = float(np.linalg.norm(query_embedding - stored))
        if distance < best_distance:
            best_distance = distance
            best_match = name

    if best_distance > threshold:
        return {"match": None, "confidence": round(1 - best_distance, 4), "message": "No match found.", "liveness": live}

    return {
        "match": best_match,
        "confidence": round(1 - best_distance, 4),
        "distance": round(best_distance, 4),
        "liveness": live
    }

@app.post("/liveness")
async def liveness(file: UploadFile = File(...)):
    data = await file.read()
    rgb = load_rgb_from_bytes(data)
    return anti_spoof_check(rgb)


@app.post("/events")
def create_event(name: str, lat: float, lng: float, radius_m: float = 50.0):
    now = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(
        "INSERT INTO events (name, lat, lng, radius_m, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        (name, lat, lng, radius_m, now),
    )
    con.commit()
    event_id = cur.lastrowid
    con.close()
    return {"id": event_id, "name": name, "lat": lat, "lng": lng, "radius_m": radius_m, "created_at": now}


@app.get("/events")
def list_events():
    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT id, name, lat, lng, radius_m, is_active, created_at FROM events ORDER BY id DESC").fetchall()
    con.close()
    return [
        {"id": r[0], "name": r[1], "lat": r[2], "lng": r[3], "radius_m": r[4], "is_active": bool(r[5]), "created_at": r[6]}
        for r in rows
    ]


@app.patch("/events/{event_id}/active")
def set_event_active(event_id: int, active: bool = True):
    con = sqlite3.connect(DB_PATH)
    con.execute("UPDATE events SET is_active = ? WHERE id = ?", (1 if active else 0, event_id))
    con.commit()
    con.close()
    return {"message": f"Event {event_id} active={active}"}


@app.delete("/events/{event_id}")
def delete_event(event_id: int):
    con = sqlite3.connect(DB_PATH)
    con.execute("DELETE FROM events WHERE id = ?", (event_id,))
    con.commit()
    con.close()
    return {"message": f"Deleted event {event_id}."}


@app.post("/events/{event_id}/verify-location")
def verify_location(event_id: int, payload: LocationPayload):
    con = sqlite3.connect(DB_PATH)
    row = con.execute("SELECT lat, lng, radius_m, is_active FROM events WHERE id = ?", (event_id,)).fetchone()
    con.close()

    if not row:
        raise HTTPException(status_code=404, detail="Event not found.")
    event_lat, event_lng, radius_m, is_active = row
    if not bool(is_active):
        raise HTTPException(status_code=403, detail="Event is not active.")

    result = geofence_check(
        user_lat=payload.lat,
        user_lng=payload.lng,
        event_lat=event_lat,
        event_lng=event_lng,
        radius_m=radius_m,
        accuracy_m=payload.accuracy_m,
        max_allowed_accuracy_m=MAX_ALLOWED_ACCURACY_M,
    )

    if not result.ok:
        raise HTTPException(
            status_code=403,
            detail={
                "reason": result.reason,
                "distance_m": round(result.distance_m, 1),
                "radius_m": result.radius_m,
            },
        )

    return {"ok": True, "distance_m": round(result.distance_m, 1), "radius_m": result.radius_m}


@app.post("/attendance/checkin")
async def attendance_checkin(payload: str, file: UploadFile = File(...), threshold: float = 0.5):
    """
    Multipart form-data:
      - payload: JSON string (event_id, lat, lng, accuracy_m)
      - file: face image
    Example payload:
      {"event_id":1,"lat":14.65,"lng":121.05,"accuracy_m":12.3}
    """
    try:
        p = CheckInPayload(**json.loads(payload))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid payload JSON.")

    con = sqlite3.connect(DB_PATH)
    row = con.execute("SELECT lat, lng, radius_m, is_active FROM events WHERE id = ?", (p.event_id,)).fetchone()
    con.close()

    if not row:
        raise HTTPException(status_code=404, detail="Event not found.")
    event_lat, event_lng, radius_m, is_active = row
    if not bool(is_active):
        raise HTTPException(status_code=403, detail="Event is not active.")

    data = await file.read()
    rgb = load_rgb_from_bytes(data)

    live = anti_spoof_check(rgb)
    if not liveness_passed(live):
        return {"ok": False, "stage": "liveness", "message": "Spoof detected.", "liveness": live}

    query_embedding = np.array(get_embedding_from_rgb(rgb))

    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT name, embedding FROM faces").fetchall()
    con.close()

    if not rows:
        raise HTTPException(status_code=404, detail="No faces registered yet.")

    best_match = None
    best_distance = float("inf")

    for name, emb_json in rows:
        stored = np.array(json.loads(emb_json))
        distance = float(np.linalg.norm(query_embedding - stored))
        if distance < best_distance:
            best_distance = distance
            best_match = name

    if best_distance > threshold:
        return {
            "ok": False,
            "stage": "recognize",
            "match": None,
            "distance": round(best_distance, 4),
            "message": "No match found.",
            "liveness": live,
        }

    geo = geofence_check(
        user_lat=p.lat,
        user_lng=p.lng,
        event_lat=event_lat,
        event_lng=event_lng,
        radius_m=radius_m,
        accuracy_m=p.accuracy_m,
        max_allowed_accuracy_m=MAX_ALLOWED_ACCURACY_M,
    )

    if not geo.ok:
        return {
            "ok": False,
            "stage": "geofence",
            "match": best_match,
            "distance_face": round(best_distance, 4),
            "geo": {"ok": False, "reason": geo.reason, "distance_m": round(geo.distance_m, 1), "radius_m": geo.radius_m},
            "liveness": live,
        }

    now = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(DB_PATH)
    con.execute(
        """
        INSERT INTO attendance (event_id, person_name, distance_m, lat, lng, accuracy_m, liveness_label, liveness_score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            p.event_id,
            best_match,
            float(geo.distance_m),
            float(p.lat),
            float(p.lng),
            None if p.accuracy_m is None else float(p.accuracy_m),
            str(live.get("label", "Unknown")),
            float(live.get("score", 0.0)),
            now,
        ),
    )
    con.commit()
    con.close()

    return {
        "ok": True,
        "stage": "saved",
        "match": best_match,
        "distance_face": round(best_distance, 4),
        "geo": {"ok": True, "distance_m": round(geo.distance_m, 1), "radius_m": geo.radius_m},
        "liveness": live,
        "created_at": now,
    }


@app.get("/attendance")
def list_attendance(event_id: int | None = None):
    con = sqlite3.connect(DB_PATH)
    if event_id is None:
        rows = con.execute(
            "SELECT id, event_id, person_name, distance_m, lat, lng, accuracy_m, liveness_label, liveness_score, created_at FROM attendance ORDER BY id DESC"
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT id, event_id, person_name, distance_m, lat, lng, accuracy_m, liveness_label, liveness_score, created_at FROM attendance WHERE event_id = ? ORDER BY id DESC",
            (event_id,),
        ).fetchall()
    con.close()

    return [
        {
            "id": r[0],
            "event_id": r[1],
            "person_name": r[2],
            "distance_m": r[3],
            "lat": r[4],
            "lng": r[5],
            "accuracy_m": r[6],
            "liveness_label": r[7],
            "liveness_score": r[8],
            "created_at": r[9],
        }
        for r in rows
    ]

@app.get("/", include_in_schema=False)
def root():
    if os.path.exists(INDEX_PATH):
        return FileResponse(INDEX_PATH)
    return {"message": "FACE API is running.", "docs": "/docs"}

@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)

@app.get("/faces")
def list_faces():
    """List all registered names."""
    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT id, name FROM faces").fetchall()
    con.close()
    return [{"id": r[0], "name": r[1]} for r in rows]

@app.delete("/faces/{face_id}")
def delete_face(face_id: int):
    """Remove a registered face by ID."""
    con = sqlite3.connect(DB_PATH)
    con.execute("DELETE FROM faces WHERE id = ?", (face_id,))
    con.commit()
    con.close()
    return {"message": f"Deleted face ID {face_id}."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
