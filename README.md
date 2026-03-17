# Stratus

Stratus est une interface de suivi aérien en temps réel basée sur OpenSky.
Le projet affiche les appareils sur un globe 3D, permet de rechercher un vol,
une immatriculation, un hex ICAO ou un pays, et enrichit la sélection avec des
informations météo et média.

## Prérequis

- Python 3.10 ou plus récent
- `pip`

## Installation

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Lancer le projet

```bash
source .venv/bin/activate
python server.py
```

Le serveur démarre sur [http://localhost:8090](http://localhost:8090).

## Configuration OpenSky

**Il est fortement recommandé d’ajouter une clé API (gratuite).** Sans identifiants, le
projet tourne en mode anonyme (plus limité) et le bon fonctionnement de
l’application n’est pas garanti. Pour obtenir des identifiants et en savoir
plus : [OpenSky Network](https://opensky-network.org/).

Configuration possible :

- depuis l’interface via le bouton de réglages ;
- ou dans un fichier `.env` à la racine du projet.

Exemple :

```env
OPENSKY_CLIENT_ID=your_client_id
OPENSKY_CLIENT_SECRET=your_client_secret
```

## Structure

- `server.py` : API Flask et agrégation des données OpenSky / météo
- `app.js` : logique du globe, rendu client et interactions
- `index.html` : structure et styles de l'interface
- `assets/` : ressources statiques
- `vendor/` : dépendances front embarquées
