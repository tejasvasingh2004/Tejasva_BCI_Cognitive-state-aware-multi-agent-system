import os
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # API Settings
    PROJECT_NAME: str = "Cognitive-State-Aware Adaptive AI Agent System"
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    
    # LLM Settings (Ollama)
    # Inside docker-compose, host.docker.internal allows docker container to reach the host's localhost
    OLLAMA_HOST: str = os.getenv("OLLAMA_HOST", os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"))
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "qwen3:8b")
    OLLAMA_NUM_GPU: int = int(os.getenv("OLLAMA_NUM_GPU", "-1"))
    
    @property
    def OLLAMA_BASE_URL(self) -> str:
        return self.OLLAMA_HOST
        
    # CORS Origins
    CORS_ORIGINS: list[str] = ["*"]
    
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

settings = Settings()
