import sqlite3
import json
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import face_recognition
import io

app = FastAPI(
    title="CMPJ FACE API",
    description="Facial recognition backend by Carlsam Jr.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "faces.db"

def init_db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS faces (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            name    TEXT NOT NULL,
            embedding TEXT NOT NULL
        )
    """)
    con.commit()
    con.close()

init_db()

def get_embedding_from_bytes(data: bytes) -> list:
    image = Image.open(io.BytesIO(data)).convert("RGB")
    img_array = np.array(image)
    encodings = face_recognition.face_encodings(img_array)
    if not encodings:
        raise HTTPException(status_code=400, detail="No face detected in image.")
    return encodings[0].tolist()

@app.post("/register")
async def register(name: str, file: UploadFile = File(...)):
    """Register a new person. Send name + face image."""
    data = await file.read()
    embedding = get_embedding_from_bytes(data)

    con = sqlite3.connect(DB_PATH)
    con.execute("INSERT INTO faces (name, embedding) VALUES (?, ?)",
                (name, json.dumps(embedding)))
    con.commit()
    con.close()

    return {"message": f"Registered '{name}' successfully."}

@app.post("/recognize")
async def recognize(file: UploadFile = File(...), threshold: float = 0.5):
    """Send a face image, get back who it is."""
    data = await file.read()
    query_embedding = np.array(get_embedding_from_bytes(data))

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
        return {"match": None, "confidence": round(1 - best_distance, 4), "message": "No match found."}

    return {
        "match": best_match,
        "confidence": round(1 - best_distance, 4),
        "distance": round(best_distance, 4),
    }

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