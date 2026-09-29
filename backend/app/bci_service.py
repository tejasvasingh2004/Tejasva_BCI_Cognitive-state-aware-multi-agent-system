"""NeuroFlow cognitive-state service.

Slim FastAPI sidecar that exposes only the EEG workload classifier (preprocessing, feature
extraction, PCA + SVM) for NeuroFlow's Cognitive Mode. It is consumed by the TypeScript
`BciHttpProvider` (packages/cognitive) via `POST /predict-workload`.

The previous LangGraph/Ollama chat runtime in `app.main` is superseded by the NeuroFlow
Node.js runtime and is not loaded here.
"""

import logging
import pathlib
import sys

from fastapi import FastAPI, HTTPException, status

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from app.core.predictor import predictor  # noqa: E402
from app.schemas import WorkloadPredictRequest, WorkloadPredictResponse  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("bci_service")

app = FastAPI(title="NeuroFlow cognitive-state service", version="1.0.0")


@app.get("/health")
def health():
    loaded = predictor.is_loaded()
    return {"status": "ok" if loaded else "degraded", "classifier_loaded": loaded}


@app.post("/predict-workload", response_model=WorkloadPredictResponse)
def predict_workload(request: WorkloadPredictRequest):
    if not predictor.is_loaded():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Classifier not loaded")
    raw_eeg = request.eeg_data
    ground_truth = None
    if request.simulate:
        raw_eeg, ground_truth = predictor.simulate_eeg_recording(target_class=request.target_class)
    if not raw_eeg:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide eeg_data or set simulate=true")
    try:
        result = predictor.predict_workload(raw_eeg)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return WorkloadPredictResponse(
        workload=result["workload"],
        confidence=result["confidence"],
        processing_time_ms=result["processing_time_ms"],
        ground_truth_class=ground_truth,
    )
