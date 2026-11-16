"""Dev server: python -m stratus"""

from .api import create_app
from .config import Config


def main() -> None:
    cfg = Config.from_env()
    app = create_app(cfg)
    app.run(host="0.0.0.0", port=cfg.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
