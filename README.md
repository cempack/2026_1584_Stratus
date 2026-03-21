<div align="center">
<img src="docs/assets/logo.jpg" alt="Stratus" width="160" />
<h1><img src="docs/assets/plane.svg" width="28" height="28" alt="" /> Stratus</h1>
<p><strong>Suivi aérien en temps réel sur globe 3D</strong></p>
<p>OpenSky · Flask · JavaScript</p>
</div>

---

## ![Globe](docs/assets/globe.svg) Aperçu

Stratus affiche les avions sur un globe 3D et ajoute autour de cette vue :

- ![Plane](docs/assets/plane.svg) une recherche radar,
- ![Code](docs/assets/code.svg) une fiche avion détaillée,
- ![Sun](docs/assets/sun.svg) une couche météo,
- ![Orbit](docs/assets/orbit.svg) un répertoire radio ATC,
- ![Pencil](docs/assets/pencil.svg) des réglages OpenSky.

---

## ![Package](docs/assets/package.svg) Lancement

Depuis la racine :

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 main.py
```

Le lanceur fonctionne aussi avec `python3 main.py --no-browser`.

---

## ![Globe](docs/assets/globe.svg) Configuration OpenSky

Le projet peut tourner sans identifiants, mais le mode authentifié est recommandé.

Les identifiants peuvent être ajoutés :

- depuis l'interface,
- ou via `.env` à la racine.

Exemple :

```env
OPENSKY_CLIENT_ID=your_client_id
OPENSKY_CLIENT_SECRET=your_client_secret
```

---

## ![Check](docs/assets/check.svg) Captures

### ![Globe](docs/assets/globe.svg) Vue d'ensemble

![Vue d'ensemble](example/screenshots/globe-overview.png)

### ![Plane](docs/assets/plane.svg) Recherche radar

![Recherche radar](example/screenshots/recherche-radar.png)

### ![Code](docs/assets/code.svg) Fiche avion

![Fiche avion](example/screenshots/fiche-avion.png)

### ![Orbit](docs/assets/orbit.svg) Radio ATC

![Radio ATC](example/screenshots/radio-atc.png)

### ![Pencil](docs/assets/pencil.svg) Réglages OpenSky

![Réglages OpenSky](example/screenshots/reglages-opensky.png)

---

## ![Package](docs/assets/package.svg) Structure rapide

| Chemin             | Rôle                     |
| :----------------- | :----------------------- |
| `main.py`          | point d'entrée conseillé |
| `sources/`         | code de l'application    |
| `data/assets/app/` | assets runtime           |
| `data/cache/`      | cache OpenSky            |
| `data/atc/`        | fichiers radio ATC       |
| `docs/`            | documentation de reprise |
| `example/`         | captures et tutoriels    |

---

## ![Pencil](docs/assets/pencil.svg) Documentation

- [docs/demarage-rapide.md](docs/demarage-rapide.md)
- [docs/structure-projet.md](docs/structure-projet.md)
- [docs/fonctionnalites.md](docs/fonctionnalites.md)
- [docs/donnees-et-assets.md](docs/donnees-et-assets.md)
- [presentation.md](presentation.md)

---

## ![Users](docs/assets/users.svg) Exemples

- [example/README.md](example/README.md)
- [example/tutorials/01-globe-et-demarrage.md](example/tutorials/01-globe-et-demarrage.md)
- [example/tutorials/02-recherche-et-selection.md](example/tutorials/02-recherche-et-selection.md)
- [example/tutorials/03-fiche-avion.md](example/tutorials/03-fiche-avion.md)
- [example/tutorials/04-radio-atc.md](example/tutorials/04-radio-atc.md)
- [example/tutorials/05-reglages-opensky.md](example/tutorials/05-reglages-opensky.md)
