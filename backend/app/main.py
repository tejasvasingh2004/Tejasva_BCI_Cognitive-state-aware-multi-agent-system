# app/main.py
"""Main FastAPI application entry point.

Integrates the optimized EEG workload classifier, LangGraph adaptive agent flow,
REST endpoints for real-time workload prediction, structured research-grade logging,
and service health checks.
"""

import logging
import time
import sys
import pathlib
from datetime import datetime
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Ensure project root (d:/Document/bci) is in python path for local imports
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

# Load environmental variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("app.main")

from app.config import settings
from app.schemas import (
    ChatRequest, ChatResponse, ChatMetadata,
    WorkloadPredictRequest, WorkloadPredictResponse, HealthResponse
)
from app.core.workload import WorkloadManager, WorkloadState
from app.core.agent_flow import agent_graph
from app.core.llm import check_ollama_status
from app.core.predictor import predictor

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="Cognitive-State-Aware Adaptive Multi-Agent BCI System Backend API.",
    version="1.0.0"
)

# CORS setup to allow frontend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Keep track of last inference latency for health metrics
_last_inference_latency_ms = None

@app.get("/health", response_model=HealthResponse)
def health_check():
    """Service health check endpoint.

    Verifies backend status, BCI classifier loading state, Ollama local model
    responsiveness, and LangGraph flow compilation status.
    """
    # 1. Check Ollama status
    ollama_status_dict = check_ollama_status()
    ollama_ok = "ok" if (ollama_status_dict["running"] and ollama_status_dict["model_exists"]) else "error"
    
    # 2. Check LangGraph status
    langgraph_ok = "ok" if agent_graph is not None else "error"
    
    # 3. Check BCI Classifier status
    classifier_loaded = predictor.is_loaded()
    
    return HealthResponse(
        status="ok" if (ollama_ok == "ok" and langgraph_ok == "ok" and classifier_loaded) else "degraded",
        classifier_loaded=classifier_loaded,
        current_model="best_model_optimized.joblib" if classifier_loaded else "none",
        feature_dimension=182 if classifier_loaded else 0,
        last_inference_latency_ms=_last_inference_latency_ms,
        ollama_status=ollama_ok,
        ollama_model=settings.OLLAMA_MODEL,
        langgraph_status=langgraph_ok
    )

@app.post("/predict-workload", response_model=WorkloadPredictResponse)
async def predict_workload_endpoint(request: WorkloadPredictRequest):
    """BCI prediction endpoint.

    Runs raw EEG signals through BCI preprocessing, feature extraction,
    feature optimization (PCA or selection), and RBF SVM classification.
    Supports real-time simulation using randomly sliced epochs from the STEW dataset.
    """
    global _last_inference_latency_ms
    try:
        raw_eeg = request.eeg_data
        ground_truth_class = None
        
        # 1. Handle EEG simulation if requested
        if request.simulate:
            logger.info("Simulation mode requested. Loading segment from STEW raw data...")
            raw_eeg, ground_truth_class = predictor.simulate_eeg_recording(
                target_class=request.target_class
            )
            logger.info(f"Loaded simulated recording. Ground truth class: {ground_truth_class}")
            
        # 2. Validate input
        if not raw_eeg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Either eeg_data must be provided or simulate must be set to true."
            )
            
        # 3. Run workload prediction pipeline
        pred_res = predictor.predict_workload(raw_eeg)
        
        # Update last inference latency tracking
        _last_inference_latency_ms = pred_res["processing_time_ms"]
        
        return WorkloadPredictResponse(
            workload=pred_res["workload"],
            confidence=pred_res["confidence"],
            processing_time_ms=pred_res["processing_time_ms"],
            ground_truth_class=ground_truth_class
        )
        
    except ValueError as ve:
        logger.error(f"Inference input validation error: {ve}")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Inference input validation failed: {str(ve)}"
        )
    except Exception as e:
        logger.exception("Error during workload prediction")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"BCI inference pipeline failure: {str(e)}"
        )

@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    """Main Chat API that resolves workload policy and executes the adaptive LangGraph agent.

    Routes:
    - LOW: Planner -> Solver (Research) -> Response
    - MEDIUM: Planner -> Solver (Research) -> Verifier -> Response
    - HIGH: Planner -> Solver (Research) -> Verifier -> Final Verification -> Response
    """
    start_time = time.time()
    
    # 1. Check Ollama connectivity first to fail fast
    ollama_status_dict = check_ollama_status()
    if not ollama_status_dict["running"]:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Ollama is not running. Please start Ollama locally. Error: {ollama_status_dict['error']}"
        )
    if not ollama_status_dict["model_exists"]:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Ollama model '{settings.OLLAMA_MODEL}' was not found. Please run 'ollama pull {settings.OLLAMA_MODEL}' first."
        )
        
    try:
        resolved_workload = None
        predicted_workload = None
        prediction_confidence = None
        prediction_time_ms = None
        
        # 2. Resolve workload based on mode
        if request.dev_mode:
            # Manual Developer Mode Override
            resolved_workload = request.workload or WorkloadState.LOW
            logger.info(f"[DEV OVERRIDE] Manual workload selected: {resolved_workload}")
        else:
            # Automated BCI Inference Mode
            logger.info("[BCI AUTOMATION] Running workload classifier to resolve routing...")
            eeg_data = request.eeg_data
            ground_truth = None
            
            # If no raw EEG is supplied in request body, automatically simulate a random segment
            if not eeg_data:
                logger.info("No raw EEG sent in request. Simulating automatic real-time EEG stream...")
                eeg_data, ground_truth = predictor.simulate_eeg_recording()
                
            pred_res = predictor.predict_workload(eeg_data)
            predicted_workload = pred_res["workload"]
            prediction_confidence = pred_res["confidence"]
            prediction_time_ms = pred_res["processing_time_ms"]
            
            resolved_workload = WorkloadState(predicted_workload)
            logger.info(f"[BCI AUTOMATION] Predicted workload state: {predicted_workload} (Conf: {prediction_confidence:.2f}, Time: {prediction_time_ms:.1f}ms, Sim GT: {ground_truth})")
            
        # 3. Resolve adaptive policy matching the workload state
        policy = WorkloadManager.resolve_workload(
            manual_state=resolved_workload if request.dev_mode else None,
            predicted_state=predicted_workload if not request.dev_mode else None
        )
        logger.info(f"Resolved adaptive routing policy: {policy}")
        
        # 4. Prepare initial state for LangGraph
        initial_state = {
            "question": request.question,
            "workload": resolved_workload.value,
            "policy": policy.model_dump(),
            "plan": None,
            "draft_answer": None,
            "feedback": None,
            "confidence_score": 0,
            "final_answer": None,
            "loop_count": 0,
            "visited_nodes": []
        }
        
        # 5. Execute LangGraph workflow
        output_state = agent_graph.invoke(initial_state)
        
        # Calculate execution latency
        end_time = time.time()
        elapsed_seconds = end_time - start_time
        elapsed_ms = elapsed_seconds * 1000.0
        
        visited = output_state.get("visited_nodes", [])
        
        # 6. Extract verification confidence score
        has_verifier = "Verifier Agent" in visited or "Final Verification Agent" in visited
        verifier_score = output_state.get("confidence_score") if has_verifier else None
        
        # Determine number of distinct agents used based on visited nodes
        unique_agents = set([node for node in visited if "Agent" in node])
        agents_used_count = len(unique_agents) if unique_agents else policy.agents_count
        
        # 7. Research-grade Structured Inference Logging
        timestamp_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print("=" * 80)
        print("                 BCI ADAPTIVE SYSTEM INFERENCE TRANSACTION LOG")
        print("=" * 80)
        print(f"  Timestamp             : {timestamp_str}")
        print(f"  Question              : '{request.question}'")
        print(f"  Execution Mode        : {'MANUAL OVERRIDE (Dev Mode)' if request.dev_mode else 'AUTOMATED BCI CLASSIFICATION'}")
        print(f"  Predicted Workload    : {predicted_workload or 'N/A'}")
        print(f"  Prediction Confidence : {f'{prediction_confidence * 100:.1f}%' if prediction_confidence else 'N/A'}")
        print(f"  BCI Pipeline Latency  : {f'{prediction_time_ms:.2f} ms' if prediction_time_ms else 'N/A'}")
        print(f"  Active Workload State : {resolved_workload.value}")
        print(f"  Activated Agents      : {' -> '.join(visited)}")
        print(f"  Verification Loops    : {output_state.get('loop_count', 0)}")
        print(f"  LLM Verifier Score    : {f'{verifier_score}%' if verifier_score else 'N/A'}")
        print(f"  Total Response Time   : {elapsed_seconds:.3f} seconds")
        print("=" * 80)
        
        metadata = ChatMetadata(
            workload=resolved_workload,
            dev_mode=request.dev_mode,
            predicted_workload=predicted_workload,
            prediction_confidence=prediction_confidence,
            prediction_time_ms=prediction_time_ms,
            agents_used=agents_used_count,
            verification_loops=output_state.get("loop_count", 0),
            confidence_threshold=policy.confidence_threshold,
            detail_level=policy.detail_level,
            visited_nodes=visited,
            confidence_score=verifier_score
        )
        
        return ChatResponse(
            answer=output_state.get("final_answer", "Error: No answer was produced by the agent system."),
            metadata=metadata
        )
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.exception("Error executing adaptive agent workflow")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Adaptive agent pipeline error: {str(e)}"
        )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=True)
