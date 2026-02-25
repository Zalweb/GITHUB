import asyncio
import importlib
import math
import os
import sys
import tempfile
import types

import pytest


class HTTPException(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FastAPI:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def add_middleware(self, *args, **kwargs):
        return None

    def post(self, *args, **kwargs):
        def decorator(fn):
            return fn

        return decorator

    def get(self, *args, **kwargs):
        def decorator(fn):
            return fn

        return decorator

    def delete(self, *args, **kwargs):
        def decorator(fn):
            return fn

        return decorator


class FakeUploadFile:
    def __init__(self, payload: bytes):
        self._payload = payload

    async def read(self):
        return self._payload


class FakeArray(list):
    def __sub__(self, other):
        return FakeArray([a - b for a, b in zip(self, other)])


@pytest.fixture(scope="module")
def app_module():
    fastapi_mod = types.ModuleType("fastapi")
    fastapi_mod.FastAPI = FastAPI
    fastapi_mod.File = lambda *args, **kwargs: None
    fastapi_mod.UploadFile = FakeUploadFile
    fastapi_mod.HTTPException = HTTPException

    cors_mod = types.ModuleType("fastapi.middleware.cors")
    cors_mod.CORSMiddleware = object

    responses_mod = types.ModuleType("fastapi.responses")

    class FileResponse:
        def __init__(self, path):
            self.path = path

    responses_mod.FileResponse = FileResponse

    pil_mod = types.ModuleType("PIL")

    class _Image:
        @staticmethod
        def open(_):
            class _Img:
                def convert(self, *_args, **_kwargs):
                    return self

            return _Img()

    pil_mod.Image = _Image

    np_mod = types.ModuleType("numpy")
    np_mod.array = lambda x: FakeArray(x if isinstance(x, (list, tuple)) else [])

    class _Linalg:
        @staticmethod
        def norm(v):
            return math.sqrt(sum(x * x for x in v))

    np_mod.linalg = _Linalg

    fr_mod = types.ModuleType("face_recognition")
    fr_mod.face_encodings = lambda _img: []

    sys.modules["fastapi"] = fastapi_mod
    sys.modules["fastapi.middleware.cors"] = cors_mod
    sys.modules["fastapi.responses"] = responses_mod
    sys.modules["PIL"] = pil_mod
    sys.modules["numpy"] = np_mod
    sys.modules["face_recognition"] = fr_mod

    module_path = os.path.join(os.path.dirname(__file__), "..", "main.py")
    spec = importlib.util.spec_from_file_location("main", module_path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules["main"] = mod
    spec.loader.exec_module(mod)
    yield mod

    if os.path.exists("faces.db"):
        os.remove("faces.db")


def _setup_temp_db(mod):
    temp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    temp_db.close()
    mod.DB_PATH = temp_db.name
    mod.init_db()
    return temp_db.name


def test_get_embedding_raises_when_no_face(app_module):
    with pytest.raises(HTTPException) as exc:
        app_module.get_embedding_from_bytes(b"unused")

    assert exc.value.status_code == 400
    assert exc.value.detail == "No face detected in image."


def test_register_recognize_list_and_delete_flow(app_module):
    db_path = _setup_temp_db(app_module)

    embeddings = {
        b"alice": [0.1, 0.2, 0.3],
        b"alice_again": [0.1, 0.2, 0.3],
    }
    app_module.get_embedding_from_bytes = lambda payload: embeddings[payload]

    result = asyncio.run(app_module.register("Alice", FakeUploadFile(b"alice")))
    assert "Registered 'Alice' successfully." == result["message"]

    faces = app_module.list_faces()
    assert len(faces) == 1
    assert faces[0]["name"] == "Alice"

    recognition = asyncio.run(
        app_module.recognize(FakeUploadFile(b"alice_again"), threshold=0.5)
    )
    assert recognition["match"] == "Alice"
    assert recognition["distance"] == 0.0

    delete_result = app_module.delete_face(faces[0]["id"])
    assert "Deleted face ID" in delete_result["message"]
    assert app_module.list_faces() == []

    os.remove(db_path)


def test_recognize_handles_empty_db_and_threshold_miss(app_module):
    db_path = _setup_temp_db(app_module)

    app_module.get_embedding_from_bytes = lambda _payload: [0.9, 0.9, 0.9]

    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_module.recognize(FakeUploadFile(b"query")))
    assert exc.value.status_code == 404

    asyncio.run(app_module.register("Bob", FakeUploadFile(b"query")))
    app_module.get_embedding_from_bytes = lambda _payload: [0.0, 0.0, 0.0]
    recognition = asyncio.run(
        app_module.recognize(FakeUploadFile(b"different"), threshold=0.01)
    )
    assert recognition["match"] is None
    assert recognition["message"] == "No match found."

    os.remove(db_path)


def test_frontend_route_returns_file_response(app_module):
    response = app_module.frontend()
    assert getattr(response, "path", None) == "frontend.html"
