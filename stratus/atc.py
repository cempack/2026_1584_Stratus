"""LiveATC catalog from data/atc (airport.json + *.pls per airport), stream resolution and audio proxy."""

from __future__ import annotations

import configparser
import json
import logging
import re
from pathlib import Path

log = logging.getLogger(__name__)

DISABLED_FEEDS = {"kord7", "ksea2_twr_e", "lfpg3_dep", "lfpo3_twr"}
STREAM_BASE = "https://d.liveatc.net"
# LiveATC rejects non-browser clients, so the audio proxy keeps a browser UA (only exception to the Stratus UA).
AUDIO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/130.0.0.0 Safari/537.36",
    "Accept": "audio/*,*/*;q=0.8",
    "Referer": "https://www.liveatc.net/",
}


def _feed_id(text: str) -> str:
    for pat in (r"mount=([\w.-]+)", r"/redir\.php/([\w.-]+)", r"https?://d\.liveatc\.net/([\w.-]+)"):
        m = re.search(pat, text or "", re.I)
        if m:
            return m.group(1)
    return ""


def _parse_pls(path: Path) -> dict | None:
    cp = configparser.ConfigParser(interpolation=None)
    try:
        cp.read(path, encoding="utf-8")
    except configparser.Error:
        return None
    url = cp.get("playlist", "File1", fallback="").strip()
    fid = _feed_id(url) or re.sub(r"[^\w.-]", "", path.stem)
    if not fid or fid.lower() in DISABLED_FEEDS:
        return None
    return {"id": fid, "label": cp.get("playlist", "Title1", fallback=fid).strip() or fid,
            "url": url or f"{STREAM_BASE}/redir.php/{fid}"}


def load_catalog(atc_dir: Path) -> list[dict]:
    airports = []
    if not atc_dir.is_dir():
        return airports
    for d in sorted(p for p in atc_dir.iterdir() if p.is_dir()):
        try:
            cfg = json.loads((d / "airport.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cfg = {}
        order = {name: i for i, name in enumerate(cfg.get("order") or [])}
        feeds, seen = [], set()
        for pls in sorted(d.glob("*.pls"), key=lambda p: (order.get(p.name, len(order)), p.name.lower())):
            f = _parse_pls(pls)
            if f and f["id"] not in seen:
                seen.add(f["id"])
                feeds.append(f)
        icao = str(cfg.get("icao") or d.name).strip().upper()
        if not feeds or not re.fullmatch(r"[A-Z0-9]{4}", icao):
            continue
        lat, lon = cfg.get("lat"), cfg.get("lng", cfg.get("lon"))
        airports.append({"icao": icao, "name": cfg.get("name") or icao, "city": cfg.get("city") or "",
                         "country": cfg.get("country") or "",
                         "lat": float(lat) if lat is not None else None,
                         "lon": float(lon) if lon is not None else None, "feeds": feeds})
    return airports


class AtcCatalog:
    def __init__(self, atc_dir: Path):
        self.airports = load_catalog(atc_dir)
        self.by_icao = {a["icao"]: a for a in self.airports}

    def public(self) -> dict:
        return {"airports": [{**a, "feeds": [{"id": f["id"], "label": f["label"]} for f in a["feeds"]]}
                             for a in self.airports]}

    def resolve(self, icao: str, feed: str | None) -> dict | None:
        a = self.by_icao.get((icao or "").strip().upper())
        if not a:
            return None
        if not feed:
            return a["feeds"][0]
        return next((f for f in a["feeds"] if f["id"] == feed), None)
