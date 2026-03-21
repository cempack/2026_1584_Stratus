# Reprise Rapide

## Lancer le projet

Depuis la racine :

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 main.py
```

Le serveur écoute par défaut sur `http://127.0.0.1:8090`.

Options utiles :

- `python3 main.py --no-browser`
- `python3 main.py --port 8091`
- `python3 main.py --debug`

## Où regarder en premier

- `main.py` : lanceur du projet.
- `sources/server.py` : backend Flask, cache, OpenSky, météo, LiveATC.
- `sources/index.html` : structure de l'interface.
- `sources/app.js` : logique principale du front.
- `sources/client/` : fonctions front isolées et testables.

## Dossiers importants

- `data/cache/` : cache disque OpenSky.
- `data/atc/` : flux radio locaux (`.pls`) et `airport.json`.
- `data/assets/app/` : assets runtime servis par Flask.
- `docs/assets/` : images utilisées par la documentation.
- `example/` : captures et mini tutoriels.

## Pièges connus

- Sans identifiants OpenSky, le projet tourne en mode anonyme et rafraîchit moins souvent.
- Le front dépend des routes Flask; si `sources/server.py` ne démarre pas, l'interface reste vide.
- Les flux radio locaux doivent être rangés par code ICAO dans `data/atc/<ICAO>/`.

## Vérifications rapides

- Ouvrir la page d'accueil.
- Vérifier que le globe s'affiche.
- Vérifier que `/api/flights` renvoie bien un JSON.
- Ouvrir les réglages OpenSky.
- Tester l'ouverture du répertoire ATC.
