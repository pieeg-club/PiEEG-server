"""
Low-level hardware interface for PiEEG.

Manages one or two ADS1299 ADC chips via SPI (8 channels each)
and GPIO lines for chip-select and data-ready signaling.

Requires: spidev (pip), Linux GPIO chardev (kernel, no pip package needed)
Must run on Raspberry Pi with SPI enabled and PiEEG shield connected.
"""

import logging
import os
import struct
import sys

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
CS_PIN = 19
DRDY_PIN = 26      # DRDY chip 1
DRDY_PIN_2 = 13    # DRDY chip 2

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
_GPIO_GET_LINEHANDLE  = 0xC16CB403   # _IOWR(0xB4, 0x03, 364) – gpiohandle_request
_GPIOHANDLE_GET_VALUES = 0xC040B408  # _IOWR(0xB4, 0x08, 64)  – gpiohandle_data
_GPIOHANDLE_SET_VALUES = 0xC040B409  # _IOWR(0xB4, 0x09, 64)  – gpiohandle_data
_GPIOHANDLE_REQUEST_INPUT  = 1 << 0
_GPIOHANDLE_REQUEST_OUTPUT = 1 << 1
_HANDLE_REQUEST_SIZE = 364  # sizeof(struct gpiohandle_request)
_HANDLE_DATA_SIZE    = 64   # sizeof(struct gpiohandle_data)


class PiEEGHardware:
    """Hardware abstraction for PiEEG shields (8 or 16 channels)."""

    # Channel register addresses for convenience
    CH_REGS = (CH1SET, CH2SET, CH3SET, CH4SET, CH5SET, CH6SET, CH7SET, CH8SET)

    def __init__(self, gpio_chip: str | None = None,
                 num_channels: int = 16,
                 profile: HardwareProfile | str | None = None):
        if num_channels not in (8, 16):
            raise ValueError(f"num_channels must be 8 or 16, got {num_channels}")
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
        # GPIO line offsets come from the profile (Pi defaults = 19/26/13).
        self._cs_pin = self._profile.cs_pin
        self._drdy_pin = self._profile.drdy_pin
        self._drdy_pin_2 = self._profile.drdy_pin_2
        # 16-ch mode always needs GPIO19 toggling for chip 2's CS line,
        # regardless of the profile's manage_cs_pin setting.
        self._manage_cs = self._profile.manage_cs_pin or num_channels == 16
        if num_channels == 16 and not self._profile.manage_cs_pin:
            logger.warning(
                "Profile %r disables CS pin management, but 16-channel mode "
                "requires GPIO%d for chip 2. Forcing CS management on.",
                self._profile.name, self._cs_pin,
            )
        self._chip_fd = -1
        self._cs_fd = -1
        self._drdy_fd = -1
        self._drdy2_fd = -1
        self._spi1 = None
        self._spi2 = None
        self._last_valid_value: int | None = None
        self._spike_count = 0
        self._consecutive_rejects = 0
        self._spike_threshold = SPIKE_THRESHOLD
        self._spike_reset_after = SPIKE_RESET_AFTER
        self._register_state: dict[int, int] = {}
        # Starts at the profile's hard default; only changes if a caller
        # explicitly assigns a new value. Legacy behavior is unchanged.
        self._spi_speed_hz = self._profile.spi_speed_hz

    @property
    def num_channels(self) -> int:
        return self._num_channels

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

    @property
    def spike_reset_after(self) -> int:
        return self._spike_reset_after

    @spike_reset_after.setter
    def spike_reset_after(self, value: int):
        self._spike_reset_after = max(1, int(value))

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

    # --- lifecycle ---

    def open(self):
        """Initialize GPIO and SPI, configure ADC chip(s)."""
        _require_hardware_libs()
        self._init_gpio()
        self._init_spi()
        self._configure_adc(chip_num=1)
        if self._num_channels == 16:
            self._configure_adc(chip_num=2)

    def close(self):
        """Release all hardware resources."""
        if self._spi1:
            self._spi1.close()
        if self._spi2 and self._num_channels == 16:
            self._spi2.close()
        if self._cs_fd >= 0:
            os.close(self._cs_fd)
            self._cs_fd = -1
        if self._drdy_fd >= 0:
            os.close(self._drdy_fd)
            self._drdy_fd = -1
        if self._drdy2_fd >= 0:
            os.close(self._drdy2_fd)
            self._drdy2_fd = -1
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
        Read one sample from the ADC (8 or 16 channels).

        Returns None on status header mismatch.
        Returns a list of floats (microvolts) on success.

        Caller (acquisition loop) is responsible for DRDY polling.
        """
        # Read 27 bytes from ADC chip 1
        raw1 = self._spi1.readbytes(BYTES_PER_READ)

        if self._num_channels == 16:
            # Wait for chip 2 DRDY falling edge before reading
            self._wait_drdy2()
            self._cs_set(0)
            raw2 = self._spi2.readbytes(BYTES_PER_READ)
            self._cs_set(1)

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

        Applies to both chips in 16-ch mode, chip 1 only in 8-ch mode.
        Updates the shadow register state.
        Resets spike filter baseline so the first post-config frames aren't
        rejected due to the signal level changing (e.g. normal → shorted).
        """
        chips = [1, 2] if self._num_channels == 16 else [1]
        for chip in chips:
            self._send_command(chip, CMD_STOP)
            self._send_command(chip, CMD_SDATAC)
            for addr, value in reg_map.items():
                self._write_register(chip, int(addr), int(value) & 0xFF)
            self._send_command(chip, CMD_RDATAC)
            self._send_command(chip, CMD_START)
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
        """Set chip-select line: 1 = high (deselect), 0 = low (select).

        No-op when the active profile delegates CS to the kernel SPI driver
        (e.g. Pi 5 in 8-channel mode). In 16-channel mode this always toggles
        GPIO19 because chip 2's CS is wired there on the PiEEG shield.
        """
        if not self._manage_cs or self._cs_fd < 0:
            return
        buf = bytearray(_HANDLE_DATA_SIZE)
        buf[0] = value & 1
        fcntl.ioctl(self._cs_fd, _GPIOHANDLE_SET_VALUES, buf)

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

    def _wait_drdy2(self):
        """Block until chip 2 DRDY goes LOW (falling edge = data ready)."""
        while self._drdy2_get() == 0:   # wait out previous low
            pass
        while self._drdy2_get() == 1:   # wait for HIGH→LOW
            pass

    # --- private helpers ---

    def _init_gpio(self):
        """Initialize GPIO via Linux chardev v1 ioctl (no gpiod dependency)."""
        logger.info("Opening GPIO chip %s", self._gpio_chip_name)
        self._chip_fd = os.open(self._gpio_chip_name, os.O_RDWR | os.O_CLOEXEC)

        # Chip-select line (output, default high). Skipped when the kernel
        # SPI driver owns the line (e.g. Pi 5 in 8-ch mode); see profiles.py.
        if self._manage_cs:
            self._cs_fd = self._request_line(
                self._chip_fd, self._cs_pin, _GPIOHANDLE_REQUEST_OUTPUT,
                default_value=1, consumer=b"pieeg_cs")
        else:
            self._cs_fd = -1

        # Data-ready line chip 1 (input)
        self._drdy_fd = self._request_line(
            self._chip_fd, self._drdy_pin, _GPIOHANDLE_REQUEST_INPUT,
            consumer=b"pieeg_drdy")

        # Data-ready line chip 2 (input) — only for 16-ch mode
        if self._num_channels == 16:
            self._drdy2_fd = self._request_line(
                self._chip_fd, self._drdy_pin_2, _GPIOHANDLE_REQUEST_INPUT,
                consumer=b"pieeg_drdy2")

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

        if self._num_channels == 16:
            self._spi2 = spidev.SpiDev()
            self._spi2.open(0, 1)
            self._spi2.max_speed_hz = speed
            self._spi2.lsbfirst = False
            self._spi2.mode = SPI_MODE
            self._spi2.bits_per_word = SPI_BITS

    def _send_command(self, chip_num: int, command: int):
        if chip_num == 1:
            self._spi1.xfer([command])
        else:
            self._cs_set(0)
            self._spi2.xfer([command])
            self._cs_set(1)

    def _write_register(self, chip_num: int, register: int, value: int):
        data = [0x40 | register, 0x00, value]
        if chip_num == 1:
            self._spi1.xfer(data)
        else:
            self._cs_set(0)
            self._spi2.xfer(data)
            self._cs_set(1)

    def _configure_adc(self, chip_num: int):
        """Send the full initialization sequence to one ADC chip."""
        self._send_command(chip_num, CMD_WAKEUP)
        self._send_command(chip_num, CMD_STOP)
        self._send_command(chip_num, CMD_RESET)
        self._send_command(chip_num, CMD_SDATAC)

        # Register configuration (matches original PiEEG scripts)
        self._write_register(chip_num, 0x14, 0x80)  # GPIO
        self._write_register(chip_num, CONFIG1, 0x96)
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

        self._send_command(chip_num, CMD_RDATAC)
        self._send_command(chip_num, CMD_START)

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
