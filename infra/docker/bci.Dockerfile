# EEG cognitive-state sidecar (Python) used by NeuroFlow Cognitive Mode. Build from repo root.
FROM python:3.11-slim

WORKDIR /workspace
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

RUN pip install "numpy>=1.24" "scipy>=1.10" "scikit-learn>=1.2" "joblib>=1.2" \
    "fastapi>=0.110" "uvicorn>=0.28" "pydantic>=2.6" "pydantic-settings>=2.2"

COPY workload_classifier/ workload_classifier/
COPY backend/app/ backend/app/

WORKDIR /workspace/backend
EXPOSE 8000
CMD ["uvicorn", "app.bci_service:app", "--host", "0.0.0.0", "--port", "8000"]
