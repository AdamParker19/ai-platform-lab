import json
import logging
from contextlib import asynccontextmanager
from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, Request
from pydantic import BaseModel, ConfigDict, Field
from model import MODEL_VERSION, load_model, predict

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("inference")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load once per process. Later we will load a versioned artifact from storage.
    app.state.model = load_model()
    yield
    del app.state.model


app = FastAPI(title="AI Platform Lab Inference", lifespan=lifespan)


class PredictionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    text: str = Field(min_length=1, max_length=5000)


class PredictionResponse(BaseModel):
    prediction: str
    confidence: float = Field(ge=0, le=1)
    modelVersion: str


@app.middleware("http")
async def request_logging(request: Request, call_next):
    candidate = request.headers.get("x-request-id", "")
    request_id = candidate if 0 < len(candidate) <= 64 and candidate.isascii() and candidate.isalnum() else uuid4().hex
    start = perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        response.headers["x-request-id"] = request_id
        return response
    finally:
        logger.info(json.dumps({"service": "inference", "requestId": request_id,
                                "method": request.method, "path": request.url.path,
                                "status": status, "latencyMs": round((perf_counter() - start) * 1000, 2)}))


@app.get("/health")
def health():
    return {"status": "ok", "modelVersion": MODEL_VERSION}


@app.post("/predict", response_model=PredictionResponse)
def prediction(body: PredictionRequest, request: Request):
    return predict(request.app.state.model, body.text)
