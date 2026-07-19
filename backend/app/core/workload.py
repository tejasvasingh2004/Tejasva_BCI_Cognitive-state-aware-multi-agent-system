# app/core/workload.py
"""Cognitive workload state definitions and adaptive policies.

Defines the mapping between the predicted EEG workload level (LOW, MEDIUM, HIGH)
and the specific LangGraph routing configuration, including verification loops,
confidence thresholds, response detail levels, and active agents.
"""

from enum import Enum
from pydantic import BaseModel
from typing import Optional, Dict, Any, List

class WorkloadState(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    # Keep legacy states for backward compatibility with frontend select options
    NORMAL = "NORMAL"
    MODERATE = "MODERATE"
    OVERLOADED = "OVERLOADED"

class AdaptivePolicy(BaseModel):
    state: WorkloadState
    agents_count: int
    verification_loops: int
    confidence_threshold: int  # percentage (e.g. 70, 80, 95)
    detail_level: str
    agents_used: List[str]

# Define BCI research-grade routing policies
POLICIES: Dict[WorkloadState, AdaptivePolicy] = {
    WorkloadState.LOW: AdaptivePolicy(
        state=WorkloadState.LOW,
        agents_count=2,
        verification_loops=0,
        confidence_threshold=70,
        detail_level="Verbose detailed explanation",
        agents_used=["Planner Agent", "Research Agent"]
    ),
    WorkloadState.MEDIUM: AdaptivePolicy(
        state=WorkloadState.MEDIUM,
        agents_count=3,
        verification_loops=1,
        confidence_threshold=80,
        detail_level="Balanced explanation",
        agents_used=["Planner Agent", "Research Agent", "Verifier Agent"]
    ),
    WorkloadState.HIGH: AdaptivePolicy(
        state=WorkloadState.HIGH,
        agents_count=4,
        verification_loops=2,
        confidence_threshold=95,
        detail_level="Bullet points only",
        agents_used=["Planner Agent", "Research Agent", "Verifier Agent", "Final Verification Agent"]
    ),
    # Map legacy states to new policies for clean fallback
    WorkloadState.NORMAL: AdaptivePolicy(
        state=WorkloadState.LOW,
        agents_count=2,
        verification_loops=0,
        confidence_threshold=70,
        detail_level="Verbose detailed explanation",
        agents_used=["Planner Agent", "Research Agent"]
    ),
    WorkloadState.MODERATE: AdaptivePolicy(
        state=WorkloadState.MEDIUM,
        agents_count=3,
        verification_loops=1,
        confidence_threshold=80,
        detail_level="Balanced explanation",
        agents_used=["Planner Agent", "Research Agent", "Verifier Agent"]
    ),
    WorkloadState.OVERLOADED: AdaptivePolicy(
        state=WorkloadState.HIGH,
        agents_count=4,
        verification_loops=2,
        confidence_threshold=95,
        detail_level="Bullet points only",
        agents_used=["Planner Agent", "Research Agent", "Verifier Agent", "Final Verification Agent"]
    )
}

class WorkloadManager:
    """Manages adaptive policy retrieval based on resolved workload states."""
    
    @staticmethod
    def get_policy(state: WorkloadState) -> AdaptivePolicy:
        """Retrieves the adaptive routing policy for a given workload state."""
        # Clean mapping to enum
        if isinstance(state, str):
            try:
                state = WorkloadState(state.upper())
            except ValueError:
                state = WorkloadState.LOW
                
        return POLICIES.get(state, POLICIES[WorkloadState.LOW])
    
    @classmethod
    def resolve_workload(
        cls, 
        manual_state: Optional[WorkloadState] = None, 
        predicted_state: Optional[str] = None
    ) -> AdaptivePolicy:
        """Resolves the workload state into a concrete AdaptivePolicy.

        If a predicted_state is provided, it takes precedence (automated mode),
        otherwise it falls back to the manual override state.
        """
        resolved = predicted_state or manual_state or WorkloadState.LOW
        return cls.get_policy(resolved)
