# ![Plane](assets/plane.svg) Reprise rapide

## ![Package](assets/package.svg) Lancer le projet

Stratus se compose d'un backend Python (`stratus/`) et d'une interface TypeScript (`web/`). Depuis la racine :

```bash
# 1. backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m stratus

# 2. interface (dans un second terminal)
cd web
npm ci
npm run build        # produit web/dist, servi par le backend
```

Le serveur écoute par défaut sur `http://127.0.0.1:8090` (variable `PORT`). Il sert l'API (`/api/...`) et l'interface
construite (`web/dist`). Tant que `web/dist` n'existe pas, une page d'attente s'affiche.

Pour développer l'interface avec rechargement à chaud :

```bash
cd web
npm run dev                                   # API simulée (mock/), sans backend
VITE_API=http://localhost:8090 npm run dev    # ou en pointant sur un vrai backend
```

## ![Check](assets/check.svg) Variables d'environnement

Tout est facultatif : sans rien, le projet tourne en mode anonyme.

- `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` : accès OpenSky authentifié (4 000 crédits par jour au lieu de 400).
- `FR24_API_TOKEN` : active Flightradar24 (itinéraire fiable, trajectoire complète). `FR24_DAILY_CREDITS` plafonne la
  dépense quotidienne (900 par défaut).
- `STRATUS_SWEEP=0` : coupe le balayage de couverture (adsb.lol / adsb.fi).
- `STRATUS_ESTIMATES=0` : coupe les positions estimées.
- `PORT`, `STRATUS_DATA_DIR`, `STRATUS_WEB_DIST` : port, dossier de données et dossier de l'interface.

Les identifiants ne sont lus que dans l'environnement : aucune route HTTP ne permet de les lire ou de les modifier.

## ![Code](assets/code.svg) Où regarder en premier

- `stratus/api.py` : application Flask et routes de l'API.
- `docs/architecture-v2.md` : contrat entre le backend et l'interface (routes, champs, règles de fusion).
- `web/src/main.ts` : point d'entrée de l'interface, relie la carte, les panneaux et les boucles de données.
- `web/src/ui/` : panneaux et menus (fiche vol, fiche aéroport, calques, radio ATC, statut).
- `web/src/map/` : couches MapLibre (avions, radar météo, vents, METAR).
- `web/src/lib/` : logique pure et testée (fusion des positions, filtres, mise en page, vents, formats).

## ![Package](assets/package.svg) Dossiers importants

- `data/cache/` : cache disque (snapshot des avions, budget de crédits OpenSky et Flightradar24, catalogue OurAirports).
- `data/atc/` : flux radio LiveATC (`.pls`) et `airport.json` par aéroport.
- `docs/assets/` : images utilisées par la documentation.
- `example/` : captures et mini tutoriels.

## ![Check](assets/check.svg) Tests

```bash
python -m pytest -q          # backend
cd web
npx tsc --noEmit             # types (mode strict)
npx vitest run               # logique pure et validité des couches de la carte
npm run build                # contrôle final
```

## ![Check](assets/check.svg) Attention

- Sans identifiants OpenSky, le projet tourne en mode anonyme et rafraîchit moins souvent.
- Les couches de la carte sont validées par `validateStyleMin` dans les tests : une expression MapLibre invalide ferait
  tomber la carte en production, ne pas contourner ces tests.
- Les flux radio doivent être rangés par code ICAO dans `data/atc/<ICAO>/`.
- Le conteneur n'utilise qu'un seul worker (`gunicorn -w 1`) parce que les collecteurs de données vivent dans le processus.

## ![Globe](assets/globe.svg) Vérifications rapides

- Ouvrir la page d'accueil : le globe et les avions apparaissent, le radar météo est visible.
- Vérifier que `/api/status` renvoie bien un JSON et que `/api/planes` répond.
- Ouvrir le menu Calques (bouton en haut à droite) et activer Vents en altitude ou METAR.
- Cliquer sur un avion, puis sur un aéroport.
- Ouvrir la radio ATC et lancer une écoute.
