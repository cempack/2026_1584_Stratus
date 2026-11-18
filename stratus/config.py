"""Environment-driven settings."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = "Stratus/2.0 (+https://stratus.elliotmoreau.fr)"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


def _remote_env() -> str | None:
    raw = os.environ.get("STRATUS_ASR_URL")
    if raw is None or not raw.strip():
        return None
    return "" if raw.strip().lower() in ("off", "0", "none", "local") else raw.strip()


@dataclass
class Config:
    opensky_client_id: str = ""
    opensky_client_secret: str = ""
    opensky_daily_credits: int = 4000
    opensky_anon_daily_credits: int = 400
    data_dir: Path = field(default_factory=lambda: PROJECT_ROOT / "data")
    web_dist: Path = field(default_factory=lambda: PROJECT_ROOT / "web" / "dist")
    port: int = 8090
    adsblol_key: str = ""  # env ADSBLOL_API_KEY: adsb.lol's 1,000 requests/day key (500/day per IP without)
    fr24_token: str = ""  # env FR24_API_TOKEN; empty = FR24 disabled, nothing changes
    fr24_daily_credits: int = 900
    sweep_enabled: bool = True
    sweep_interval: float = 1.5
    estimates_enabled: bool = True
    captions_enabled: bool = True  # live ATC subtitles (needs faster-whisper; off when it is not installed)
    captions_model: str = ""  # local fallback model; empty = automatic ("small", "base" if the machine is too slow)
    captions_remote: str | None = None  # Workers AI endpoint; None = the default Worker, "" = local only

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def atc_dir(self) -> Path:
        return self.data_dir / "atc"

    @property
    def opensky_oauth(self) -> bool:
        return bool(self.opensky_client_id and self.opensky_client_secret)

    @classmethod
    def from_env(cls) -> "Config":
        data_dir = os.environ.get("STRATUS_DATA_DIR", "").strip()
        web_dist = os.environ.get("STRATUS_WEB_DIST", "").strip()
        cfg = cls(
            opensky_client_id=os.environ.get("OPENSKY_CLIENT_ID", "").strip(),
            opensky_client_secret=os.environ.get("OPENSKY_CLIENT_SECRET", "").strip(),
            opensky_daily_credits=_env_int("OPENSKY_DAILY_CREDITS", 4000),
            port=_env_int("PORT", 8090),
            fr24_token=os.environ.get("FR24_API_TOKEN", "").strip(),
            adsblol_key=os.environ.get("ADSBLOL_API_KEY", "").strip(),
            fr24_daily_credits=_env_int("FR24_DAILY_CREDITS", 900),
            sweep_enabled=_env_bool("STRATUS_SWEEP", True),
            sweep_interval=_env_float("STRATUS_SWEEP_INTERVAL", 1.5),
            estimates_enabled=_env_bool("STRATUS_ESTIMATES", True),
            captions_enabled=_env_bool("STRATUS_CAPTIONS", True),
            captions_model=os.environ.get("STRATUS_CAPTIONS_MODEL", "").strip(),
            captions_remote=_remote_env(),
        )
        if data_dir:
            cfg.data_dir = Path(data_dir)
        if web_dist:
            cfg.web_dist = Path(web_dist)
        return cfg
