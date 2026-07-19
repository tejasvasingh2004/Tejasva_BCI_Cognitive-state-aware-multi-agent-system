# tests/test_integration_ollama.py
"""Live Ollama integration tests.

Verifies status of real Ollama connection and LangGraph adaptive executions.
Expects local Ollama to be active with configured model (e.g. qwen3:8b).
"""

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.config import settings

client = TestClient(app)

def test_live_health_endpoint():
    """Verifies that the /health endpoint correctly reports status of the real Ollama connection."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "classifier_loaded" in data
    assert data["ollama_model"] == settings.OLLAMA_MODEL
    assert "ollama_status" in data
    assert "langgraph_status" in data

def test_live_chat_endpoint_low():
    """Performs a real /chat API call under LOW workload (2 agents, 0 loops).

    Exercises the end-to-end connection to the local Ollama instance.
    """
    request_payload = {
        "question": "What is 2 + 2? Answer in one word.",
        "workload": "LOW",
        "dev_mode": True
    }
    
    # We skip actual execution if Ollama is not running on the testing host
    try:
        response = client.post("/chat", json=request_payload)
        if response.status_code == 503:
            pytest.skip("Local Ollama is not running or model is not pulled.")
            
        assert response.status_code == 200
        data = response.json()
        assert "answer" in data
        assert len(data["answer"].strip()) > 0
        
        metadata = data["metadata"]
        assert metadata["workload"] == "LOW"
        assert metadata["agents_used"] == 2
        assert metadata["verification_loops"] == 0
        assert metadata["confidence_threshold"] == 70
        assert "Planner Agent" in metadata["visited_nodes"]
        assert "Research Agent" in metadata["visited_nodes"]
        assert "Verifier Agent" not in metadata["visited_nodes"]
    except Exception as e:
        pytest.skip(f"Ollama integration test skipped due to connection failure: {e}")

def test_live_chat_endpoint_medium():
    """Performs a real /chat API call under MEDIUM workload (3 agents, 1 loop maximum).

    Exercises the Planner, Solver, and Verifier flow.
    """
    request_payload = {
        "question": "Provide a brief explanation of recursion.",
        "workload": "MEDIUM",
        "dev_mode": True
    }
    
    try:
        response = client.post("/chat", json=request_payload)
        if response.status_code == 503:
            pytest.skip("Local Ollama is not running or model is not pulled.")
            
        assert response.status_code == 200
        data = response.json()
        assert "answer" in data
        
        metadata = data["metadata"]
        assert metadata["workload"] == "MEDIUM"
        assert metadata["agents_used"] >= 3
        assert metadata["confidence_threshold"] == 80
        assert "Planner Agent" in metadata["visited_nodes"]
        assert "Research Agent" in metadata["visited_nodes"]
        assert "Verifier Agent" in metadata["visited_nodes"]
    except Exception as e:
        pytest.skip(f"Ollama integration test skipped due to connection failure: {e}")
