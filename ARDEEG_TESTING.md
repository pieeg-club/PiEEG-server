# Testing ardEEG with pieeg-server

Step-by-step guide to test the **ardEEG** device (Arduino Uno WiFi + ADS1299,
8 channels @ 250 Hz over WiFi UDP) with pieeg-server — from cloning the branch
through powering on the board.

> Requires Python 3.10+ and a machine on the same Wi-Fi network as the board.

## 1. Clone the repository

```bash
git clone https://github.com/pieeg-club/PiEEG-server.git
cd PiEEG-server
```

## 2. Check out the `ardEEG` branch

```bash
git checkout ardEEG
```

## 3. Create and activate a virtual environment

**Windows (PowerShell):**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

**macOS / Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

## 4. Install the package

```bash
pip install -e .
```

ardEEG needs **no extra dependency** — the UDP transport uses the Python
standard library. (No `[ironbci]` / `[ironbci32]` extras required.)

Verify the CLI is available:
```bash
pieeg-server --help
```

## 5. Smoke-test without hardware (optional but recommended)

Confirm the device wiring works using synthetic data — no board needed:

```bash
pieeg-server --mock --device ardeeg8
```

You should see it start an 8-channel @ 250 Hz stream and serve the dashboard at
`http://localhost:1617`. Press `Ctrl+C` to stop.

## 6. Find this machine's local IP address

The ardEEG board sends UDP to a **fixed destination IP** that you flash into its
firmware, so you need this computer's LAN address:

**Windows:**
```powershell
ipconfig | Select-String "IPv4"
```

**macOS / Linux:**
```bash
hostname -I              # Linux
ipconfig getifaddr en0   # macOS (Wi-Fi)
```

Note the address (e.g. `192.168.1.241`).

## 7. Flash the ardEEG firmware

From the [ardEEG repo](https://github.com/pieeg-club/ardEEG), open the Arduino
sketch and set:

- your **Wi-Fi SSID and password**, and
- the **destination IP** to the address from step 6, **port `13900`**.

Flash it to the Arduino Uno WiFi. Make sure the board and this computer are on
the **same Wi-Fi network**.

## 8. Start the server listening for ardEEG

```bash
pieeg-server --device ardeeg8
```

This binds UDP `0.0.0.0:13900` and waits for datagrams. To bind a specific
interface or port:

```bash
pieeg-server --device ardeeg8 --udp-ip 192.168.1.241 --udp-port 13900
```

> Only one program can bind the UDP port at a time — close the ardEEG reference
> receiver before starting the server.

## 9. Power on the board

Power up the ardEEG. Within a second or two you should see live data:

- terminal logs reporting samples arriving, and
- 8 channels streaming on the dashboard at `http://localhost:1617`.

If nothing arrives after ~5 s, the server prints a stall warning — check that
the board is powered, joined the **same Wi-Fi**, and is sending to this
machine's IP on port `13900`. On Windows, confirm the port is free with:

```powershell
netstat -ano | findstr :13900
```
