# app/core/agent_flow.py
"""Adaptive agent flow coordinator using LangGraph.

Configures the routing policy dynamically based on the user's predicted
or overridden cognitive workload state:
- LOW: Planner -> Solver (Research) -> Response (Finalize)
- MEDIUM: Planner -> Solver (Research) -> Verifier -> Response (Finalize)
- HIGH: Planner -> Solver (Research) -> Verifier -> Final Verification -> Response (Finalize)
"""

import logging
from typing import Dict, Any, Literal
from langgraph.graph import StateGraph, END

from app.core.agents import (
    AgentState,
    planner_agent,
    research_agent,
    verifier_agent,
    final_verification_agent,
    summarizer_agent
)
from app.core.workload import WorkloadState

logger = logging.getLogger("app.core.agent_flow")

def route_after_research(state: AgentState) -> Literal["verifier", "finalize"]:
    """Decides if verification is required after research (Solver) completes.

    - LOW workload bypasses verification and goes straight to finalize.
    - MEDIUM and HIGH workload require verification.
    """
    workload = state.get("workload", "")
    if hasattr(workload, "value"):
        workload = workload.value
    workload = str(workload).upper()
    logger.info(f"Routing after Solver: active workload is '{workload}'")
    
    if workload in ("LOW", "NORMAL"):
        logger.info("Routing: Solver -> Finalize (Bypassing verification due to LOW/NORMAL workload)")
        return "finalize"
    
    logger.info("Routing: Solver -> Verifier Agent (Verification required due to MEDIUM/HIGH workload)")
    return "verifier"

def route_after_verifier(state: AgentState) -> Literal["research", "final_verification", "finalize"]:
    """Decides where to route after verification reviews the draft answer.

    - If unsatisfactory and loop limit not reached, loops back to research.
    - If satisfactory or loop limit reached:
        - If workload is HIGH, routes to Final Verification for extra validation.
        - Otherwise, routes straight to finalize.
    """
    policy = state.get("policy", {})
    max_loops = policy.get("verification_loops", 1)
    confidence_threshold = policy.get("confidence_threshold", 80)
    
    current_loops = state.get("loop_count", 0)
    confidence = state.get("confidence_score", 0)
    feedback = state.get("feedback", "")
    
    workload = state.get("workload", "")
    if hasattr(workload, "value"):
        workload = workload.value
    workload = str(workload).upper()
    
    # Check if verification quality criteria are satisfied
    is_satisfactory = (not feedback) and (confidence >= confidence_threshold)
    
    if is_satisfactory or current_loops >= max_loops:
        # Loop finished, decide on Final Verification vs Finalize
        if workload == "HIGH":
            logger.info(f"Routing: Verifier -> Final Verification Agent (Satisfactory: {is_satisfactory}, Loops: {current_loops}/{max_loops})")
            return "final_verification"
        
        logger.info(f"Routing: Verifier -> Finalize (Satisfactory: {is_satisfactory}, Loops: {current_loops}/{max_loops})")
        return "finalize"
    
    # Otherwise, loop back to solver (Research) to apply feedback corrections
    logger.info(f"Routing: Verifier -> Solver (Loop {current_loops + 1}/{max_loops} due to feedback/low confidence: {confidence}%)")
    return "research"

def finalize_node(state: AgentState) -> Dict[str, Any]:
    """Node that finalized the agent output."""
    logger.info("Starting Finalize Node")
    draft = state.get("draft_answer", "")
    final = state.get("final_answer")
    
    if not final:
        final = draft
        
    return {"final_answer": final}

def increment_loop_node(state: AgentState) -> Dict[str, Any]:
    """Increments loop counter when routing back from Verifier to Solver."""
    return {"loop_count": state.get("loop_count", 0) + 1}

def build_workflow() -> StateGraph:
    # Initialize state graph
    workflow = StateGraph(AgentState)
    
    # Add nodes
    workflow.add_node("planner", planner_agent)
    workflow.add_node("research", research_agent)
    workflow.add_node("verifier", verifier_agent)
    workflow.add_node("final_verification", final_verification_agent)
    workflow.add_node("summarizer", summarizer_agent)  # Kept for backward compatibility
    workflow.add_node("increment_loop", increment_loop_node)
    workflow.add_node("finalize", finalize_node)
    
    # Set static entry point
    # All adaptive workflows (LOW, MEDIUM, HIGH) start at the Planner
    workflow.set_entry_point("planner")
    
    # Planner passes the plan directly to the Solver (Research)
    workflow.add_edge("planner", "research")
    
    # Solver (Research) routes conditionally based on workload level
    workflow.add_conditional_edges(
        "research",
        route_after_research,
        {
            "verifier": "verifier",
            "finalize": "finalize"
        }
    )
    
    # Verifier routes conditionally based on verification outcome
    workflow.add_conditional_edges(
        "verifier",
        route_after_verifier,
        {
            "research": "increment_loop",
            "final_verification": "final_verification",
            "finalize": "finalize"
        }
    )
    
    # Loop increment node loops back to Research
    workflow.add_edge("increment_loop", "research")
    
    # Final Verification transitions directly to Finalize
    workflow.add_edge("final_verification", "finalize")
    
    # Summarizer (unused in LOW/MEDIUM/HIGH, kept for legacy support) transitions to Finalize
    workflow.add_edge("summarizer", "finalize")
    
    # Finalize node ends the execution
    workflow.add_edge("finalize", END)
    
    return workflow.compile()

# Compile the workflow graph
agent_graph = build_workflow()
