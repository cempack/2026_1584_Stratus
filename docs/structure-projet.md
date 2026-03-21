# Structure Du Projet

## Vue d'ensemble

Le projet est séparé en trois blocs :

- `sources/` : code de l'application.
- `data/` : fichiers runtime.
- `docs/` et `example/` : reprise, documentation et démonstration.

## Code applicatif

- `main.py` : point d'entrée conseillé.
- `sources/server.py` : serveur Flask et API.
- `sources/index.html` : squelette de l'interface.
- `sources/app.js` : orchestration du globe, des interactions et des appels API.
- `sources/client/app-core.mjs` : recherche, synchronisation des vols, météo.
- `sources/client/aircraft-visuals.mjs` : variantes visuelles des avions.
- `sources/client/scan-state.mjs` : états de chargement et messages UI.
- `sources/vendor/` : bibliothèques front embarquées.

## Données et assets

- `data/assets/app/` : logo, textures du globe, placeholder image.
- `data/cache/opensky-cache.json.gz` : snapshot local des vols.
- `data/atc/<ICAO>/airport.json` : métadonnées d'un aéroport radio.
- `data/atc/<ICAO>/*.pls` : flux audio LiveATC locaux.

## Documentation et exemples

- `docs/` : documentation de reprise simple.
- `docs/assets/` : icônes et images de documentation.
- `example/screenshots/` : captures réelles du logiciel.
- `example/tutorials/` : mini tutoriel par fonctionnalité.

## Tests

- `tests/test_server.py` : backend Python.
- `tests/*.test.mjs` : modules front testables sous Node.
