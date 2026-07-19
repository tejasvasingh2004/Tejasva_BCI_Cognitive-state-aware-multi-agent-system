# tests/test_flow.py
"""Unit tests for the cognitive adaptive routing policies in LangGraph.

Verifies that the WorkloadManager resolves correct state configs and
that the StateGraph executes the expected sequence of agent nodes.
"""

import pytest
from unittest.mock import MagicMock, patch
from app.core.workload import WorkloadManager, WorkloadState
from app.core.agent_flow import agent_graph

def test_workload_policies():
    """Verifies that the WorkloadManager maps cognitive workloads to correct policies."""
    # LOW policy mapping (replaces legacy NORMAL)
    low_policy = WorkloadManager.get_policy(WorkloadState.LOW)
    assert low_policy.agents_count == 2
    assert low_policy.verification_loops == 0
    assert low_policy.confidence_threshold == 70
    assert "Planner Agent" in low_policy.agents_used
    assert "Research Agent" in low_policy.agents_used
    assert "Verifier Agent" not in low_policy.agents_used
    assert "Final Verification Agent" not in low_policy.agents_used

    # HIGH policy mapping (replaces legacy OVERLOADED)
    high_policy = WorkloadManager.get_policy(WorkloadState.HIGH)
    assert high_policy.agents_count == 4
    assert high_policy.verification_loops == 2
    assert high_policy.confidence_threshold == 95
    assert "Planner Agent" in high_policy.agents_used
    assert "Research Agent" in high_policy.agents_used
    assert "Verifier Agent" in high_policy.agents_used
    assert "Final Verification Agent" in high_policy.agents_used

@patch("app.core.agents.get_llm")
def test_low_flow_execution(mock_get_llm):
    """Verifies that in LOW workload, the Planner and Research Agents run,

    and the Verifier and Final Verification nodes are bypassed.
    """
    mock_response = MagicMock()
    mock_response.content = "Draft response content"
    
    mock_llm_instance = MagicMock()
    mock_llm_instance.invoke.return_value = mock_response
    mock_get_llm.return_value = mock_llm_instance
    
    policy = WorkloadManager.resolve_workload(WorkloadState.LOW)
    initial_state = {
        "question": "What is recursion?",
        "workload": WorkloadState.LOW,
        "policy": policy.model_dump(),
        "plan": None,
        "draft_answer": None,
        "feedback": None,
        "confidence_score": 0,
        "final_answer": None,
        "loop_count": 0,
        "visited_nodes": []
    }
    
    output = agent_graph.invoke(initial_state)
    
    # Assertions
    assert "Planner Agent" in output["visited_nodes"]
    assert "Research Agent" in output["visited_nodes"]
    assert "Verifier Agent" not in output["visited_nodes"]
    assert "Final Verification Agent" not in output["visited_nodes"]
    assert output["loop_count"] == 0

@patch("app.core.agents.get_llm")
def test_high_flow_execution(mock_get_llm):
    """Verifies that in HIGH workload, all four nodes run:

    Planner -> Solver (Research) -> Verifier -> Final Verification -> Response.
    """
    resp_planner = MagicMock(content="1. Step one\n2. Step two")
    resp_research = MagicMock(content="Initial solution draft")
    resp_verifier = MagicMock(content='{"confidence_score": 98, "is_correct": true, "feedback": ""}')
    resp_final_ver = MagicMock(content="Final audited response text")
    
    mock_llm_instance = MagicMock()
    mock_llm_instance.invoke.side_effect = [resp_planner, resp_research, resp_verifier, resp_final_ver]
    mock_get_llm.return_value = mock_llm_instance
    
    policy = WorkloadManager.resolve_workload(WorkloadState.HIGH)
    initial_state = {
        "question": "Explain recursion.",
        "workload": WorkloadState.HIGH,
        "policy": policy.model_dump(),
        "plan": None,
        "draft_answer": None,
        "feedback": None,
        "confidence_score": 0,
        "final_answer": None,
        "loop_count": 0,
        "visited_nodes": []
    }
    
    output = agent_graph.invoke(initial_state)
    
    assert "Planner Agent" in output["visited_nodes"]
    assert "Research Agent" in output["visited_nodes"]
    assert "Verifier Agent" in output["visited_nodes"]
    assert "Final Verification Agent" in output["visited_nodes"]
    assert output["loop_count"] == 0
    assert output["final_answer"] == "Final audited response text"

@patch("app.core.agents.get_llm")
def test_verification_looping_flow(mock_get_llm):
    """Verifies that the verifier can trigger a loop if confidence is below threshold,

    and moves forward once threshold is met or max loops are exhausted.
    """
    # MEDIUM workload allows 1 loop, threshold 80%
    # Mock sequence:
    # 1. Planner Agent (plan)
    # 2. Research Agent (initial draft)
    # 3. Verifier Agent (failing, confidence 50%)
    # 4. Research Agent (revised draft)
    # 5. Verifier Agent (passing, confidence 90%)
    mock_responses = []
    
    planner = MagicMock(content="Plan steps")
    mock_responses.append(planner)
    
    research_1 = MagicMock(content="Draft 1: Recursion is cool.")
    mock_responses.append(research_1)
    
    verifier_1 = MagicMock(content='{"confidence_score": 50, "is_correct": false, "feedback": "Add more detail."}')
    mock_responses.append(verifier_1)
    
    research_2 = MagicMock(content="Draft 2: Detailed definition.")
    mock_responses.append(research_2)
    
    verifier_2 = MagicMock(content='{"confidence_score": 90, "is_correct": true, "feedback": ""}')
    mock_responses.append(verifier_2)
    
    mock_llm_instance = MagicMock()
    mock_llm_instance.invoke.side_effect = mock_responses
    mock_get_llm.return_value = mock_llm_instance
    
    policy = WorkloadManager.resolve_workload(WorkloadState.MEDIUM)
    initial_state = {
        "question": "What is recursion?",
        "workload": WorkloadState.MEDIUM,
        "policy": policy.model_dump(),
        "plan": None,
        "draft_answer": None,
        "feedback": None,
        "confidence_score": 0,
        "final_answer": None,
        "loop_count": 0,
        "visited_nodes": []
    }
    
    output = agent_graph.invoke(initial_state)
    
    visited = output["visited_nodes"]
    assert "Planner Agent" in visited
    assert visited.count("Research Agent") == 2
    assert visited.count("Verifier Agent") == 2
    assert output["loop_count"] == 1
    assert output["final_answer"] == "Draft 2: Detailed definition."
