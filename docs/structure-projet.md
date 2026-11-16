# ![Package](assets/package.svg) Structure du projet

## ![Globe](assets/globe.svg) Vue d'ensemble

Le projet est séparé en quatre blocs :

- `stratus/` : backend Python (API Flask, collecte des positions, enrichissement).
- `web/` : interface TypeScript + MapLibre (globe 3D).
- `data/` : fichiers runtime (cache, flux radio).
- `docs/` et `example/` : documentation, reprise et démonstration.

En production, un seul conteneur : Node construit `web/dist`, l'image Python le sert avec l'API (voir `Dockerfile`).

## ![Code](assets/code.svg) Backend (`stratus/`)

- `__main__.py` : `python -m stratus` lance l'API et sert l'interface construite.
- `api.py` : fabrique de l'application Flask et routes (`/api/planes`, `/api/aircraft`, `/api/airport`, `/api/metar`, `/api/winds`, `/api/alerts`, `/api/atc`…).
- `config.py` : réglages lus dans l'environnement.
- `store.py` : magasin des avions, règles de fusion, trajectoires, encodage du snapshot.
- `feeds/opensky.py` : collecte mondiale avec budget de crédits.
- `feeds/readsb.py` : adsb.lol et adsb.fi (zone visible, avion sélectionné).
- `feeds/sweep.py` : balayage de couverture, environ 124 cercles de 250 NM.
- `estimate.py` : positions estimées le long de l'itinéraire quand un avion n'est plus reçu.
- `enrich.py` : appareil et itinéraire (adsbdb), photos (Planespotters).
- `fr24.py` : Flightradar24 facultatif (itinéraire, position, trajectoire complète).
- `airports.py` : catalogue OurAirports (aéroports et pistes).
- `board.py` : arrivées et départs d'un aéroport, déduits des avions en vol.
- `metar.py`, `winds.py`, `weather.py` : météo (METAR, vents en altitude, météo à l'avion).
- `atc.py` : catalogue LiveATC et proxy audio.

## ![Orbit](assets/orbit.svg) Interface (`web/src/`)

- `main.ts` : point d'entrée, boucles de données, sélection, caméra, mode suivi.
- `api.ts` : client typé de l'API et ordonnanceur de requêtes.
- `style.css`, `../index.html` : la grille d'interface (zones haut / bas, fiches ancrées à droite ou en feuille sur téléphone).
- `ui/` : fiche vol (`panel.ts`), fiche aéroport (`airport.ts`), menu Calques et filtres (`layers.ts`), radio ATC (`atc.ts`), statut et alertes (`status.ts`), recherche, pastille radar, crédits, thème.
- `map/` : `planes.ts` (avions, estimés, trajectoires), `layers.ts` (spécification de toutes les couches), `style.ts` (fond de carte), `radar.ts` (RainViewer), `winds.ts` (particules de vent), `metar.ts` (pastilles de catégorie de vol).
- `lib/` : logique pure : `core.ts` (fusion, estimation, formats), `filters.ts`, `layout.ts`, `follow.ts`, `winds.ts`, `bbox.ts`, `airport.ts`, `radio.ts`, `prefs.ts`.
- `mock/` : API simulée pour `npm run dev` sans backend.

## ![Pencil](assets/pencil.svg) Données et assets

- `data/atc/<ICAO>/airport.json` : métadonnées d'un aéroport radio.
- `data/atc/<ICAO>/*.pls` : flux audio LiveATC.
- `data/cache/` : cache runtime (volume en production).
- `docs/assets/` : icônes et images de documentation.
- `example/screenshots/` : captures du logiciel.
- `example/tutorials/` : mini tutoriel par fonctionnalité.

## ![Check](assets/check.svg) Tests

- `tests/` : backend Python (`python -m pytest -q`).
- `web/src/**/*.test.ts` : interface, lancés par `npx vitest run`. Ils couvrent la logique pure (fusion, filtres, vents, mise en page, formats) et valident toutes les couches de la carte avec `validateStyleMin`.
