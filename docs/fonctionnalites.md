# ![Globe](assets/globe.svg) Fonctionnalités

## ![Globe](assets/globe.svg) 1. Globe 3D et mise en page

L'écran principal affiche les avions sur un globe 3D, coloré selon l'altitude. L'interface est volontairement sobre : une
grille fixe de zones ancrées (en haut la recherche et les outils, en bas l'état, une case centrale contextuelle et les
crédits) pour que rien ne se superpose, de 360 px (téléphone, feuille en bas) jusqu'aux grands écrans. Les fiches se
posent à droite et la carte se recadre pour garder l'avion visible.

Ce bloc dépend surtout de `web/index.html`, `web/src/style.css`, `web/src/lib/layout.ts` et `web/src/map/`.

## ![Plane](assets/plane.svg) 2. Recherche

La barre de recherche (raccourci `/`) trouve :

- un vol (indicatif), une immatriculation, un code ICAO ou un type d'appareil,
- un aéroport (code ICAO ou IATA, nom, ville), via le catalogue OurAirports.

Choisir un aéroport ouvre sa fiche ; choisir un vol ouvre la fiche vol.

## ![Code](assets/code.svg) 3. Fiche vol

Quand un avion est sélectionné, l'application affiche :

- photo et compagnie, itinéraire avec progression et heure d'arrivée estimée,
- altitude, vitesse, taux vertical et profil d'altitude,
- appareil, transpondeur et météo à l'altitude de l'avion,
- la source de l'itinéraire, discrètement (« Itinéraire : FR24 » ou « adsbdb, non confirmé »).

Boutons : **Suivre** (la caméra suit l'avion avec une inclinaison douce et un cap aligné sur la trajectoire ; le moindre
glissement de la carte met fin au suivi) et, avec Flightradar24 actif, **Trajectoire complète** (40 crédits, uniquement
sur clic).

## ![Orbit](assets/orbit.svg) 4. Positions estimées

Quand un avion de ligne n'est plus reçu (océan, zone sans couverture), le serveur continue de le faire avancer le long de
son itinéraire. Sur la carte il apparaît creux et atténué, avec un segment pointillé depuis son dernier signal ; la fiche
indique « Position estimée depuis X min ». Dès qu'un vrai signal revient, l'avion reprend sa place. Cette couche se
désactive dans le menu Calques.

## ![Pencil](assets/pencil.svg) 5. Menu Calques et filtres

Un seul bouton réunit tous les réglages de la carte :

- **Radar météo** (activé par défaut) : image la plus récente, discrète. Une petite pastille en bas indique l'heure ;
  survolée ou touchée, elle révèle la lecture et la barre de défilement.
- **Vents en altitude** : fins filets animés à partir de `/api/winds` (niveau au choix : sol, 1 500 m, 5 500 m, 10 000 m).
- **METAR** : pastille de catégorie de vol (VFR, MVFR, IFR, LIFR) sur les grands aéroports.
- **Satellite**, **Positions estimées**, **Thème clair ou sombre** et la **légende des altitudes**.
- **Filtres** : plage d'altitude, catégorie (léger, jet, gros porteur, hélico), préfixe de compagnie ou d'indicatif, et un
  raccourci « Gros porteurs uniquement ».

Les choix sont mémorisés dans le navigateur.

## ![Globe](assets/globe.svg) 6. Fiche aéroport

Un clic sur un aéroport de la carte (ou un résultat de recherche) ouvre sa fiche :

- nom, ville, code ICAO et IATA,
- METAR décodé en français avec la catégorie de vol,
- pistes (longueur, revêtement),
- arrivées (avec heure d'arrivée estimée) et départs en direct ; un clic sélectionne le vol,
- un bouton pour écouter la tour si un flux radio existe.

## ![Check](assets/check.svg) 7. Radio ATC

Le répertoire radio liste les aéroports qui ont un flux LiveATC. Le lecteur est pensé comme une tour de contrôle :
tour stylisée, fréquence sur un afficheur LCD ambre (« 119.100 MHz »), voyant RX et indicateur de niveau alimentés par
l'analyse audio en direct, canaux avec icône (Tour, Sol, Approche, ATIS…), temps écoulé et état « En direct ». Pendant la
navigation, un mini-lecteur (tour, fréquence, niveau, arrêt) occupe la case centrale en bas.

Les fichiers viennent de `data/atc/` : un dossier par aéroport avec un `airport.json` et un ou plusieurs `.pls`.

## ![Sun](assets/sun.svg) 8. Alertes

Les avions qui émettent 7500, 7600 ou 7700 sont signalés : rien n'apparaît quand il n'y en a pas ; sinon un point rouge
s'affiche sur la pastille d'état, la liste figure dans son panneau (un clic sélectionne l'avion) et l'avion porte un
discret anneau rouge sur la carte.

## ![Check](assets/check.svg) 9. Sources, couverture et cache

- Les positions viennent d'OpenSky (monde entier, budget de crédits suivi en continu), d'adsb.lol et d'adsb.fi (zone
  visible, avion sélectionné et balayage de couverture en arrière-plan).
- Le backend garde un snapshot local pour redémarrer vite et éviter les écrans vides.
- Le bouton « i » en bas à droite liste les crédits des données réellement affichées.
