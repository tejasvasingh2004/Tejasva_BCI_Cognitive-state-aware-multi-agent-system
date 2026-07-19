# tests/test_bci_integration.py
"""Integration tests for the Cognitive-State-Aware BCI Multi-Agent system.

Tests:
1. Workload Prediction REST endpoint (/predict-workload) under raw and simulated modes.
2. Health Check REST endpoint (/health).
3. Chat Adaptive Routing REST endpoint (/chat) under low, medium, and high workload levels.
"""

import sys
import pathlib
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock

# Ensure project root is in python path
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from app.main import app
from app.core.workload import WorkloadState

client = TestClient(app)

def test_health_check_endpoint():
    """Verify that the health check endpoint returns BCI, Ollama, and LangGraph states."""
    with patch("app.main.check_ollama_status") as mock_ollama:
        mock_ollama.return_value = {"running": True, "model_exists": True, "error": ""}
        
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] in ("ok", "degraded")
        assert data["classifier_loaded"] is True
        assert data["current_model"] == "best_model_optimized.joblib"
        assert data["feature_dimension"] == 182
        assert data["ollama_status"] == "ok"
        assert data["langgraph_status"] == "ok"

@patch("app.core.predictor.WorkloadPredictor.predict_workload")
def test_predict_workload_raw(mock_predict):
    """Verify that /predict-workload correctly accepts raw EEG inputs and runs prediction."""
    mock_predict.return_value = {
        "workload": "MEDIUM",
        "confidence": 0.72,
        "processing_time_ms": 15.4
    }
    
    # Input mockup representing 14 channels and 10 samples (will be padded automatically to 1280)
    mock_raw_eeg = [[0.0] * 10 for _ in range(14)]
    
    response = client.post("/predict-workload", json={
        "eeg_data": mock_raw_eeg,
        "simulate": False
    })
    
    assert response.status_code == 200
    data = response.json()
    assert data["workload"] == "MEDIUM"
    assert data["confidence"] == 0.72
    assert data["processing_time_ms"] == 15.4
    assert data["ground_truth_class"] is None

def test_predict_workload_simulation():
    """Verify that /predict-workload correctly handles simulated EEG loading from STEW dataset."""
    response = client.post("/predict-workload", json={
        "simulate": True,
        "target_class": 0
    })
    
    assert response.status_code == 200
    data = response.json()
    assert data["workload"] in ("LOW", "MEDIUM", "HIGH")
    assert 0.0 <= data["confidence"] <= 1.0
    assert data["processing_time_ms"] > 0.0
    assert data["ground_truth_class"] == 0

@patch("app.main.check_ollama_status")
@patch("app.core.agents.get_llm")
def test_scenario_1_low_workload_routing(mock_get_llm, mock_ollama):
    """Scenario 1 Integration: LOW Workload
    
    Routing policy: Planner -> Solver (Research) -> Response (Finalize)
    """
    mock_ollama.return_value = {"running": True, "model_exists": True, "error": ""}
    mock_resp = MagicMock()
    mock_resp.content = "Answer content"
    
    mock_llm = MagicMock()
    mock_llm.invoke.return_value = mock_resp
    mock_get_llm.return_value = mock_llm
    
    response = client.post("/chat", json={
        "question": "What is Python?",
        "workload": "LOW",
        "dev_mode": True
    })
    
    assert response.status_code == 200
    data = response.json()
    assert "answer" in data
    
    metadata = data["metadata"]
    assert metadata["workload"] == "LOW"
    assert metadata["dev_mode"] is True
    # Visited nodes should contain Planner and Research Agents (Solver), but NOT Verifier/Final Verification
    visited = metadata["visited_nodes"]
    assert "Planner Agent" in visited
    assert "Research Agent" in visited
    assert "Verifier Agent" not in visited
    assert "Final Verification Agent" not in visited

@patch("app.main.check_ollama_status")
@patch("app.core.agents.get_llm")
def test_scenario_2_medium_workload_routing(mock_get_llm, mock_ollama):
    """Scenario 2 Integration: MEDIUM Workload
    
    Routing policy: Planner -> Solver (Research) -> Verifier -> Response (Finalize)
    """
    mock_ollama.return_value = {"running": True, "model_exists": True, "error": ""}
    # Verifier mock requires JSON string representation
    resp_planner = MagicMock(content="Planner steps")
    resp_research = MagicMock(content="Initial solution")
    resp_verifier = MagicMock(content='{"confidence_score": 90, "is_correct": true, "feedback": ""}')
    
    mock_llm = MagicMock()
    mock_llm.invoke.side_effect = [resp_planner, resp_research, resp_verifier]
    mock_get_llm.return_value = mock_llm
    
    response = client.post("/chat", json={
        "question": "Write binary search in python.",
        "workload": "MEDIUM",
        "dev_mode": True
    })
    
    assert response.status_code == 200
    data = response.json()
    metadata = data["metadata"]
    assert metadata["workload"] == "MEDIUM"
    
    visited = metadata["visited_nodes"]
    assert "Planner Agent" in visited
    assert "Research Agent" in visited
    assert "Verifier Agent" in visited
    assert "Final Verification Agent" not in visited

@patch("app.main.check_ollama_status")
@patch("app.core.agents.get_llm")
def test_scenario_3_high_workload_routing(mock_get_llm, mock_ollama):
    """Scenario 3 Integration: HIGH Workload
    
    Routing policy: Planner -> Solver (Research) -> Verifier -> Final Verification -> Response (Finalize)
    """
    mock_ollama.return_value = {"running": True, "model_exists": True, "error": ""}
    resp_planner = MagicMock(content="Plan steps")
    resp_research = MagicMock(content="Initial solution draft")
    resp_verifier = MagicMock(content='{"confidence_score": 98, "is_correct": true, "feedback": ""}')
    resp_final_ver = MagicMock(content="Polished final verified response")
    
    mock_llm = MagicMock()
    mock_llm.invoke.side_effect = [resp_planner, resp_research, resp_verifier, resp_final_ver]
    mock_get_llm.return_value = mock_llm
    
    response = client.post("/chat", json={
        "question": "Derive backpropagation gradient descent.",
        "workload": "HIGH",
        "dev_mode": True
    })
    
    assert response.status_code == 200
    data = response.json()
    metadata = data["metadata"]
    assert metadata["workload"] == "HIGH"
    
    visited = metadata["visited_nodes"]
    assert "Planner Agent" in visited
    assert "Research Agent" in visited
    assert "Verifier Agent" in visited
    assert "Final Verification Agent" in visited

@patch("app.main.check_ollama_status")
@patch("app.core.agents.get_llm")
@patch("app.core.predictor.WorkloadPredictor.predict_workload")
def test_automated_bci_mode(mock_predict, mock_get_llm, mock_ollama):
    """Verify that Automated BCI Mode executes workload prediction and routes dynamically."""
    mock_ollama.return_value = {"running": True, "model_exists": True, "error": ""}
    mock_predict.return_value = {
        "workload": "MEDIUM",
        "confidence": 0.81,
        "processing_time_ms": 12.5
    }
    
    resp_planner = MagicMock(content="Plan steps")
    resp_research = MagicMock(content="Solution draft")
    resp_verifier = MagicMock(content='{"confidence_score": 88, "is_correct": true, "feedback": ""}')
    
    mock_llm = MagicMock()
    mock_llm.invoke.side_effect = [resp_planner, resp_research, resp_verifier]
    mock_get_llm.return_value = mock_llm
    
    response = client.post("/chat", json={
        "question": "What is the capital of Singapore?",
        "dev_mode": False
    })
    
    assert response.status_code == 200
    data = response.json()
    metadata = data["metadata"]
    assert metadata["dev_mode"] is False
    assert metadata["predicted_workload"] == "MEDIUM"
    assert metadata["prediction_confidence"] == 0.81
    assert metadata["prediction_time_ms"] == 12.5
    assert metadata["workload"] == "MEDIUM"
    
    visited = metadata["visited_nodes"]
    assert "Planner Agent" in visited
    assert "Research Agent" in visited
    assert "Verifier Agent" in visited
    assert "Final Verification Agent" not in visited
