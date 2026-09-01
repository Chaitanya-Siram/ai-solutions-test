import logging
import os
import sys
from dotenv import load_dotenv

load_dotenv()


def setup_logging(level: str | int | None = None) -> logging.Logger:
    """Configure the root logger once. Idempotent."""
    root = logging.getLogger()
    log_level = level or os.getenv("LOG_LEVEL", "INFO")
    if isinstance(log_level, str):
        log_level = getattr(logging, log_level.upper(), logging.INFO)
    root.setLevel(log_level)

    if not any(getattr(h, "_pr_solutions", False) for h in root.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s [%(name)s] %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        handler._pr_solutions = True  # type: ignore[attr-defined]
        root.addHandler(handler)

    for noisy in ("urllib3", "httpx", "httpcore", "openai", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    return logging.getLogger("pr_solutions")


logger = setup_logging()

# ===========================================================================
# Configuration variables (from environment)
# ===========================================================================

class Configs:
    """Configuration variables loaded from environment variables."""

    ENVIRONMENT = os.environ.get('ENVIRONMENT', "Local")

    # Authentication / JWT
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY")
    JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
    ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
    REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "30"))

    # LLM provider switch: "claude" (default) or "gpt"
    LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gpt").strip().lower()
    LLM_CONCURRENCY = int(os.getenv("LLM_CONCURRENCY", "5"))
    LLM_BATCH_SIZE = int(os.getenv("LLM_BATCH_SIZE", "20"))
    # Below this relevancy score the gate marks an article irrelevant, even if
    # the model said is_relevant=true.
    RELEVANCY_MIN_CONFIDENCE = float(os.getenv("RELEVANCY_MIN_CONFIDENCE", "0.3"))

    # Anthropic Claude
    ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
    CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5")
    MAX_OUTPUT_TOKENS = int(os.getenv("MAX_OUTPUT_TOKENS", "32000"))

    # E2B sandbox (used by the chart-code agent to run LLM-generated Python)
    E2B_API_KEY = os.getenv("E2B_API_KEY", "")

    # Azure OpenAI
    AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY", "")
    AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "")
    AZURE_OPENAI_API_VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21")
    AZURE_OPENAI_MODEL = os.getenv("AZURE_OPENAI_MODEL", "")

    # Embeddings (article similarity): "openai" (Azure OpenAI), "voyage" or "local"
    # (sentence-transformers). EMBEDDING_MODEL blank means the provider's default.
    EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "local").strip().lower()
    EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "").strip()
    VOYAGE_API_KEY = os.getenv("VOYAGE_API_KEY", "")
    SIMILAR_EMBED_THRESHOLD = float(os.getenv("SIMILAR_EMBED_THRESHOLD", "0.85"))
    SIMILAR_EMBED_MAX_CHARS = int(os.getenv("SIMILAR_EMBED_MAX_CHARS", "1500"))
    # How far either side of a new article's own date to look for an existing story
    # group to join. Bounds the candidate read as the pool grows; 0 disables the
    # cross-run search entirely (every batch then starts its own groups).
    SIMILAR_GROUP_LOOKBACK_DAYS = int(os.getenv("SIMILAR_GROUP_LOOKBACK_DAYS", "7"))

    # AWS S3 configuration
    AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
    AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
    AWS_REGION = os.getenv("AWS_REGION")

    AWS_S3_BUCKET = os.getenv("AWS_S3_BUCKET")
    AWS_S3_REACH_BUCKET = os.getenv("AWS_S3_REACH_BUCKET")
    AWS_S3_REACH_FILE = os.getenv("AWS_S3_REACH_FILE")
    PUBLICATION_SOURCE_FILE = os.getenv("PUBLICATION_SOURCE_FILE", "publication_cleaned_data.csv")

    SIMILAR_WEB_REST_API_KEY = os.getenv("SIMILAR_WEB_REST_API_KEY")

    # SerpAPI (Google News article fetching)
    SERP_API_KEY = os.getenv("SERP_API_KEY", "")

    # Database configuration
    DB_HOST = os.environ.get('DB_HOST')
    DB_PORT = os.environ.get('DB_PORT')
    DB_NAME = os.environ.get('DB_NAME')
    DB_USER = os.environ.get('DB_USER')
    DB_PASSWORD = os.environ.get('DB_PASSWORD')
    DB_SCHEMA = os.environ.get('DB_SCHEMA', 'ai_solution')

    # Google News RSS Recency Hours
    DEFAULT_RSS_RECENCY_HOURS = 48      # Default if no recency hour given
    HOURLY_FETCH_HOURS = 2              # Scheduler
    # When `tagging websocket` is called for a window session whose generated query is
    # NOT scheduled. A scheduled one fetches nothing there — the hourly scheduler owns
    # that project's pool, so the review page reads it from the database as it stands.
    WS_REVIEW_FETCH_HOURS = 24
    SCHEDULER_FETCH_HOURS = 24

    # How long one hourly scheduler run may take before it is declared stuck and its
    # id released, so the next slot can fire. Longer than any healthy run (10 parallel
    # queries of bounded fetches, then LLM tagging at up to 600s per call) and shorter
    # than the hour between slots. The thread itself cannot be killed — see scheduler.
    SCHEDULER_RUN_TIMEOUT_SECONDS = int(os.getenv("SCHEDULER_RUN_TIMEOUT_SECONDS", str(45 * 60)))
    # Worker threads for scheduled runs. A dedicated pool, so a run that wedges cannot
    # starve the asyncio.to_thread calls the request handlers depend on.
    SCHEDULER_MAX_CONCURRENT_RUNS = int(os.getenv("SCHEDULER_MAX_CONCURRENT_RUNS", "4"))
    # How long an ingest pass waits for another pass on the same project to finish
    # before giving up. Bounded so a wedged holder can't block every later run forever.
    POOL_LOCK_TIMEOUT_SECONDS = float(os.getenv("POOL_LOCK_TIMEOUT_SECONDS", "900"))
    # Timezone the daily cron jobs in cron_jobs.py fire in.
    CRON_TIMEZONE = os.getenv("CRON_TIMEZONE", "Asia/Kolkata")
    # How often the OneDrive sync polls its folders, in minutes. Also the misfire grace
    # time, so a slot missed by more than one interval is dropped rather than run late.
    ONEDRIVE_SYNC_MINUTES = int(os.getenv("ONEDRIVE_SYNC_MINUTES", "10"))

    GOOGLE_NEW_RSS_MAX_PER_QUERY = 200

    # Zepto Credentials
    ZEPTO_USERNAME = os.environ.get('ZEPTO_USERNAME')
    ZEPTO_PASSWD_KEY = os.environ.get('ZEPTO_PASSWD_KEY')
    ZEPTO_SERVER = os.environ.get('ZEPTO_SERVER')
    ZEPTO_PORT = int(os.environ.get('ZEPTO_PORT', 587))
    ZEPTO_FROM = os.environ.get('ZEPTO_FROM')

    # Microsoft Graph Credentials
    MICROSOFT_CLIENT_ID = os.environ.get('MICROSOFT_CLIENT_ID')
    MICROSOFT_CLIENT_SECRET = os.environ.get('MICROSOFT_CLIENT_SECRET')
    MICROSOFT_TENANT_ID = os.environ.get('MICROSOFT_TENANT_ID')
    MICROSOFT_USER_EMAIL = os.environ.get('MICROSOFT_USER_EMAIL')

    # Warn about missing critical configuration variables
    required_vars = {
        "LLM_PROVIDER": LLM_PROVIDER,
        "AWS_ACCESS_KEY_ID": AWS_ACCESS_KEY_ID,
        "AWS_SECRET_ACCESS_KEY": AWS_SECRET_ACCESS_KEY,
        "AWS_S3_BUCKET": AWS_S3_BUCKET,
        "AWS_REGION": AWS_REGION,

        # DB Configs
        "DB_HOST": DB_HOST,
        "DB_PORT": DB_PORT,
        "DB_NAME": DB_NAME,
        "DB_USER": DB_USER,
        "DB_PASSWORD": DB_PASSWORD,
    }

    for var_name, var_value in required_vars.items():
        if not var_value:
            logger.warning(f"Configuration variable '{var_name}' is not set. This may cause errors.")


envs = Configs()