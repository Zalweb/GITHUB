import sqlite3
import json
from datetime import datetime, timezone
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import face_recognition
import io
import os
import cv2
import onnxruntime as ort
from pydantic import BaseModel
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

BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(BASE_DIR, "faces.db")
INDEX_PATH = os.path.join(BASE_DIR, "index.html")

# =========================
# Anti-spoofing (MiniFASNet ONNX)
# =========================
ANTI_SPOOF_MODEL_PATH = os.getenv("ANTI_SPOOF_MODEL_PATH", os.path.join(BASE_DIR, "models", "MiniFASNetV2.onnx"))
ANTI_SPOOF_SCALE = float(os.getenv("ANTI_SPOOF_SCALE", "2.7"))  # 2.7 for V2, 4.0 for V1SE :contentReference[oaicite:2]{index=2}
LIVENESS_MIN_SCORE = float(os.getenv("LIVENESS_MIN_SCORE", "0.85"))  # tune this
ALLOW_LIVENESS_BYPASS_WHEN_MODEL_MISSING = os.getenv("ALLOW_LIVENESS_BYPASS_WHEN_MODEL_MISSING", "1") == "1"
MAX_ALLOWED_ACCURACY_M = float(os.getenv("MAX_ALLOWED_ACCURACY_M", "200"))

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


class EventLocationPayload(BaseModel):
    lat: float
    lng: float
    accuracy_m: float | None = None


class AttendanceCheckinPayload(EventLocationPayload):
    event_id: int


def db_connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def serialize_event(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "lat": row["lat"],
        "lng": row["lng"],
        "radius_m": row["radius_m"],
        "is_active": bool(row["is_active"]),
        "created_at": row["created_at"],
    }


def serialize_attendance(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "event_id": row["event_id"],
        "person_name": row["person_name"],
        "distance_m": row["distance_m"],
        "lat": row["lat"],
        "lng": row["lng"],
        "accuracy_m": row["accuracy_m"],
        "liveness_label": row["liveness_label"],
        "liveness_score": row["liveness_score"],
        "created_at": row["created_at"],
    }


def get_event_or_404(event_id: int) -> sqlite3.Row:
    con = db_connect()
    row = con.execute(
        """
        SELECT id, name, lat, lng, radius_m, is_active, created_at
        FROM events
        WHERE id = ?
        """,
        (event_id,),
    ).fetchone()
    con.close()

    if row is None:
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found.")

    return row

def init_db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS faces (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            name    TEXT NOT NULL,
            embedding TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            name    TEXT NOT NULL,
            lat     REAL NOT NULL,
            lng     REAL NOT NULL,
            radius_m REAL NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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


def find_best_face_match(query_embedding: np.ndarray) -> tuple[str, float]:
    con = db_connect()
    rows = con.execute("SELECT name, embedding FROM faces").fetchall()
    con.close()

    if not rows:
        raise HTTPException(status_code=404, detail="No faces registered yet.")

    best_match = None
    best_distance = float("inf")

    for row in rows:
        stored = np.array(json.loads(row["embedding"]))
        distance = float(np.linalg.norm(query_embedding - stored))
        if distance < best_distance:
            best_distance = distance
            best_match = row["name"]

    if best_match is None:
        raise HTTPException(status_code=404, detail="No faces registered yet.")

    return best_match, best_distance

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
    best_match, best_distance = find_best_face_match(query_embedding)

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
    con = db_connect()
    rows = con.execute("SELECT id, name FROM faces ORDER BY id DESC").fetchall()
    con.close()
    return [{"id": row["id"], "name": row["name"]} for row in rows]

@app.delete("/faces/{face_id}")
def delete_face(face_id: int):
    """Remove a registered face by ID."""
    con = db_connect()
    cursor = con.execute("DELETE FROM faces WHERE id = ?", (face_id,))
    con.commit()
    con.close()

    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Face {face_id} not found.")

    return {"message": f"Deleted face ID {face_id}."}


@app.post("/events")
def create_event(name: str, lat: float, lng: float, radius_m: float = 50):
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Event name is required.")
    if radius_m <= 0:
        raise HTTPException(status_code=400, detail="Event radius must be greater than 0.")

    created_at = utc_now_iso()
    con = db_connect()
    cursor = con.execute(
        """
        INSERT INTO events (name, lat, lng, radius_m, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (clean_name, lat, lng, radius_m, created_at),
    )
    event_id = cursor.lastrowid
    row = con.execute(
        """
        SELECT id, name, lat, lng, radius_m, is_active, created_at
        FROM events
        WHERE id = ?
        """,
        (event_id,),
    ).fetchone()
    con.commit()
    con.close()

    if row is None:
        raise HTTPException(status_code=500, detail="Event was created but could not be reloaded.")

    return serialize_event(row)


@app.get("/events")
def list_events():
    con = db_connect()
    rows = con.execute(
        """
        SELECT id, name, lat, lng, radius_m, is_active, created_at
        FROM events
        ORDER BY is_active DESC, datetime(created_at) DESC, id DESC
        """
    ).fetchall()
    con.close()
    return [serialize_event(row) for row in rows]


@app.patch("/events/{event_id}/active")
def set_event_active(event_id: int, active: bool = True):
    con = db_connect()
    cursor = con.execute(
        "UPDATE events SET is_active = ? WHERE id = ?",
        (1 if active else 0, event_id),
    )
    con.commit()
    con.close()

    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found.")

    return {"message": f"Event {event_id} {'activated' if active else 'deactivated'}."}


@app.delete("/events/{event_id}")
def delete_event(event_id: int):
    con = db_connect()
    con.execute("DELETE FROM attendance WHERE event_id = ?", (event_id,))
    cursor = con.execute("DELETE FROM events WHERE id = ?", (event_id,))
    con.commit()
    con.close()

    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found.")

    return {"message": f"Deleted event ID {event_id}."}


@app.post("/events/{event_id}/verify-location")
def verify_event_location(event_id: int, payload: EventLocationPayload):
    event = get_event_or_404(event_id)
    geo = geofence_check(
        payload.lat,
        payload.lng,
        event["lat"],
        event["lng"],
        event["radius_m"],
        payload.accuracy_m,
        MAX_ALLOWED_ACCURACY_M,
    )
    return {
        "ok": geo.ok,
        "distance_m": round(geo.distance_m, 3),
        "radius_m": round(geo.radius_m, 3),
    }


@app.get("/attendance")
def list_attendance(event_id: int | None = None):
    con = db_connect()
    if event_id is None:
        rows = con.execute(
            """
            SELECT id, event_id, person_name, distance_m, lat, lng, accuracy_m, liveness_label, liveness_score, created_at
            FROM attendance
            ORDER BY datetime(created_at) DESC, id DESC
            """
        ).fetchall()
    else:
        rows = con.execute(
            """
            SELECT id, event_id, person_name, distance_m, lat, lng, accuracy_m, liveness_label, liveness_score, created_at
            FROM attendance
            WHERE event_id = ?
            ORDER BY datetime(created_at) DESC, id DESC
            """,
            (event_id,),
        ).fetchall()
    con.close()
    return [serialize_attendance(row) for row in rows]


@app.post("/attendance/checkin")
async def attendance_checkin(
    file: UploadFile = File(...),
    payload: str = Form(...),
    threshold: float = 0.5,
):
    try:
        parsed_payload = AttendanceCheckinPayload.model_validate_json(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid attendance payload.") from exc

    event = get_event_or_404(parsed_payload.event_id)
    if not bool(event["is_active"]):
        raise HTTPException(status_code=409, detail=f"Event {parsed_payload.event_id} is inactive.")

    data = await file.read()
    rgb = load_rgb_from_bytes(data)

    live = anti_spoof_check(rgb)
    if not liveness_passed(live):
        return {
            "ok": False,
            "stage": "liveness",
            "match": None,
            "message": "Spoof detected.",
            "liveness": live,
        }

    try:
        query_embedding = np.array(get_embedding_from_rgb(rgb))
        best_match, best_distance = find_best_face_match(query_embedding)
    except HTTPException as exc:
        if exc.status_code == 404:
            return {
                "ok": False,
                "stage": "recognize",
                "match": None,
                "message": exc.detail,
                "liveness": live,
            }
        raise

    distance_face = round(best_distance, 4)
    if best_distance > threshold:
        return {
            "ok": False,
            "stage": "recognize",
            "match": None,
            "distance": distance_face,
            "distance_face": distance_face,
            "message": "No match found.",
            "liveness": live,
        }

    geo = geofence_check(
        parsed_payload.lat,
        parsed_payload.lng,
        event["lat"],
        event["lng"],
        event["radius_m"],
        parsed_payload.accuracy_m,
        MAX_ALLOWED_ACCURACY_M,
    )
    geo_payload = {
        "ok": geo.ok,
        "reason": geo.reason,
        "distance_m": round(geo.distance_m, 3),
        "radius_m": round(geo.radius_m, 3),
    }

    if not geo.ok:
        return {
            "ok": False,
            "stage": "geofence",
            "match": best_match,
            "distance": distance_face,
            "distance_face": distance_face,
            "geo": geo_payload,
            "liveness": live,
        }

    created_at = utc_now_iso()
    con = db_connect()
    con.execute(
        """
        INSERT INTO attendance (
            event_id, person_name, distance_m, lat, lng, accuracy_m,
            liveness_label, liveness_score, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            parsed_payload.event_id,
            best_match,
            geo.distance_m,
            parsed_payload.lat,
            parsed_payload.lng,
            parsed_payload.accuracy_m,
            str(live.get("label", "Unknown")),
            float(live.get("score", 0.0)),
            created_at,
        ),
    )
    con.commit()
    con.close()

    return {
        "ok": True,
        "stage": "saved",
        "match": best_match,
        "distance": distance_face,
        "distance_face": distance_face,
        "geo": geo_payload,
        "liveness": live,
        "created_at": created_at,
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
