from fastapi.testclient import TestClient
from app import app


def test_prediction_contract():
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        response = client.post("/predict", json={"text": "This product is amazing"})
        assert response.status_code == 200
        assert response.json()["prediction"] == "positive"
        assert 0 <= response.json()["confidence"] <= 1
        assert response.json()["modelVersion"] == "sentiment-demo-v1"
        assert response.headers["x-request-id"]


def test_invalid_inputs():
    with TestClient(app) as client:
        for body in [{}, {"text": "  "}, {"text": 42}, {"text": "x" * 5001}, {"text": "ok", "extra": 1}]:
            assert client.post("/predict", json=body).status_code == 422
