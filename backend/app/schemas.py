# app/schemas.py
"""Pydantic schemas for the FastAPI backend.

Defines schemas for chat endpoints, workload prediction endpoints,
and detailed health monitoring reports.
"""

from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from app.core.workload import WorkloadState

class ChatRequest(BaseModel):
    question: str = Field(..., description="The user query or prompt.")
    workload: Optional[WorkloadState] = Field(default=WorkloadState.LOW, description="The manual workload state for override/debug.")
    eeg_data: Optional[List[List[float]]] = Field(default=None, description="Optional raw EEG recording (14 channels, 1280 samples) for inference.")
    dev_mode: bool = Field(default=False, description="Developer override mode. If true, uses manual workload state; if false, uses predicted workload.")

class ChatMetadata(BaseModel):
    workload: WorkloadState = Field(..., description="The workload state mapped to this execution.")
    dev_mode: bool = Field(..., description="Whether manual override was enabled during execution.")
    predicted_workload: Optional[str] = Field(None, description="The workload state predicted by the EEG classifier.")
    prediction_confidence: Optional[float] = Field(None, description="Confidence score of the EEG workload prediction.")
    prediction_time_ms: Optional[float] = Field(None, description="Time taken to preprocess and classify the EEG signals.")
    agents_used: int = Field(..., description="Number of agents used during execution.")
    verification_loops: int = Field(..., description="Number of loops actually run by the verifier.")
    confidence_threshold: int = Field(..., description="The confidence threshold set by the policy (percentage).")
    detail_level: str = Field(..., description="The level of detail requested for the final answer.")
    visited_nodes: List[str] = Field(default_factory=list, description="The sequence of agents that were executed.")
    confidence_score: Optional[int] = Field(None, description="The final confidence score returned by the verifier.")

class ChatResponse(BaseModel):
    answer: str = Field(..., description="The generated adaptive response content.")
    metadata: ChatMetadata = Field(..., description="Execution metadata for visualization.")

class WorkloadPredictRequest(BaseModel):
    eeg_data: Optional[List[List[float]]] = Field(default=None, description="Raw EEG data to predict (14 channels, 1280 samples).")
    simulate: bool = Field(default=False, description="If true, ignores eeg_data and simulates a recording from the STEW dataset.")
    target_class: Optional[int] = Field(default=None, description="If simulating, specifies ground truth class: 0 (Normal/Low), 1 (Moderate/Medium), 2 (High/High).")

class WorkloadPredictResponse(BaseModel):
    workload: str = Field(..., description="Predicted workload level (LOW, MEDIUM, HIGH).")
    confidence: float = Field(..., description="Confidence score of prediction (0.0 to 1.0).")
    processing_time_ms: float = Field(..., description="BCI pipeline processing time in milliseconds.")
    ground_truth_class: Optional[int] = Field(None, description="Original workload class from dataset (for debugging/verification).")

class HealthResponse(BaseModel):
    status: str = Field(..., description="Overall backend status.")
    classifier_loaded: bool = Field(..., description="Whether the BCI classifier is active.")
    current_model: str = Field(..., description="Filename of the active workload classifier.")
    feature_dimension: int = Field(..., description="Number of extracted EEG features.")
    last_inference_latency_ms: Optional[float] = Field(None, description="Latency of the last EEG inference.")
    ollama_status: str = Field(..., description="Ollama local status (ok / error).")
    ollama_model: str = Field(..., description="Configured Ollama LLM model name.")
    langgraph_status: str = Field(..., description="LangGraph compiler verification (ok / error).")
