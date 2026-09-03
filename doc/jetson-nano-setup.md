# PiEEG server on Jetson Nano (8-channel)

Setup guide for the NVIDIA Jetson Nano + PiEEG shield (single ADS1299, 8 channels).

Support for the Jetson Nano lives on the `add-JNEEG-support` branch. Start by
checking it out.

> Scope: 8-channel (single ADS1299). 16-channel mode depends on Pi-shield CS
> wiring and is not covered here.

## 1. Get the code (this branch)

```bash
git clone https://github.com/pieeg-club/PiEEG-server.git
cd PiEEG-server
git checkout add-JNEEG-support
```

## 2. Install system packages

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip git
```

## 3. Enable SPI on the 40-pin header

The ADS1299 talks over SPI, which is off by default on the Nano. Enable it with
NVIDIA's config tool:

```bash
sudo /opt/nvidia/jetson-io/jetson-io.py
```

In the menu: **Configure 40-pin header** -> enable **spi1** -> **Save and
reboot**. After reboot, confirm the device node exists:

```bash
ls /dev/spidev0.0
```

## 4. Grant SPI/GPIO access (avoid running as root)

```bash
sudo groupadd -f spi
sudo usermod -aG spi,gpio "$USER"
```

Log out and back in (or reboot) so the new groups take effect. If you prefer,
you can skip this and run the server with `sudo` instead.

## 5. Install the server

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e ".[rpi]"
```

The `rpi` extra installs `spidev`, which is generic Linux SPI and works on the
Nano. The Pi-only `setup.sh` script is not used here.

## 6. Verify

```bash
pieeg-server doctor
```

The profile auto-detects as `jetson-nano` from `/proc/device-tree/model`, which
sets the SPI clock to 600 kHz and points GPIO at `/dev/gpiochip0`.

## 7. Run

```bash
pieeg-server --device pieeg8
```

`--profile jetson-nano` is selected automatically. To force it explicitly:

```bash
pieeg-server --device pieeg8 --profile jetson-nano
```

## Verify the DRDY pin (one-time hardware check)

The `jetson-nano` profile assumes the data-ready line (header pin 7) maps to
line offset **216** on `/dev/gpiochip0`. If samples never arrive, confirm the
offset on your JetPack release:

```bash
sudo apt install -y gpiod
gpioinfo gpiochip0 | grep -i -E "line *7|216"
```

If the offset differs, pass the correct chip explicitly:

```bash
pieeg-server --device pieeg8 --gpio-chip /dev/gpiochip0
```

and report the value so the profile can be corrected.
