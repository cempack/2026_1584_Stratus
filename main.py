from __future__ import annotations

import argparse
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
SOURCES_DIR = PROJECT_ROOT / "sources"
DATA_DIR = PROJECT_ROOT / "data"
ATC_DIR = DATA_DIR / "atc"
CACHE_DIR = DATA_DIR / "cache"
APP_ASSETS_DIR = DATA_DIR / "assets" / "app"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8090

sys.path.insert(0, str(SOURCES_DIR))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lance proprement le serveur Stratus depuis la racine du projet."
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help="Adresse d'ecoute du serveur.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port HTTP a utiliser.")
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Ne pas ouvrir automatiquement le navigateur.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Active le mode debug Flask sans reloader.",
    )
    return parser.parse_args()


def ensure_runtime_layout() -> None:
    missing = [path for path in (SOURCES_DIR / "index.html", SOURCES_DIR / "server.py") if not path.exists()]
    if missing:
        missing_list = ", ".join(str(path.relative_to(PROJECT_ROOT)) for path in missing)
        raise SystemExit(f"Fichiers manquants: {missing_list}")

    for path in (DATA_DIR, ATC_DIR, CACHE_DIR, APP_ASSETS_DIR):
        path.mkdir(parents=True, exist_ok=True)


def browser_url(host: str, port: int) -> str:
    if host in {"0.0.0.0", "::"}:
        host = "127.0.0.1"
    return f"http://{host}:{port}"


def open_browser_later(url: str, delay: float = 1.0) -> None:
    def opener() -> None:
        time.sleep(delay)
        webbrowser.open(url)

    thread = threading.Thread(target=opener, daemon=True)
    thread.start()


def print_banner(url: str, debug: bool) -> None:
    print("=" * 50)
    print("Stratus")
    print("=" * 50)
    print(f"Racine     : {PROJECT_ROOT}")
    print(f"Interface  : {SOURCES_DIR}")
    print(f"Donnees    : {DATA_DIR}")
    print(f"Python     : {Path(sys.executable).resolve()}")
    print(f"URL        : {url}")
    print(f"Mode debug : {'oui' if debug else 'non'}")
    print("Arret      : Ctrl+C")


def preferred_project_python() -> Path | None:
    for candidate in (
        PROJECT_ROOT / ".venv" / "bin" / "python",
        PROJECT_ROOT / "venv" / "bin" / "python",
    ):
        if candidate.exists():
            return candidate
    return None


def is_current_python_from(candidate: Path) -> bool:
    return Path(sys.prefix).resolve() == candidate.parent.parent.resolve()


def load_server_module():
    try:
        import server  # noqa: E402
    except ModuleNotFoundError as exc:
        if exc.name not in {"flask", "requests"}:
            raise

        preferred_python = preferred_project_python()
        current_python = Path(sys.executable)
        if preferred_python is not None and not is_current_python_from(preferred_python):
            print(
                f"[Stratus] Dependance manquante ({exc.name}) dans {current_python}. "
                f"Relance automatique avec {preferred_python}."
            )
            os.execv(str(preferred_python), [str(preferred_python), str(PROJECT_ROOT / "main.py"), *sys.argv[1:]])

        print(f"[Stratus] Dependance manquante: {exc.name}")
        print("[Stratus] Activez un environnement Python puis installez les dependances :")
        print("  pip install -r requirements.txt")
        return None

    return server


def main() -> int:
    args = parse_args()
    ensure_runtime_layout()
    server = load_server_module()
    if server is None:
        return 1

    url = browser_url(args.host, args.port)
    print_banner(url, args.debug)
    if not args.no_browser:
        open_browser_later(url)

    try:
        server.run_server(host=args.host, port=args.port, debug=args.debug, announce=False)
    except KeyboardInterrupt:
        print("\n[Stratus] Arret demande par l'utilisateur.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
