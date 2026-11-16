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


@dataclass
class Config:
    opensky_client_id: str = ""
    opensky_client_secret: str = ""
    opensky_daily_credits: int = 4000
    opensky_anon_daily_credits: int = 400
    data_dir: Path = field(default_factory=lambda: PROJECT_ROOT / "data")
    web_dist: Path = field(default_factory=lambda: PROJECT_ROOT / "web" / "dist")
    port: int = 8090

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
        )
        if data_dir:
            cfg.data_dir = Path(data_dir)
        if web_dist:
            cfg.web_dist = Path(web_dist)
        return cfg
