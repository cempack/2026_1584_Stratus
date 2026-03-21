# ![Orbit](assets/orbit.svg) Données et assets

## ![Package](assets/package.svg) Ce qui va dans `data/`

Tout ce que l'application consomme au runtime sans être du code :

- `data/cache/` : cache généré.
- `data/atc/` : données radio locales.
- `data/assets/app/` : assets visuels utilisés par l'interface.

## ![Code](assets/code.svg) Ce qui ne va pas dans `data/`

- le code applicatif,
- les dépendances front embarquées,
- les images purement documentaires.

Ces éléments restent dans `sources/`, `docs/` ou `example/`.

## ![Pencil](assets/pencil.svg) Ajouter un aéroport ATC

1. Créer `data/atc/<ICAO>/`.
2. Ajouter `airport.json`.
3. Ajouter un ou plusieurs fichiers `.pls`.

Exemple de contenu minimal pour `airport.json` :

```json
{
  "name": "Paris Charles de Gaulle",
  "label": "Paris CDG",
  "city": "Paris",
  "country": "FR",
  "lat": 49.0097,
  "lng": 2.5479
}
```

## ![Globe](assets/globe.svg) Assets runtime actuels

- `logo.svg`
- `aircraft-placeholder.svg`
- `earth-blue-marble.jpg`
- `earth-topology.png`

## ![Check](assets/check.svg) Règle pratique

Si un fichier doit être servi à l'application en direct, il va dans `data/assets/app/`.

S'il sert à la doc ou au README, il va plutôt dans `docs/assets/` ou `example/`.
