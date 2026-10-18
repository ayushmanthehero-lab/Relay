from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')
    demo_mode: bool = True
    app_secret: str = 'agent-memory-local-synthetic-demo'
    falkordb_host: str = '127.0.0.1'
    falkordb_port: int = 6381
    falkordb_password: str | None = None
    model_provider: str = 'demo'
    model_name: str = ''
    model_base_url: str = ''
    model_api_key: str = ''
    model_timeout: float = 90
    codex_command: str = 'codex'
    auth_tokens_json: str = '{}'
    support_worker_enabled: bool = True
    support_worker_concurrency: int = Field(default=3, ge=1, le=8)
    support_worker_interval: float = Field(default=2.0, ge=.1, le=60)
    support_max_attempts: int = Field(default=3, ge=1, le=10)
    graphiti_enabled: bool = True
    graphiti_max_coroutines: int = Field(default=2, ge=1, le=8)
    graphiti_max_attempts: int = Field(default=3, ge=1, le=10)
    embedding_backend: str = 'local'
    embedding_model: str = 'BAAI/bge-small-en-v1.5'
    embedding_dimensions: int = 384
    embedding_base_url: str = ''
    embedding_api_key: str = ''
    embedding_cache_dir: str = 'data/embedding-models'
    embedding_local_path: str = ''
