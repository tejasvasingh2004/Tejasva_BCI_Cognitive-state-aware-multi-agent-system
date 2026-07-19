import logging
import httpx
from langchain_ollama import ChatOllama
from app.config import settings

logger = logging.getLogger("app.core.llm")

# Global shared LLM instance - initialized once at application startup
_shared_llm: ChatOllama = None
_llm_initialization_count = 0

def get_llm(temperature: float = 0.2) -> ChatOllama:
    """
    Returns the shared ChatOllama instance configured with
    base URL, model name, and GPU usage configurations from settings.
    
    The model is initialized once at application startup and reused across
    all agent calls to prevent memory exhaustion from multiple model loads.
    """
    global _shared_llm, _llm_initialization_count
    
    if _shared_llm is None:
        _llm_initialization_count += 1
        logger.info(f"[INIT #{_llm_initialization_count}] Initializing shared ChatOllama with base_url={settings.OLLAMA_HOST}, model={settings.OLLAMA_MODEL}, num_gpu={settings.OLLAMA_NUM_GPU}")
        
        kwargs = {
            "base_url": settings.OLLAMA_HOST,
            "model": settings.OLLAMA_MODEL,
            "temperature": temperature,
        }
        
        if settings.OLLAMA_NUM_GPU >= 0:
            # Pass num_gpu directly to langchain_ollama options
            kwargs["num_gpu"] = settings.OLLAMA_NUM_GPU
            
        _shared_llm = ChatOllama(**kwargs)
        logger.info(f"[INIT #{_llm_initialization_count}] Shared ChatOllama instance created successfully")
    else:
        logger.debug(f"Reusing existing shared ChatOllama instance (initialized #{_llm_initialization_count} time(s))")
    
    # Update temperature if different (ChatOllama supports runtime parameter override)
    if _shared_llm.temperature != temperature:
        _shared_llm.temperature = temperature
        logger.debug(f"Updated shared LLM temperature to {temperature}")
    
    return _shared_llm

def check_ollama_status() -> dict:
    """
    Checks if Ollama is running and if the configured model is available.
    Returns a status dict: {"running": bool, "model_exists": bool, "error": str}
    """
    host = settings.OLLAMA_HOST.rstrip('/')
    model = settings.OLLAMA_MODEL
    
    try:
        # Check if Ollama is running
        with httpx.Client(timeout=3.0) as client:
            response = client.get(f"{host}/api/tags")
            if response.status_code != 200:
                return {
                    "running": False,
                    "model_exists": False,
                    "error": f"Ollama returned non-200 status code: {response.status_code}"
                }
            
            # Parse models list
            data = response.json()
            models = [m.get("name") for m in data.get("models", [])]
            
            # Ollama model names might contain tag, e.g., 'qwen3:8b' or 'qwen3:latest' or 'qwen3:8b-instruct'
            model_exists = False
            for m in models:
                if m == model or m.startswith(model + ":") or model.startswith(m + ":"):
                    model_exists = True
                    break
            
            if not model_exists:
                return {
                    "running": True,
                    "model_exists": False,
                    "error": f"Model '{model}' not found in local Ollama instance. Available models: {', '.join(models)}"
                }
                
            return {
                "running": True,
                "model_exists": True,
                "error": ""
            }
            
    except httpx.RequestError as e:
        return {
            "running": False,
            "model_exists": False,
            "error": f"Could not connect to Ollama at {host}. Error: {str(e)}"
        }
