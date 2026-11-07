"""
Low-level hardware interface for PiEEG.

Manages one, two, or three ADS1299 ADC chips via SPI (8 channels each:
8, 16, or 24 channels) and GPIO lines for chip-select and data-ready signaling.

Requires: spidev (pip), Linux GPIO chardev (kernel, no pip package needed)
Must run on Raspberry Pi with SPI enabled and PiEEG shield connected.
"""

import glob
import logging
import os
import struct
import sys
import time

try:
    import fcntl
except ImportError:
    fcntl = None  # not on Linux — hardware methods will fail, mock mode still works

from . import _native
from .profiles import HardwareProfile, get_profile

logger = logging.getLogger("pieeg.hardware")

try:
    import spidev
except ImportError:
    spidev = None


def _require_hardware_libs():
    """Check that spidev is available, exit with a clear message if not."""
    if spidev is None:
        print(
            "\n  ERROR: Missing hardware library: spidev\n\n"
            "  The direct PiEEG SPI shield requires a Raspberry Pi (spidev).\n"
            "  Other EEG devices and modes work on any machine.\n\n"
            "  On a Pi, install the SPI dependencies inside the project venv:\n"
            "    cd PiEEG-server && ./setup.sh\n\n"
            "  On other machines, use a device-agnostic mode:\n"
            "    pieeg-server --mock               # synthetic data, no hardware\n"
            "    pieeg-server --ble                # BLE EEG device (e.g. IronBCI)\n"
            "    pieeg-server --serial-port PORT   # serial device (e.g. IronBCI-32)\n\n"
            "  Need help?\n"
            "    pieeg-server --help               # list all options\n"
            "    pieeg-server doctor               # diagnose your setup\n"
            "    https://discord.gg/neJ45FR6Sv     # ask the PiEEG community\n",
            file=sys.stderr,
        )
        sys.exit(1)

# --- ADC register addresses ---
WHO_I_AM = 0x00
CONFIG1 = 0x01
CONFIG2 = 0x02
CONFIG3 = 0x03
CH1SET = 0x05
CH2SET = 0x06
CH3SET = 0x07
CH4SET = 0x08
CH5SET = 0x09
CH6SET = 0x0A
CH7SET = 0x0B
CH8SET = 0x0C

# --- ADC commands ---
CMD_WAKEUP = 0x02
CMD_RESET = 0x06
CMD_START = 0x08
CMD_STOP = 0x0A
CMD_RDATAC = 0x10
CMD_SDATAC = 0x11
CMD_RDATA = 0x12

# --- Conversion constants ---
# 24-bit ADC: 2^23 - 1 = 0x7FFFFF, 2^24 - 1 = 0xFFFFFF
SIGN_TEST = 0x7FFFFF
FULL_SCALE = 0xFFFFFF
FULL_SCALE_PLUS_1 = 16777215
NEGATIVE_OFFSET = 16777214
VREF_UV = 4.5e6  # 4.5V reference in microvolts

# --- GPIO pins ---
CS_PIN = 19        # CS chip 2 (GPIO19, pin 35)
CS_PIN_2 = 21      # CS chip 3 (GPIO21, pin 40 — PiEEG-24)
DRDY_PIN = 26      # DRDY chip 1 (GPIO26, pin 37)
DRDY_PIN_2 = 13    # DRDY chip 2 (GPIO13, pin 33)
DRDY_PIN_3 = 5     # DRDY chip 3 (GPIO5, pin 29 — PiEEG-24)

# --- SPI settings ---
SPI_SPEED_HZ = 4_000_000
SPI_MODE = 0b01
SPI_BITS = 8
BYTES_PER_READ = 27  # 3 status + 8 channels * 3 bytes

# --- Expected status header from ADC chip 2 ---
EXPECTED_STATUS = (192, 0, 8)  # 0xC0, 0x00, 0x08

# --- Spike detection defaults (matches not_spike script) ---
SPIKE_THRESHOLD = 5000  # max allowed jump in raw 24-bit signed value
SPIKE_RESET_AFTER = 50  # re-sync baseline after this many consecutive rejections

# --- Linux GPIO chardev v1 ioctl constants ---
# See include/uapi/linux/gpio.h in the Linux kernel source.
# ioctl numbers: _IOWR(type=0xB4, nr, size) = (3<<30)|(size<<16)|(0xB4<<8)|nr
_GPIO_GET_CHIPINFO    = 0x8044B401   # _IOR(0xB4, 0x01, 68)   – gpiochip_info
_GPIO_GET_LINEHANDLE  = 0xC16CB403   # _IOWR(0xB4, 0x03, 364) – gpiohandle_request
_GPIOHANDLE_GET_VALUES = 0xC040B408  # _IOWR(0xB4, 0x08, 64)  – gpiohandle_data
_GPIOHANDLE_SET_VALUES = 0xC040B409  # _IOWR(0xB4, 0x09, 64)  – gpiohandle_data
_GPIOHANDLE_REQUEST_INPUT  = 1 << 0
_GPIOHANDLE_REQUEST_OUTPUT = 1 << 1
_HANDLE_REQUEST_SIZE = 364  # sizeof(struct gpiohandle_request)
_HANDLE_DATA_SIZE    = 64   # sizeof(struct gpiohandle_data)


def _find_gpiochip() -> str | None:
    """Pick the 40-pin-header GPIO controller (Pi 3/4: bcm2835/2711, Pi 5: rp1)."""
    if fcntl is None:
        return None
    best = None
    for path in sorted(glob.glob("/dev/gpiochip*")):
        try:
            fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
            buf = bytearray(68)
            fcntl.ioctl(fd, _GPIO_GET_CHIPINFO, buf)
            os.close(fd)
        except OSError:
            continue
        label = buf[32:64].split(b"\0")[0].decode(errors="replace")
        if label.startswith("pinctrl-rp1") or label.startswith("pinctrl-bcm"):
            return path
        best = best or path
    return best


class PiEEGHardware:
    """Hardware abstraction for PiEEG shields (8, 16, or 24 channels)."""

    # Channel register addresses for convenience
    CH_REGS = (CH1SET, CH2SET, CH3SET, CH4SET, CH5SET, CH6SET, CH7SET, CH8SET)

    def __init__(self, gpio_chip: str | None = None,
                 num_channels: int = 16,
                 profile: HardwareProfile | str | None = None):
        if num_channels not in (8, 16, 24):
            raise ValueError(f"num_channels must be 8, 16, or 24, got {num_channels}")
        self._num_channels = num_channels
        # Resolve profile: accept a HardwareProfile, a name string, or None.
        # None / "auto" trigger auto-detection; unknown setups fall back to
        # the safe default (= pre-existing behavior).
        if isinstance(profile, HardwareProfile):
            self._profile = profile
        else:
            self._profile = get_profile(profile)
        # GPIO chardev: an explicit caller/CLI value wins; otherwise fall back
        # to the profile's chip (e.g. /dev/gpiochip0 on Jetson). Passing the
        # historical default string still selects that chip, so Pi setups are
        # unchanged.
        self._gpio_chip_name = gpio_chip if gpio_chip is not None else self._profile.gpio_chip
        # GPIO line offsets come from the profile (Pi defaults = 19/21/26/13/5).
        self._cs_pin = self._profile.cs_pin
        self._cs_pin_2 = getattr(self._profile, "cs_pin_2", CS_PIN_2)
        self._drdy_pin = self._profile.drdy_pin
        self._drdy_pin_2 = self._profile.drdy_pin_2
        self._drdy_pin_3 = getattr(self._profile, "drdy_pin_3", DRDY_PIN_3)
        # 16-ch and 24-ch modes always need manual GPIO CS toggling for chip 2
        # (GPIO19) and chip 3 (GPIO21), regardless of manage_cs_pin.
        self._manage_cs = self._profile.manage_cs_pin or num_channels in (16, 24)
        if num_channels in (16, 24) and not self._profile.manage_cs_pin:
            logger.warning(
                "Profile %r disables CS pin management, but %d-channel mode "
                "requires manual GPIO CS for secondary chip(s). Forcing CS management on.",
                self._profile.name, num_channels,
            )
        self._chip_fd = -1
        self._cs_fd = -1
        self._cs2_fd = -1
        self._drdy_fd = -1
        self._drdy2_fd = -1
        self._drdy3_fd = -1
        self._spi1 = None
        self._spi2 = None
        self._last_valid_value: int | None = None
        self._spike_count = 0
        self._consecutive_rejects = 0
        self._spike_threshold = SPIKE_THRESHOLD
        self._spike_reset_after = SPIKE_RESET_AFTER
        self._bad_frames: list[int] = [0, 0, 0]
        self._register_state: dict[int, int] = {}
        self._cmd_queue = None
        # Starts at the profile's hard default; only changes if a caller
        # explicitly assigns a new value. Legacy behavior is unchanged.
        self._spi_speed_hz = self._profile.spi_speed_hz

    @property
    def num_channels(self) -> int:
        return self._num_channels

    @property
    def bad_frames(self) -> list[int]:
        """Per-chip bad frame counts (frames where status byte was not 0xC_)."""
        return list(getattr(self, "_bad_frames", [0, 0, 0]))

    @property
    def gpio_chip(self) -> str:
        """Resolved GPIO chardev path (explicit override or profile default)."""
        return self._gpio_chip_name

    @property
    def spike_threshold(self) -> int:
        return self._spike_threshold

    @spike_threshold.setter
    def spike_threshold(self, value: int):
        v = int(value)
        self._spike_threshold = v if v == -1 else max(0, v)
        q = getattr(self, "_cmd_queue", None)
        if q is not None:
            try:
                q.put_nowait(("spike_threshold", self._spike_threshold))
            except Exception:
                pass

    @property
    def spike_reset_after(self) -> int:
        return self._spike_reset_after

    @spike_reset_after.setter
    def spike_reset_after(self, value: int):
        self._spike_reset_after = max(1, int(value))
        q = getattr(self, "_cmd_queue", None)
        if q is not None:
            try:
                q.put_nowait(("spike_reset_after", self._spike_reset_after))
            except Exception:
                pass

    @property
    def spi_speed_hz(self) -> int:
        return self._spi_speed_hz

    @spi_speed_hz.setter
    def spi_speed_hz(self, value: int):
        # Clamp to a sane range and apply live to any open SPI device(s).
        v = max(100_000, min(int(value), 8_000_000))
        self._spi_speed_hz = v
        if self._spi1 is not None:
            self._spi1.max_speed_hz = v
        if self._spi2 is not None:
            self._spi2.max_speed_hz = v
        q = getattr(self, "_cmd_queue", None)
        if q is not None:
            try:
                q.put_nowait(("spi_speed_hz", self._spi_speed_hz))
            except Exception:
                pass

    # --- lifecycle ---

    def open(self):
        """Initialize GPIO and SPI, configure ADC chip(s)."""
        _require_hardware_libs()
        self._init_gpio()
        self._init_spi()
        self._configure_adc(chip_num=1)
        if self._num_channels == 16:
            self._configure_adc(chip_num=2)
        elif self._num_channels == 24:
            # On PiEEG-24, chip 1 (U5) drives the shared CLK net for chips 2/3
            # (U6/U7). ADS1299 power-on reset needs 2^18 clock cycles (~128 ms)
            # once a clock is present; wait before configuring chips 2 and 3.
            time.sleep(0.2)
            self._configure_adc(chip_num=2)
            self._configure_adc(chip_num=3)
            self._start_all_24()

    def close(self):
        """Release all hardware resources."""
        if self._spi1:
            self._spi1.close()
        if self._spi2 and self._num_channels in (16, 24):
            self._spi2.close()
        if self._cs_fd >= 0:
            os.close(self._cs_fd)
            self._cs_fd = -1
        if self._cs2_fd >= 0:
            os.close(self._cs2_fd)
            self._cs2_fd = -1
        if self._drdy_fd >= 0:
            os.close(self._drdy_fd)
            self._drdy_fd = -1
        if self._drdy2_fd >= 0:
            os.close(self._drdy2_fd)
            self._drdy2_fd = -1
        if self._drdy3_fd >= 0:
            os.close(self._drdy3_fd)
            self._drdy3_fd = -1
        if self._chip_fd >= 0:
            os.close(self._chip_fd)
            self._chip_fd = -1

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()

    # --- public API ---

    def read_sample(self):
        """
        Read one sample from the ADC (8, 16, or 24 channels).

        Returns None on status header mismatch.
        Returns a list of floats (microvolts) on success.

        Caller (acquisition loop) is responsible for DRDY polling.
        """
        # Read 27 bytes from ADC chip 1
        raw1 = self._spi1.readbytes(BYTES_PER_READ)
        ok1 = (raw1[0] & 0xF0) == 0xC0
        if not ok1 and hasattr(self, "_bad_frames"):
            self._bad_frames[0] += 1

        if self._num_channels == 16:
            # Wait for chip 2 DRDY falling edge before reading
            self._wait_drdy2()
            self._cs_set(0)
            raw2 = self._spi2.readbytes(BYTES_PER_READ)
            self._cs_set(1)

            if (raw2[0] & 0xF0) != 0xC0 and hasattr(self, "_bad_frames"):
                self._bad_frames[1] += 1

            # Spike detection: check last channel of chip 2 (bytes 24-26)
            if not self._is_valid_frame(raw2):
                return None

            # Validate status bytes from chip 2
            if (raw2[0], raw2[1], raw2[2]) != EXPECTED_STATUS:
                return None

            channels = []
            channels.extend(self._decode_channels(raw1))
            channels.extend(self._decode_channels(raw2))
            return channels
        elif self._num_channels == 24:
            # On PiEEG-24, all 3 chips share chip 1's clock and start in
            # 3 -> 2 -> 1 order, so when chip 1's DRDY falls, chips 2 and 3
            # already have their conversion ready.
            self._cs_set(0)
            raw2 = self._spi2.readbytes(BYTES_PER_READ)
            self._cs_set(1)

            self._cs2_set(0)
            raw3 = self._spi2.readbytes(BYTES_PER_READ)
            self._cs2_set(1)

            ok2 = (raw2[0] & 0xF0) == 0xC0
            ok3 = (raw3[0] & 0xF0) == 0xC0
            if hasattr(self, "_bad_frames"):
                if not ok2:
                    self._bad_frames[1] += 1
                if not ok3:
                    self._bad_frames[2] += 1

            if not self._is_valid_frame(raw3):
                return None

            if not (ok1 and ok2 and ok3):
                return None

            channels = []
            channels.extend(self._decode_channels(raw1))
            channels.extend(self._decode_channels(raw2))
            channels.extend(self._decode_channels(raw3))
            return channels
        else:
            # 8-channel mode: spike detection on chip 1
            if not self._is_valid_frame(raw1):
                return None
            return self._decode_channels(raw1)

    def _is_valid_frame(self, raw: list[int]) -> bool:
        """Spike detection matching the original not_spike script.

        Checks the last 3 bytes (bytes 24-26) of the SPI read as a signed
        24-bit integer. If the jump from the previous valid value exceeds
        SPIKE_THRESHOLD, the frame is considered corrupted.

        A threshold of -1 disables spike rejection entirely.
        """
        if self._spike_threshold == -1:
            return True

        combined = (raw[24] << 16) | (raw[25] << 8) | raw[26]
        if raw[24] & 0x80:
            combined -= 1 << 24

        if self._last_valid_value is None:
            self._last_valid_value = combined
            return False  # first frame is always skipped, matching original

        if abs(combined - self._last_valid_value) > self._spike_threshold:
            self._spike_count += 1
            self._consecutive_rejects += 1
            if self._consecutive_rejects >= self._spike_reset_after:
                # Electrode contact likely changed — accept new baseline
                logger.info(
                    "Spike filter reset after %d consecutive rejects "
                    "(old=%d, new=%d)",
                    self._consecutive_rejects,
                    self._last_valid_value,
                    combined,
                )
                self._last_valid_value = combined
                self._consecutive_rejects = 0
                return True
            logger.debug("Spike detected (count: %d)", self._spike_count)
            return False

        self._last_valid_value = combined
        self._consecutive_rejects = 0
        return True

    def wait_for_drdy(self):
        """
        Block until DRDY goes high (pre-condition for a valid read).
        Returns True when DRDY is high, meaning data will be ready
        on the next low transition.
        """
        return self._drdy_get() == 1

    # --- register configuration ---

    def configure_registers(self, reg_map: dict[int, int]):
        """Write arbitrary registers with STOP → SDATAC → write → RDATAC → START.

        Applies to all active chips (1 in 8-ch, 1..2 in 16-ch, 1..3 in 24-ch).
        Updates the shadow register state.
        Resets spike filter baseline so the first post-config frames aren't
        rejected due to the signal level changing (e.g. normal → shorted).
        """
        if self._num_channels == 24:
            chips = [1, 2, 3]
        elif self._num_channels == 16:
            chips = [1, 2]
        else:
            chips = [1]

        for chip in chips:
            self._send_command(chip, CMD_STOP)
            self._send_command(chip, CMD_SDATAC)
            for addr, value in reg_map.items():
                self._write_register(chip, int(addr), int(value) & 0xFF)
            if self._num_channels != 24:
                self._send_command(chip, CMD_RDATAC)
                self._send_command(chip, CMD_START)

        if self._num_channels == 24:
            self._start_all_24()

        self._register_state.update(reg_map)
        # Reset spike filter — signal level changes after config, old baseline
        # would cause false rejections (e.g. normal→shorted: ±50µV → ±2µV)
        self._last_valid_value = None
        self._consecutive_rejects = 0
        logger.info("Registers configured: %s", {hex(k): hex(v) for k, v in reg_map.items()})

    def set_input_short(self):
        """Set all CHnSET registers to 0x01 (input shorted for noise test)."""
        reg_map = {reg: 0x01 for reg in self.CH_REGS}
        self.configure_registers(reg_map)

    def set_input_normal(self):
        """Set all CHnSET registers to 0x00 (normal electrode input)."""
        reg_map = {reg: 0x00 for reg in self.CH_REGS}
        self.configure_registers(reg_map)

    @property
    def register_state(self) -> dict[int, int]:
        """Return a copy of the shadow register state."""
        return dict(self._register_state)

    # --- GPIO helpers (direct Linux chardev ioctl) ---

    def _cs_set(self, value: int):
        """Set chip 2 chip-select line (GPIO19): 1 = high (deselect), 0 = low (select).

        No-op when the active profile delegates CS to the kernel SPI driver
        (e.g. Pi 5 in 8-channel mode). In 16/24-channel mode this always toggles
        GPIO19 because chip 2's CS is wired there on the PiEEG shield.
        """
        if not self._manage_cs or self._cs_fd < 0:
            return
        buf = bytearray(_HANDLE_DATA_SIZE)
        buf[0] = value & 1
        fcntl.ioctl(self._cs_fd, _GPIOHANDLE_SET_VALUES, buf)

    def _cs2_set(self, value: int):
        """Set chip 3 chip-select line (GPIO21, PiEEG-24): 1 = high, 0 = low."""
        if not self._manage_cs or self._cs2_fd < 0:
            return
        buf = bytearray(_HANDLE_DATA_SIZE)
        buf[0] = value & 1
        fcntl.ioctl(self._cs2_fd, _GPIOHANDLE_SET_VALUES, buf)

    def _drdy_get(self) -> int:
        """Read chip 1 data-ready line. Returns 1 when high."""
        buf = bytearray(_HANDLE_DATA_SIZE)
        fcntl.ioctl(self._drdy_fd, _GPIOHANDLE_GET_VALUES, buf)
        return buf[0]

    def _drdy2_get(self) -> int:
        """Read chip 2 data-ready line. Returns 1 when high."""
        buf = bytearray(_HANDLE_DATA_SIZE)
        fcntl.ioctl(self._drdy2_fd, _GPIOHANDLE_GET_VALUES, buf)
        return buf[0]

    def _drdy3_get(self) -> int:
        """Read chip 3 data-ready line (GPIO5, PiEEG-24). Returns 1 when high."""
        buf = bytearray(_HANDLE_DATA_SIZE)
        fcntl.ioctl(self._drdy3_fd, _GPIOHANDLE_GET_VALUES, buf)
        return buf[0]

    def _wait_drdy2(self):
        """Block until chip 2 DRDY goes LOW (falling edge = data ready)."""
        while self._drdy2_get() == 0:   # wait out previous low
            pass
        while self._drdy2_get() == 1:   # wait for HIGH→LOW
            pass

    # --- private helpers ---

    def _init_gpio(self):
        """Initialize GPIO via Linux chardev v1 ioctl (no gpiod dependency)."""
        if not os.path.exists(self._gpio_chip_name):
            detected_chip = _find_gpiochip()
            if detected_chip:
                logger.info(
                    "GPIO chip %s not found; auto-selected %s",
                    self._gpio_chip_name, detected_chip,
                )
                self._gpio_chip_name = detected_chip

        logger.info("Opening GPIO chip %s", self._gpio_chip_name)
        self._chip_fd = os.open(self._gpio_chip_name, os.O_RDWR | os.O_CLOEXEC)

        # Chip-select line for chip 2 (output, default high). Skipped when the
        # kernel SPI driver owns the line (e.g. Pi 5 in 8-ch mode); see profiles.py.
        if self._manage_cs:
            self._cs_fd = self._request_line(
                self._chip_fd, self._cs_pin, _GPIOHANDLE_REQUEST_OUTPUT,
                default_value=1, consumer=b"pieeg_cs")
        else:
            self._cs_fd = -1

        # Chip-select line for chip 3 (GPIO21, output, default high) — PiEEG-24 only
        if self._num_channels == 24:
            self._cs2_fd = self._request_line(
                self._chip_fd, self._cs_pin_2, _GPIOHANDLE_REQUEST_OUTPUT,
                default_value=1, consumer=b"pieeg_cs2")
        else:
            self._cs2_fd = -1

        # Data-ready line chip 1 (input)
        self._drdy_fd = self._request_line(
            self._chip_fd, self._drdy_pin, _GPIOHANDLE_REQUEST_INPUT,
            consumer=b"pieeg_drdy")

        # Data-ready line chip 2 (input) — for 16-ch and 24-ch modes
        if self._num_channels in (16, 24):
            self._drdy2_fd = self._request_line(
                self._chip_fd, self._drdy_pin_2, _GPIOHANDLE_REQUEST_INPUT,
                consumer=b"pieeg_drdy2")

        # Data-ready line chip 3 (input) — for 24-ch mode
        if self._num_channels == 24:
            self._drdy3_fd = self._request_line(
                self._chip_fd, self._drdy_pin_3, _GPIOHANDLE_REQUEST_INPUT,
                consumer=b"pieeg_drdy3")

    @staticmethod
    def _request_line(chip_fd: int, pin: int, flags: int,
                      default_value: int = 0, consumer: bytes = b"pieeg") -> int:
        """Request a single GPIO line via GPIO_GET_LINEHANDLE_IOCTL.

        Returns the file descriptor for the requested line handle.
        """
        # struct gpiohandle_request layout (364 bytes):
        #   0..255   lineoffsets[64]   (u32 × 64)
        #   256..259 flags             (u32)
        #   260..323 default_values[64](u8 × 64)
        #   324..355 consumer_label[32](char × 32)
        #   356..359 lines             (u32)
        #   360..363 fd                (i32)
        buf = bytearray(_HANDLE_REQUEST_SIZE)
        struct.pack_into("I", buf, 0, pin)          # lineoffsets[0]
        struct.pack_into("I", buf, 256, flags)       # flags
        buf[260] = default_value & 1                  # default_values[0]
        label = consumer[:32]
        buf[324:324 + len(label)] = label             # consumer_label
        struct.pack_into("I", buf, 356, 1)           # lines = 1
        fcntl.ioctl(chip_fd, _GPIO_GET_LINEHANDLE, buf)
        return struct.unpack_from("i", buf, 360)[0]  # fd

    def _init_spi(self):
        speed = self._spi_speed_hz
        logger.info("Initializing SPI at %d Hz (profile=%s)",
                    speed, self._profile.name)
        self._spi1 = spidev.SpiDev()
        self._spi1.open(0, 0)
        self._spi1.max_speed_hz = speed
        self._spi1.lsbfirst = False
        self._spi1.mode = SPI_MODE
        self._spi1.bits_per_word = SPI_BITS

        if self._num_channels in (16, 24):
            # Chips 2 and 3 are opened on spidev0.1 so the kernel toggles CE1
            # (GPIO7), keeping CE0 (chip 1) high while real CS (GPIO19 / GPIO21)
            # is driven manually.
            self._spi2 = spidev.SpiDev()
            self._spi2.open(0, 1)
            self._spi2.max_speed_hz = speed
            self._spi2.lsbfirst = False
            self._spi2.mode = SPI_MODE
            self._spi2.bits_per_word = SPI_BITS

    def _send_command(self, chip_num: int, command: int):
        if chip_num == 1:
            self._spi1.xfer([command])
        elif chip_num == 3:
            self._cs2_set(0)
            self._spi2.xfer([command])
            self._cs2_set(1)
        else:
            self._cs_set(0)
            self._spi2.xfer([command])
            self._cs_set(1)

    def _write_register(self, chip_num: int, register: int, value: int):
        data = [0x40 | register, 0x00, value]
        if chip_num == 1:
            self._spi1.xfer(data)
        elif chip_num == 3:
            self._cs2_set(0)
            self._spi2.xfer(data)
            self._cs2_set(1)
        else:
            self._cs_set(0)
            self._spi2.xfer(data)
            self._cs_set(1)

    def _configure_adc(self, chip_num: int):
        """Send the full initialization sequence to one ADC chip."""
        # On PiEEG-24, chip 1 (U5) must set CLK_EN (bit 5 -> 0xB6 @ 250 SPS)
        # so its internal oscillator drives the shared CLK net for chips 2 and 3.
        cfg1 = 0xB6 if (self._num_channels == 24 and chip_num == 1) else 0x96

        self._send_command(chip_num, CMD_WAKEUP)
        self._send_command(chip_num, CMD_STOP)
        self._send_command(chip_num, CMD_RESET)
        if self._num_channels == 24:
            time.sleep(0.002)
        self._send_command(chip_num, CMD_SDATAC)
        if self._num_channels == 24:
            time.sleep(0.001)
            if chip_num == 1:
                # RESET clears CLK_EN, so re-enable the clock output immediately
                self._write_register(chip_num, CONFIG1, cfg1)

        # Register configuration (matches original PiEEG scripts)
        self._write_register(chip_num, 0x14, 0x80)  # GPIO
        self._write_register(chip_num, CONFIG1, cfg1)
        self._write_register(chip_num, CONFIG2, 0xD4)
        self._write_register(chip_num, CONFIG3, 0xFF)
        self._write_register(chip_num, 0x04, 0x00)
        self._write_register(chip_num, 0x0D, 0x00)
        self._write_register(chip_num, 0x0E, 0x00)
        self._write_register(chip_num, 0x0F, 0x00)
        self._write_register(chip_num, 0x10, 0x00)
        self._write_register(chip_num, 0x11, 0x00)
        self._write_register(chip_num, 0x15, 0x20)
        self._write_register(chip_num, 0x17, 0x00)

        # Enable all 8 channels with default gain
        for ch_reg in (CH1SET, CH2SET, CH3SET, CH4SET,
                       CH5SET, CH6SET, CH7SET, CH8SET):
            self._write_register(chip_num, ch_reg, 0x00)

        if self._num_channels != 24:
            self._send_command(chip_num, CMD_RDATAC)
            self._send_command(chip_num, CMD_START)

    def _start_all_24(self):
        """Start all 3 ADS1299 chips in 3 -> 2 -> 1 order (PiEEG-24).

        Chip 1 starts LAST so with the shared clock its DRDY always falls after
        chips 2 and 3 already have their sample ready.
        """
        for chip in (3, 2, 1):
            self._send_command(chip, CMD_RDATAC)
        for chip in (3, 2, 1):
            self._send_command(chip, CMD_START)

    @staticmethod
    def _decode_channels(raw: list[int]) -> list[float]:
        """
        Decode 8 channels from a 27-byte SPI read.

        Bytes 0-2: status
        Bytes 3-26: 8 channels × 3 bytes (24-bit signed, MSB first)

        Uses the compiled ``pieeg_core.decode_channels`` (~30× faster) when
        available, with the pure-Python implementation below as the
        reference and fallback.
        """
        if _native.HAS_NATIVE:
            # Native path: Rust consumes the spidev byte list directly.
            return _native.decode_channels(raw)

        channels = []
        for i in range(3, 25, 3):
            raw_val = (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2]

            # Two's complement conversion for 24-bit signed values
            if raw_val | SIGN_TEST == FULL_SCALE:
                signed_val = raw_val - NEGATIVE_OFFSET
            else:
                signed_val = raw_val

            # Convert to microvolts: µV = 1e6 * 4.5 * (raw / (2^24 - 1))
            uv = round(VREF_UV * (signed_val / FULL_SCALE_PLUS_1), 2)
            channels.append(uv)

        return channels
