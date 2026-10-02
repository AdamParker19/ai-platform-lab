"""Tiny training fixture for serving practice, not a useful sentiment model."""
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline

MODEL_VERSION = "sentiment-demo-v1"


def load_model():
    samples = [
        "This product is amazing", "I love this", "Excellent quality",
        "Great experience", "Really happy with this", "Fantastic service",
        "This product is terrible", "I hate this", "Awful quality",
        "Bad experience", "Really disappointed with this", "Horrible service",
    ]
    labels = ["positive"] * 6 + ["negative"] * 6
    model = make_pipeline(TfidfVectorizer(), LogisticRegression(random_state=42))
    model.fit(samples, labels)
    return model


def predict(model, text: str) -> dict:
    probabilities = model.predict_proba([text])[0]
    index = int(probabilities.argmax())
    return {
        "prediction": str(model.classes_[index]),
        "confidence": float(probabilities[index]),
        "modelVersion": MODEL_VERSION,
    }
