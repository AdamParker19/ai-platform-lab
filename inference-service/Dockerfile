FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Train at image build time from the vendored, checksummed dataset.
# Both stages inherit identical Python packages; runtime never retrains.
FROM base AS training
COPY dataset.py train.py ./
COPY data/ ./data/
ARG MODEL_VERSION=sentiment-uci-amazon-v1
RUN python train.py --output /trained --version "$MODEL_VERSION"

FROM base AS runtime
RUN useradd --create-home appuser
COPY app.py model.py ./
COPY --from=training --chown=appuser:appuser /trained/ ./artifacts/
USER appuser
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
