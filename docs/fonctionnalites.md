# Fonctionnalités

## 1. Globe 3D

L'écran principal affiche les avions sur un globe 3D.

Ce bloc dépend surtout de :

- `sources/index.html`
- `sources/app.js`
- `data/assets/app/earth-blue-marble.jpg`
- `data/assets/app/earth-topology.png`

## 2. Recherche radar

L'utilisateur peut chercher :

- un vol,
- une immatriculation,
- un hex ICAO,
- un pays.

La recherche est gérée côté front puis les détails viennent du backend.

## 3. Fiche avion

Quand un avion est sélectionné, l'application affiche :

- identité de l'appareil,
- position et vitesse,
- trajectoire,
- météo locale,
- photo si disponible.

## 4. Radio ATC

Le widget radio charge une liste locale d'aéroports et de flux.

Les fichiers viennent de `data/atc/`.

Chaque dossier d'aéroport contient :

- un `airport.json`,
- un ou plusieurs fichiers `.pls`.

## 5. Réglages OpenSky

L'interface permet d'enregistrer :

- `client_id`
- `client_secret`

Ces valeurs sont stockées dans `.env` à la racine.

## 6. Cache local

Le backend garde une copie locale du dernier snapshot pour :

- redémarrer plus vite,
- afficher quelque chose même avant la première synchro complète,
- limiter les écrans vides au chargement.
