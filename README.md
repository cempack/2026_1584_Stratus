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
python3 sources/server.py
```

Le serveur démarre sur [http://localhost:8090](http://localhost:8090).

## Catalogue radio local

Les flux ATC sont maintenant rangés par aéroport dans `sources/data/atc/`.
Chaque aéroport a son propre dossier avec :

- un `airport.json` pour les informations de base ;
- un ou plusieurs fichiers `.pls` téléchargés depuis LiveATC.

Exemple :

```text
sources/data/atc/
  KJFK/
    airport.json
    kjfk_twr_1191.pls
    kjfk9_s.pls
  KSFO/
    airport.json
    ksfo_twr.pls
```

### Ajouter un nouveau flux

Pour un aéroport déjà présent :

1. téléchargez le fichier `.pls` voulu depuis LiveATC ;
2. placez-le dans `sources/data/atc/<ICAO>/` ;
3. rechargez l'application.

Pour un nouvel aéroport :

1. créez un dossier `sources/data/atc/<ICAO>/` ;
2. ajoutez-y les fichiers `.pls` ;
3. créez un `airport.json` avec les métadonnées ;
4. rechargez l'application.

Exemple de `airport.json` :

```json
{
  "icao": "KSFO",
  "name": "San Francisco International Airport",
  "city": "San Francisco",
  "country": "US",
  "lat": 37.619806,
  "lng": -122.374821,
  "description": "Aéroport international de San Francisco.",
  "order": ["ksfo_twr.pls", "ksfo_gnd2.pls", "ksfo_app2.pls"]
}
```

Notes :

- `order` est optionnel, mais pratique pour afficher les flux dans le bon ordre ;
- le titre affiché dans l'interface vient directement du contenu du fichier `.pls` ;
- si vous ajoutez seulement un `.pls` a un dossier existant, il sera disponible sans autre configuration.

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

- `sources/server.py` : API Flask et agrégation des données OpenSky / météo
- `sources/app.js` : logique du globe, rendu client et interactions
- `sources/index.html` : structure et styles de l'interface
- `sources/data/atc/` : catalogue local des flux ATC, un dossier par aéroport
- `sources/assets/` : ressources statiques
- `sources/vendor/` : dépendances front embarquées
