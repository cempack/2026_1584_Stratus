"""Dev server: python -m stratus"""

import os

from .api import create_app
from .config import Config


def main() -> None:
    cfg = Config.from_env()
    # A dev server must not run the global background sweep (it hammers adsb.lol / adsb.fi from a laptop for hours):
    # only when asked explicitly. Production (gunicorn) builds its app elsewhere and keeps the sweep.
    if not os.environ.get("STRATUS_SWEEP"):
        cfg.sweep_enabled = False
    app = create_app(cfg)
    app.run(host="0.0.0.0", port=cfg.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
