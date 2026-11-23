<div align="center">

<img alt="PiEEG" src="https://github.com/user-attachments/assets/2e93f74c-c30f-4142-b301-717a01112966" />

# PiEEG-server

**Plateforme open source de collecte, de traitement, de diffusion et de visualisation de signaux EEG en temps réel**

[![PyPI](https://img.shields.io/pypi/v/pieeg-server?color=blue)](https://pypi.org/project/pieeg-server/)
[![Python](https://img.shields.io/pypi/pyversions/pieeg-server)](https://pypi.org/project/pieeg-server/)
[![CI](https://github.com/pieeg-club/PiEEG-server/actions/workflows/ci.yml/badge.svg)](https://github.com/pieeg-club/PiEEG-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/pieeg-club/PiEEG-server)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Raspberry%20Pi%20|%20IronBCI-c51a4a)](https://www.raspberrypi.com/)
[![Docs](https://img.shields.io/badge/docs-pieeg.com-blue?logo=vercel&logoColor=white)](https://docs.pieeg.com)
[![Discord](https://img.shields.io/discord/1059637443548987462?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/neJ45FR6Sv)

</div>

PiEEG-server transforme les données de cartes EEG compatibles en flux
WebSocket JSON utilisables par un navigateur, un script Python, une application
tiers ou un outil de recherche. Il comprend un tableau de bord en temps réel,
des fonctions d'enregistrement, des filtres numériques, un moniteur terminal,
une passerelle OSC pour VRChat, des sorties Lab Streaming Layer et des
webhooks.

Le projet prend en charge plusieurs matériels via des pilotes distincts :
PiEEG sur Raspberry Pi, JNEEG sur NVIDIA Jetson Nano, IronBCI/EAREEG par
Bluetooth Low Energy et IronBCI-32 par liaison série USB.

> **PiEEG-server n'est pas un dispositif médical.** Il est destiné aux usages
> éducatifs, expérimentaux et de recherche. Utilisez toujours l'alimentation
> batterie adaptée à l'expérience et ne reliez pas l'installation à du matériel
> alimenté sur le secteur.

## Essayer rapidement

- **Démonstration hébergée :** [cloud.pieeg.com](https://cloud.pieeg.com),
  puis sélectionnez **▶ Use Demo Server**.
- **Sur votre ordinateur :** utilisez le mode synthétique, qui ne nécessite
  aucun matériel.
- **Avec une carte :** installez le pilote correspondant, puis lancez le
  serveur avec le profil `--device`.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

pieeg-server --mock
```

Ouvrez ensuite <http://localhost:1617>. Le flux WebSocket est disponible sur
`ws://localhost:1616`.

Sous Windows, l'environnement n'accède pas directement aux périphériques SPI
ou GPIO. Le mode `--mock` reste utilisable :

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e .
pieeg-server --mock
```

La présence du lanceur `pieeg-server.cmd` permet également :

```powershell
.\pieeg-server.cmd --mock
```

## Matériels pris en charge

| Profil CLI | Matériel | Canaux | Fréquence | Transport |
|---|---|---:|---:|---|
| `pieeg16` | PiEEG-16 | 16 | 250 Hz | SPI Raspberry Pi |
| `pieeg8` | PiEEG-8 | 8 | 250 Hz | SPI Raspberry Pi |
| `jneeg` | JNEEG sur Jetson Nano | 8 | 250 Hz | SPI Jetson Nano |
| `ironbci8` | IronBCI-8 / EAREEG | 8 | 250 Hz | Bluetooth Low Energy |
| `ironbci32` | IronBCI-32 | 32 | 500 Hz | Série USB |

`pieeg16` est le profil par défaut. Les cartes PiEEG utilisent les profils
plateforme `pi4`, `pi5` ou `jetson-nano`; avec `--profile auto`, le profil est
déduit de l'architecture détectée.

Exemples :

```bash
# Raspberry Pi avec PiEEG-16
pieeg-server --device pieeg16

# PiEEG-8
pieeg-server --device pieeg8

# JNEEG sur Jetson Nano
pieeg-server --device jneeg

# IronBCI-8 par Bluetooth
pip install "pieeg-server[ironbci]"
pieeg-server --device ironbci8

# IronBCI-32 par port série
pip install "pieeg-server[ironbci32]"
pieeg-server --device ironbci32 --serial-port /dev/ttyACM0
```

Sous Windows, remplacez le chemin série Linux par `COM3` par exemple.

Il existe également une connexion directe depuis Chrome ou Edge par Web
Bluetooth. Cette voie fonctionne dans le navigateur et peut utiliser le SDK
`pieeg.js` inclus à la racine du dépôt; elle ne lance pas le serveur Python.

## Flux de données

```text
Matériel SPI/BLE/série ou données simulées
              |
              v
      Boucle d'acquisition
              |
              +--> filtre Hampel facultatif
              +--> filtre passe-bande serveur facultatif
              +--> enregistreur CSV
              +--> moniteur terminal
              +--> VRChat OSC
              +--> sortie Lab Streaming Layer
              +--> tableaux de bandes spectrales
              |
              v
      serveur WebSocket :1616
              |
              +--> tableau de bord HTTP :1617
              +--> clients Python, JavaScript ou WebSocket
              +--> Studio hors ligne :1618
```

Chaque trame acquise est envoyée sous forme d'objet JSON. Elle contient un
horodatage, un numéro de trame et la liste des valeurs des canaux.

```json
{"t": 1711234567.123456, "n": 42, "channels": [1.25, -0.40, 3.12]}
```

Les commandes de filtrage et d'enregistrement peuvent être envoyées au serveur
sur le même WebSocket. La configuration exacte est décrite dans les réponses
`help` du serveur et dans le code de `pieeg_server/server.py`.

## Architecture du dépôt

```text
pieeg_server/       Serveur Python, acquisition, pilotes, filtres, API et intégrations
pieeg_studio/       Application FastAPI/MNE pour l'analyse hors ligne
dashboard/          Tableau de bord React 19 + Vite 6
pieeg.js            SDK JavaScript pour navigateur
notebooks/          Notebooks Jupyter d'analyse
doc/                Liens vers la documentation externe
tests/              Tests Python pytest
scripts/            Construction des versions et outils de maintenance
pieeg_server/static/ Tableau de bord précompilé livré avec le paquet
```

Principaux modules Python :

| Module | Responsabilité |
|---|---|
| `acquisition.py` | Boucle d'acquisition et distribution des trames aux abonnés |
| `hardware.py` | Pilote SPI/GPIO PiEEG et configuration ADS1299 |
| `ironbci.py` | Recherche BLE et décodage des trames IronBCI-8 |
| `ironbci_32.py` | Acquisition série USB d'IronBCI-32 |
| `filters.py` | Filtrage passe-bande Butterworth |
| `spike_filter.py` | Filtre Hampel de suppression des impulsions |
| `server.py` | WebSocket, REST léger, filtres dynamiques et intégrations |
| `dashboard.py` | Service HTTP du tableau de bord précompilé |
| `recorder.py` | Enregistrement CSV |
| `lsl.py` | Création des flux Lab Streaming Layer |
| `osc_vrchat.py` | Passerelle OSC vers VRChat |
| `webhooks.py` | Règles et appels HTTP automatisés |
| `doctor.py` | Diagnostics de l'environnement |

## Prérequis

### Serveur

- Python 3.10 ou plus récent
- `pip`
- Linux recommandé pour l'accès au matériel Raspberry Pi ou Jetson Nano
- `spidev` sur Raspberry Pi, installé via l'extra `rpi`
- `bleak` pour IronBCI-8/EAREEG
- `pyserial` pour IronBCI-32

Pour le développement Python :

```bash
python -m pip install -e ".[dev]"
```

Extras disponibles dans `pyproject.toml` :

| Extra | Contenu |
|---|---|
| `rpi` | Support SPI Raspberry Pi avec `spidev` |
| `ironbci` | Support BLE avec `bleak` |
| `ironbci32` | Support série avec `pyserial` |
| `lsl` | Lab Streaming Layer avec `pylsl` |
| `studio` | MNE-Python, pandas, FastAPI, exporteurs et Studio |
| `studio-qt` | Studio avec navigateur MNE Qt |
| `studio-moabb` | Studio, MOABB et PyRiemann |
| `fast` | Accélérateur optionnel `pieeg-core` |
| `dev` | pytest et pytest-asyncio |

### Tableau de bord

- Node.js 22, selon la configuration CI du dépôt
- npm

### Docker

Le `Dockerfile` fourni construit l'image avec Python 3.12 et lance par défaut
le serveur synthétique sans tableau de bord Python :

```bash
docker build -t pieeg-server .
docker run --rm -p 1616:1616 pieeg-server
```

Ce conteneur utilise `pieeg-server --mock --no-dashboard`. Il sert uniquement
comme démonstration ou pour intégrer le flux WebSocket dans un environnement
conteneurisé. Il ne donne pas automatiquement accès au SPI de l'hôte.

## Installation

### Raspberry Pi : installation avec le script fourni

Le script distant clone le dépôt dans `~/PiEEG-server`, installe les dépendances
dans un environnement virtuel, active SPI dans la configuration de démarrage
et crée un service systemd.

```bash
curl -sSL https://raw.githubusercontent.com/pieeg-club/PiEEG-server/main/install.sh | bash
```

La méthode équivalente depuis un clone local est :

```bash
git clone https://github.com/pieeg-club/PiEEG-server.git
cd PiEEG-server
chmod +x setup.sh
./setup.sh
```

Le script doit être exécuté sous Linux. Lorsqu'il ajoute SPI ou
`core_freq_fixed=1`, un redémarrage est nécessaire :

```bash
sudo reboot
```

Après le redémarrage :

```bash
pieeg-server
```

### Installation PyPI

Python 3.10+ est requis.

```bash
python -m pip install pieeg-server
```

Installez l'extra adapté au matériel :

```bash
python -m pip install "pieeg-server[rpi]"
python -m pip install "pieeg-server[ironbci]"
python -m pip install "pieeg-server[ironbci32]"
python -m pip install "pieeg-server[lsl]"
python -m pip install "pieeg-server[studio]"
```

## Configuration et démarrage

### Serveur simulé

```bash
pieeg-server --mock
```

Le mode simulé génère des données EEG synthétiques sans carte ni pilotes
système. Il convient aux tests, aux démonstrations et au développement du
tableau de bord.

### Tableau de bord sur réseau local

```bash
pieeg-server --device pieeg16
```

Puis ouvrez :

- Tableau de bord : `http://<adresse-du-serveur>:1617`
- WebSocket : `ws://<adresse-du-serveur>:1616`

Sur un Raspberry Pi ou un hôte compatible mDNS, `raspberrypi.local` peut être
utilisé dans l'environnement réseau.

### Filtres

Le serveur instancie par défaut un filtre passe-bande 1–40 Hz. La même
configuration peut être redéfinie au démarrage :

```bash
pieeg-server --filter --lowcut 1 --highcut 40
```

Le filtre Hampel est pilotable depuis les interfaces prévues à cet effet; il
n'est pas activé par défaut dans la boucle d'acquisition.

### Enregistrement

Avec un serveur actif :

```bash
pieeg-server --record session.csv
pieeg-server --record session.csv --record-duration 60
```

Un enregistrement indépendant est également disponible :

```bash
pieeg-server record session.csv --mock
pieeg-server record session.csv --duration 60 --mock
```

Le format CSV contient une colonne `timestamp`, suivie de `ch1` à `chN`.

### VRChat OSC

```bash
pieeg-server --mock --osc
pieeg-server --osc --osc-host 127.0.0.1 --osc-port 9000
```

Options utiles : `--osc-mode chatbox`, `--osc-mode parameters`,
`--osc-mode both` et `--osc-interval 0.25`.

### Lab Streaming Layer

Installez d'abord l'extra `lsl`, puis lancez :

```bash
pip install "pieeg-server[lsl]"
pieeg-server --mock --lsl
```

Des groupes de canaux peuvent être enregistrés dans
`~/.pieeg/lsl_groups.json`.

### PiEEG Studio

Installez les dépendances :

```bash
pip install "pieeg-server[studio]"
```

Lancez l'interface hors ligne :

```bash
pieeg-studio
pieeg-studio session.csv
pieeg-studio --port 8080 --no-browser
pieeg-server studio
pieeg-server studio session.csv
```

Studio écoute par défaut sur `http://127.0.0.1:1618`.

Il peut aussi être lancé en même temps que le serveur principal :

```bash
pieeg-server --mock --studio
```

### Moniteur terminal

```bash
pieeg-server monitor --mock
pieeg-server monitor --device pieeg16
```

### Diagnostics

```bash
pieeg-server doctor
pieeg-server doctor --quiet
```

Le sous-commande `doctor` vérifie notamment l'environnement, les dépendances,
les ports, les périphériques et la configuration du service.

### Authentification

```bash
pieeg-server --mock --auth
```

L'authentification génère un code d'accès à six chiffres au démarrage. Les
sessions sont limitées dans le temps et les clients doivent obtenir le jeton
prévu par le flux d'authentification avant d'utiliser le WebSocket.

Sans `--auth`, le tableau de bord et le WebSocket sont accessibles aux clients
du réseau sur lequel le serveur est joint.

## Usages principaux

- Visualiser des formes d'onde en 8, 16 ou 32 canaux.
- Inspecter les bandes Delta, Theta, Alpha, Bêta et Gamma.
- Afficher des spectrogrammes, cartes topographiques et statistiques par canal.
- Lire ou rejouer des sessions CSV.
- Ajouter des annotations pendant une session.
- Envoyer les données vers VRChat via OSC.
- Publier des flux vers des outils compatibles Lab Streaming Layer.
- Déclencher des webhooks, IFTTT ou Zapier à partir des règles disponibles.
- Charger des enregistrements dans PiEEG Studio ou dans les notebooks Jupyter.
- Développer des expériences interactives dans le tableau de bord React.
- Accéder directement à certains matériels depuis Chrome ou Edge.

## API WebSocket

Connexion :

```javascript
const socket = new WebSocket("ws://localhost:1616");

socket.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  console.log(frame.n, frame.channels);
};
```

Connexion depuis Python :

```python
import asyncio
import json
import websockets


async def lire():
    async with websockets.connect("ws://localhost:1616") as socket:
        async for message in socket:
            frame = json.loads(message)
            print(frame["n"], frame["channels"])


asyncio.run(lire())
```

Exemples de commandes JSON prises en charge par le serveur :

```json
{"cmd":"set_filter","enabled":true,"lowcut":1.0,"highcut":40.0}
{"cmd":"set_filter","enabled":false}
{"cmd":"set_notch","enabled":true,"freq":50.0,"q":30.0}
{"cmd":"set_notch","enabled":false}
```

## API HTTP

Le tableau de bord expose également des routes locales. Selon la version du
serveur et les options activées, elles comprennent notamment :

- `GET /health` : état du service
- `GET /api/info` : informations sur le serveur
- `GET /api/spectrum` : dernier relevé agrégé des puissances de bande
- `GET /api/recordings` : liste des enregistrements disponibles

Ces routes sont destinées au tableau de bord et aux clients locaux. Elles ne
doivent pas être considérées comme une API publique sans sécurisation réseau.

## SDK JavaScript `pieeg.js`

Le fichier `pieeg.js` permet de se connecter directement à un équipement
compatible depuis un navigateur.

```html
<script src="https://cdn.jsdelivr.net/gh/pieeg-club/PiEEG-server@main/pieeg.js"></script>

<button id="connect">Connecter la carte</button>

<script>
  const pieeg = new PiEEG();

  document.getElementById("connect").addEventListener("click", async () => {
    await pieeg.connectBLE();

    pieeg.onBandPowers((bands) => {
      console.log(bands);
    });
  });
</script>
```

La connexion Web Bluetooth ou Web Serial doit être déclenchée depuis un geste
utilisateur, généralement un clic. Elle fonctionne principalement dans les
navigateurs Chromium compatibles (Chrome ou Edge) sur une origine sécurisée.

Le SDK prend notamment en charge les profils suivants :

| Identifiant | Matériel | Canaux | Fréquence |
|---|---|---:|---:|
| `ironbci-8` | IronBCI-8 | 8 | 250 Hz |
| `ironbci-16` | IronBCI-16 | 16 | 250 Hz |
| `octopus-16` | Octopus-16 | 16 | 250 Hz |
| `ironbci-32` | IronBCI-32 | 32 | 500 Hz |

## PiEEG Studio et notebooks

### PiEEG Studio

PiEEG Studio est une interface hors ligne construite avec MNE-Python. Elle peut
charger des CSV, fichiers XLSX, EDF, FIF et d'autres formats pris en charge
par les dépendances installées. Elle offre l'inspection des données, les
graphiques, les analyses spectrales et les exports.

### Jupyter

Le dossier `notebooks/` contient quatre exemples :

1. `01_load_and_plot_session.ipynb` : charger et afficher une session.
2. `02_detect_blinks.ipynb` : détecter les clignements sur les canaux frontaux.
3. `03_bandpower_and_alpha.ipynb` : calculer les bandes et repérer des épisodes alpha.
4. `04_export_features_for_ml.ipynb` : produire des caractéristiques pour
   des traitements d'apprentissage automatique.

Installation locale des dépendances du dossier :

```bash
cd notebooks
python -m pip install -r requirements.txt
jupyter lab
```

## Développement

### Serveur Python

```bash
git clone https://github.com/pieeg-club/PiEEG-server.git
cd PiEEG-server
python -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
pieeg-server --mock
```

Sous Windows :

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
pieeg-server --mock
```

### Tableau de bord

Lancez le serveur Python dans un premier terminal :

```bash
pieeg-server --mock
```

Puis lancez Vite dans un autre terminal :

```bash
cd dashboard
npm install
npm run dev
```

La page de développement est généralement accessible sur
`http://localhost:3000`. Vite est configuré pour proxifier les routes
`/auth`, `/api`, `/recordings` vers le serveur Python.

Construisez les fichiers livrés :

```bash
cd dashboard
npm run build
```

La sortie doit être placée dans `pieeg_server/static/dashboard/` pour être
incluse dans l'installation Python. Le hook
`scripts/pre-commit` peut être installé dans Git lorsque une reconstruction
automatique du tableau de bord est souhaitée.

## Tests

Les commandes prévues par le dépôt sont :

```bash
# Tests Python
python -m pip install -e ".[dev]"
pytest -v

# Tests et compilation du tableau de bord
cd dashboard
npm ci
npm test
npm run build
```

La CI GitHub exécute les tests Python sur Python 3.10 à 3.13, puis les tests
et la compilation du dashboard avec Node.js 22.

Un contrôle minimal de la modification peut être effectué avec le mode simulé :

```bash
pieeg-server --mock --no-dashboard
```

## Sécurité

Le serveur est conçu en priorité pour un réseau local privé. Les principaux
points à considérer sont :

- sans `--auth`, le WebSocket et le tableau de bord sont ouverts aux clients
  réseau autorisés;
- les communications ne sont pas chiffrées par TLS tant qu'elles ne passent
  pas par un proxy inverse;
- les données EEG peuvent être sensibles : déterminez une politique de
  conservation avant l'enregistrement;
- utilisez un pare-feu, un VLAN ou un VPN pour l'accès distant;
- les webhooks et les clés de services externes doivent rester hors du dépôt.

Le `--auth` fournit un code d'accès à six chiffres, un cookie de session
HttpOnly et une limitation des tentatives. Cette protection n'est pas une
remplacement d'une authentification utilisateur adaptée à une architecture
exposée sur Internet.

## Dépannage

### Diagnostic général

```bash
pieeg-server doctor
```

### SPI non disponible

Sur Raspberry Pi :

```bash
sudo reboot
ls /dev/spidev0.0
```

La configuration préparée par `setup.sh` ajoute généralement
`dtparam=spi=on` et `core_freq_fixed=1` à la configuration de démarrage.

### Aucun port série trouvé

Listez les ports disponibles, puis passez le chemin exact :

```bash
pieeg-server --device ironbci32 --serial-port /dev/ttyACM0
```

Sous Windows :

```powershell
pieeg-server --device ironbci32 --serial-port COM3
```

### Erreur Bluetooth

- Vérifiez que l'équipement n'est pas déjà connecté à un autre hôte.
- Passez `--ble-address` si l'adresse est connue.
- Passez `--ble-name` si le nom de l'équipement diffère de `EAREEG`.
- Installez `pieeg-server[ironbci]`.

### Développement avec ou sans matériel

```bash
pieeg-server --mock
pieeg-server --mock --no-dashboard
```

## Liens utiles

- [Documentation](https://docs.pieeg.com)
- [Documentation migrée vers PiEEG-docs](https://github.com/pieeg-club/PiEEG-docs)
- [PyPI](https://pypi.org/project/pieeg-server/)
- [Dépôt GitHub](https://github.com/pieeg-club/PiEEG-server)
- [Serveur de démonstration](https://cloud.pieeg.com)
- [Communauté Discord](https://discord.gg/neJ45FR6Sv)
- [Signaler un problème](https://github.com/pieeg-club/PiEEG-server/issues)
- [PiEEG-8](https://github.com/pieeg-club/PiEEG)
- [PiEEG-16](https://github.com/pieeg-club/PiEEG-16)
- [IronBCI-8](https://github.com/pieeg-club/ironbci)
- [IronBCI-32](https://github.com/pieeg-club/ironbci-32)

## Licence

Ce dépôt est distribué sous licence MIT. Consultez [LICENSE](LICENSE).

L'accélérateur natif optionnel `pieeg-core` est un composant distinct et possède
sa propre licence. Son installation reste facultative.
