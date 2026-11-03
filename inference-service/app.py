import asyncio
import json
import logging
from contextlib import asynccontextmanager
from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from model import load_model, predict
from genai import GenAIProvider, GeneratedText, MockGenAIProvider

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("inference")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load the pre-trained artifact once; startup fails if it is missing or incompatible.
    app.state.model = load_model()
    app.state.genai_provider = MockGenAIProvider()  # Offline default; never contacts AWS.
    yield
    del app.state.genai_provider
    del app.state.model


app = FastAPI(title="AI Platform Lab Inference", lifespan=lifespan)


class PredictionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    text: str = Field(min_length=1, max_length=5000)


class PredictionResponse(BaseModel):
    prediction: str
    confidence: float = Field(ge=0, le=1)
    modelVersion: str


class GenerationRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    prompt: str = Field(min_length=1, max_length=2000)


class GenerationResponse(BaseModel):
    text: str
    modelVersion: str
    requestId: str
    latencyMs: float = Field(ge=0)


def generation_error(status: int, code: str, message: str, request_id: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={
        "error": {"code": code, "message": message}, "requestId": request_id,
    })


@app.middleware("http")
async def request_logging(request: Request, call_next):
    candidate = request.headers.get("x-request-id", "")
    request_id = candidate if 0 < len(candidate) <= 64 and candidate.isascii() and candidate.isalnum() else uuid4().hex
    request.state.request_id = request_id
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
@app.api_route("/ping", methods=["GET", "POST"], include_in_schema=False)
def health(request: Request):
    return {"status": "ok", "modelVersion": request.app.state.model.metadata["modelVersion"]}


@app.post("/predict", response_model=PredictionResponse)
@app.post("/invocations", response_model=PredictionResponse, include_in_schema=False)
def prediction(body: PredictionRequest, request: Request):
    return predict(request.app.state.model, body.text)

# This endpoint is intentionally separate from the existing sentiment /predict.
@app.post("/generate", response_model=GenerationResponse)
async def generate_text(body: GenerationRequest, request: Request):
    request_id = request.state.request_id
    provider: GenAIProvider = request.app.state.genai_provider
    # Kept shorter than the gateway's 3-second default timeout.
    timeout_s = 2.0
    start = perf_counter()
    try:
        output = await asyncio.wait_for(
            provider.generate(body.prompt, request_id=request_id),
            timeout=timeout_s,
        )
    except TimeoutError:
        return generation_error(504, "PROVIDER_TIMEOUT", "Generation timed out", request_id)
    except Exception as exc:
        # Do not log the prompt or reveal provider internals to the client.
        logger.error("GenAI provider failure: %s", type(exc).__name__)
        return generation_error(502, "PROVIDER_UNAVAILABLE", "Generation unavailable", request_id)

    if (not isinstance(output, GeneratedText) or not isinstance(output.text, str)
            or not output.text.strip() or not isinstance(output.model_version, str)
            or not output.model_version.strip()):
        return generation_error(502, "INVALID_PROVIDER_RESPONSE", "Invalid generation response", request_id)
    return GenerationResponse(
        text=output.text,
        modelVersion=output.model_version,
        requestId=request_id,
        latencyMs=round((perf_counter() - start) * 1000, 2),
    )
