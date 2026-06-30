/**
 * PiEEG JavaScript SDK
 * 
 * Standalone library for connecting to IronBCI/IronBCI-32 devices via
 * Web Bluetooth and Web Serial, with built-in signal processing helpers.
 * 
 * @version 1.0.0
 * @license MIT
 * @see https://github.com/pieeg-club/PiEEG-server
 */

(function (global) {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════════════════════════

  const VERSION = '1.0.0';

  // Web Bluetooth constants (IronBCI 8-channel)
  const BLE_SERVICE_UUID = '0000fe40-cc7a-482a-984a-7f2ed5b3e58f';
  const BLE_NOTIFY_CHAR_UUID = '0000fe42-8e22-4541-9d4c-21edae82ed19';
  const BLE_NUM_CHANNELS = 8;
  const BLE_SAMPLE_RATE = 250;

  // Web Serial constants (IronBCI-32)
  const SERIAL_BAUD_RATE = 921600;
  const SERIAL_NUM_CHANNELS = 32;
  const SERIAL_SAMPLE_RATE = 500;
  const SERIAL_START_BYTE = 0xA0;
  const SERIAL_END_BYTE = 0xC0;

  // ADS1299 conversion (BLE)
  const ADS_VREF = 4.5;
  const ADS_FULL_SCALE = 16777215; // 2^24 - 1
  const ADS_SIGN_BIT = 0x800000;

  // AD7771 conversion (Serial)
  const AD7771_VREF = 2.5;
  const AD7771_GAIN = 8.0;
  const AD7771_FULL_SCALE = 8388607; // 2^23 - 1
  const AD7771_SIGN_BIT = 8388608; // 2^23

  // FFT / Band power
  const FFT_SIZE = 256;
  const FREQUENCY_BANDS = [
    { name: 'Delta', low: 0.5, high: 4, color: '#8b5cf6' },
    { name: 'Theta', low: 4, high: 8, color: '#3b82f6' },
    { name: 'Alpha', low: 8, high: 13, color: '#22c55e' },
    { name: 'Beta', low: 13, high: 30, color: '#f59e0b' },
    { name: 'Gamma', low: 30, high: 100, color: '#ef4444' },
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function isWebBluetoothSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  function isWebSerialSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ring Buffer
  // ═══════════════════════════════════════════════════════════════════════════

  class RingBuffer {
    constructor(size) {
      this.buffer = new Float64Array(size);
      this.size = size;
      this.writeIndex = 0;
      this.count = 0;
    }

    push(value) {
      this.buffer[this.writeIndex] = value;
      this.writeIndex = (this.writeIndex + 1) % this.size;
      if (this.count < this.size) this.count++;
    }

    get(index) {
      if (index >= this.count) return 0;
      const offset = (this.writeIndex - this.count + index + this.size) % this.size;
      return this.buffer[offset];
    }

    isFull() {
      return this.count >= this.size;
    }

    clear() {
      this.count = 0;
      this.writeIndex = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FFT Engine (Cooley-Tukey Radix-2)
  // ═══════════════════════════════════════════════════════════════════════════

  class FFTEngine {
    constructor(size, sampleRate) {
      if ((size & (size - 1)) !== 0) {
        throw new Error('FFT size must be a power of 2');
      }
      this.size = size;
      this.sampleRate = sampleRate;
      this.window = new Float64Array(size);
      this.real = new Float64Array(size);
      this.imag = new Float64Array(size);

      // Precompute Hanning window
      for (let i = 0; i < size; i++) {
        this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
      }
    }

    analyse(signal) {
      const N = this.size;

      // Apply window
      for (let i = 0; i < N; i++) {
        this.real[i] = signal[i] * this.window[i];
        this.imag[i] = 0;
      }

      // Bit-reversal permutation
      let j = 0;
      for (let i = 0; i < N; i++) {
        if (i < j) {
          [this.real[i], this.real[j]] = [this.real[j], this.real[i]];
          [this.imag[i], this.imag[j]] = [this.imag[j], this.imag[i]];
        }
        let k = N >> 1;
        while (k <= j) {
          j -= k;
          k >>= 1;
        }
        j += k;
      }

      // Cooley-Tukey FFT
      for (let len = 2; len <= N; len <<= 1) {
        const halfLen = len >> 1;
        const theta = (-2 * Math.PI) / len;
        const wReal = Math.cos(theta);
        const wImag = Math.sin(theta);

        for (let i = 0; i < N; i += len) {
          let uReal = 1;
          let uImag = 0;
          for (let k = 0; k < halfLen; k++) {
            const tReal = this.real[i + k + halfLen] * uReal - this.imag[i + k + halfLen] * uImag;
            const tImag = this.real[i + k + halfLen] * uImag + this.imag[i + k + halfLen] * uReal;
            this.real[i + k + halfLen] = this.real[i + k] - tReal;
            this.imag[i + k + halfLen] = this.imag[i + k] - tImag;
            this.real[i + k] += tReal;
            this.imag[i + k] += tImag;
            const tempU = uReal * wReal - uImag * wImag;
            uImag = uReal * wImag + uImag * wReal;
            uReal = tempU;
          }
        }
      }

      // Compute PSD (Power Spectral Density)
      const psd = new Float64Array(N / 2);
      const freqs = new Float64Array(N / 2);
      for (let i = 0; i < N / 2; i++) {
        const re = this.real[i];
        const im = this.imag[i];
        psd[i] = (re * re + im * im) / (N * this.sampleRate);
        freqs[i] = (i * this.sampleRate) / N;
      }

      // Extract band powers
      const bandPowers = {};
      for (const band of FREQUENCY_BANDS) {
        let power = 0;
        let count = 0;
        for (let i = 0; i < freqs.length; i++) {
          if (freqs[i] >= band.low && freqs[i] <= band.high) {
            power += psd[i];
            count++;
          }
        }
        bandPowers[band.name] = count > 0 ? power / count : 0;
      }

      // Total power and dominant frequency
      let totalPower = 0;
      let maxPower = 0;
      let dominantFreq = 0;
      for (let i = 0; i < psd.length; i++) {
        totalPower += psd[i];
        if (psd[i] > maxPower) {
          maxPower = psd[i];
          dominantFreq = freqs[i];
        }
      }

      return { psd, freqs, bandPowers, totalPower, dominantFreq };
    }

    analyseRing(ringBuffer) {
      if (!ringBuffer.isFull()) return null;
      const signal = new Float64Array(this.size);
      for (let i = 0; i < this.size; i++) {
        signal[i] = ringBuffer.get(ringBuffer.count - this.size + i);
      }
      return this.analyse(signal);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Serial Frame Parser (IronBCI-32)
  // ═══════════════════════════════════════════════════════════════════════════

  class SerialFrameParser {
    constructor() {
      this.rxBuffer = [];
      this.frameSize = null;
      this.droppedBytes = 0;
    }

    detectFrameSize(buf) {
      const starts = [];
      for (let i = 1; i < buf.length; i++) {
        if (buf[i] === SERIAL_START_BYTE && buf[i - 1] === SERIAL_END_BYTE) {
          starts.push(i);
          if (starts.length >= 3) {
            const dLast = starts[starts.length - 1] - starts[starts.length - 2];
            const dPrev = starts[starts.length - 2] - starts[starts.length - 3];
            if (dLast === dPrev && dLast >= 99 && dLast <= 131) {
              return dLast;
            }
          }
        }
      }
      return null;
    }

    decodeFrame(frame) {
      const channels = [];
      const base = 2; // Skip 0xA0 + counter
      for (let ch = 0; ch < SERIAL_NUM_CHANNELS; ch++) {
        const off = base + ch * 3;
        let raw = (frame[off] << 16) | (frame[off + 1] << 8) | frame[off + 2];
        if (raw & AD7771_SIGN_BIT) raw -= 16777216; // 2^24
        const uv = (AD7771_VREF / AD7771_FULL_SCALE / AD7771_GAIN) * raw * 1000000;
        channels.push(Math.round(uv * 100) / 100);
      }
      return channels;
    }

    push(chunk, onSample) {
      for (let i = 0; i < chunk.length; i++) {
        this.rxBuffer.push(chunk[i]);
      }
      if (this.rxBuffer.length > 16384) {
        this.rxBuffer.splice(0, this.rxBuffer.length - 8192);
      }

      // Auto-detect frame size
      if (this.frameSize === null) {
        this.frameSize = this.detectFrameSize(this.rxBuffer);
        if (this.frameSize === null) return;
      }

      // Align to first valid frame start
      let start = -1;
      for (let i = 0; i < this.rxBuffer.length; i++) {
        if (this.rxBuffer[i] === SERIAL_START_BYTE && 
            (i === 0 || this.rxBuffer[i - 1] === SERIAL_END_BYTE)) {
          start = i;
          break;
        }
      }
      if (start < 0) return;
      if (start > 0) this.rxBuffer.splice(0, start);

      // Drain complete frames
      while (this.frameSize && this.rxBuffer.length >= this.frameSize) {
        if (this.rxBuffer[0] !== SERIAL_START_BYTE || 
            this.rxBuffer[this.frameSize - 1] !== SERIAL_END_BYTE) {
          this.droppedBytes++;
          this.rxBuffer.splice(0, 1);
          if (this.droppedBytes % 64 === 0) this.frameSize = null;
          break;
        }
        const frame = this.rxBuffer.slice(0, this.frameSize);
        this.rxBuffer.splice(0, this.frameSize);
        try {
          const channels = this.decodeFrame(frame);
          onSample(channels, Date.now() / 1000);
        } catch (err) {
          this.droppedBytes++;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Main PiEEG Class
  // ═══════════════════════════════════════════════════════════════════════════

  class PiEEG {
    constructor(options = {}) {
      this.options = {
        fftSize: options.fftSize || FFT_SIZE,
        updateHz: options.updateHz || 12,
        bufferSeconds: options.bufferSeconds || 4,
        ...options,
      };

      // Connection state
      this.device = null;
      this.port = null;
      this.connected = false;
      this.deviceType = null; // 'ble' or 'serial'
      this.numChannels = 0;
      this.sampleRate = 0;

      // Data buffers
      this.channelBuffers = [];
      this.fftEngine = null;
      this.updateTimer = null;

      // Callbacks
      this.onDataCallback = null;
      this.onBandPowersCallback = null;
      this.onErrorCallback = null;
      this.onDisconnectCallback = null;

      // BLE event listener references (for clean removal on disconnect)
      this._bleOnValueChanged = null;
      this._bleOnDisconnect = null;

      // Statistics
      this.samplesReceived = 0;
      this.lastBandPowers = null;
      this.lastSpectrum = null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Connection Methods
    // ═════════════════════════════════════════════════════════════════════════

    async connectBLE() {
      if (!isWebBluetoothSupported()) {
        throw new Error('Web Bluetooth not supported. Use Chrome/Edge over HTTPS.');
      }

      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'EAREEG' },
          { namePrefix: 'IronBCI' },
        ],
        optionalServices: [BLE_SERVICE_UUID],
      });

      if (!device.gatt) {
        throw new Error('Device does not support GATT.');
      }

      const server = await device.gatt.connect();
      
      let characteristic = null;
      try {
        const service = await server.getPrimaryService(BLE_SERVICE_UUID);
        characteristic = await service.getCharacteristic(BLE_NOTIFY_CHAR_UUID);
      } catch {
        const services = await server.getPrimaryServices();
        for (const service of services) {
          const chars = await service.getCharacteristics();
          const found = chars.find(c => c.uuid === BLE_NOTIFY_CHAR_UUID);
          if (found) {
            characteristic = found;
            break;
          }
        }
      }

      if (!characteristic) {
        throw new Error('IronBCI characteristic not found.');
      }

      this.device = device;
      this.characteristic = characteristic;
      this.deviceType = 'ble';
      this.numChannels = BLE_NUM_CHANNELS;
      this.sampleRate = BLE_SAMPLE_RATE;

      this._initBuffers();

      const onValueChanged = (event) => {
        const value = event.target.value;
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const samples = this._parseBLESamples(bytes);
        const t = Date.now() / 1000;
        for (const sample of samples) {
          this._ingestSample(sample, t);
        }
      };

      const onDisconnect = () => {
        this.connected = false;
        if (this.onDisconnectCallback) this.onDisconnectCallback();
      };

      this._bleOnValueChanged = onValueChanged;
      this._bleOnDisconnect = onDisconnect;
      device.addEventListener('gattserverdisconnected', onDisconnect);
      characteristic.addEventListener('characteristicvaluechanged', onValueChanged);
      await characteristic.startNotifications();

      this.connected = true;
      this._startProcessing();

      return {
        deviceName: device.name || 'IronBCI',
        channels: this.numChannels,
        sampleRate: this.sampleRate,
      };
    }

    async connectSerial() {
      if (!isWebSerialSupported()) {
        throw new Error('Web Serial not supported. Use Chrome/Edge over HTTPS or localhost.');
      }

      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: SERIAL_BAUD_RATE });

      const reader = port.readable.getReader();
      const parser = new SerialFrameParser();

      this.port = port;
      this.reader = reader;
      this.deviceType = 'serial';
      this.numChannels = SERIAL_NUM_CHANNELS;
      this.sampleRate = SERIAL_SAMPLE_RATE;

      this._initBuffers();

      const readLoop = async () => {
        try {
          while (this.connected) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) {
              parser.push(value, (channels, t) => this._ingestSample(channels, t));
            }
          }
        } catch (err) {
          if (this.onErrorCallback) this.onErrorCallback(err);
        } finally {
          // Stream ended or errored: mark disconnected so processing stops
          // and getStats() reports the correct state. Only fire the callback
          // for unexpected disconnects (an explicit disconnect() already
          // cleared `connected`).
          if (this.connected) {
            this.connected = false;
            if (this.onDisconnectCallback) {
              this.onDisconnectCallback();
            }
          }
        }
      };

      this.connected = true;
      this._startProcessing();
      readLoop();

      return {
        deviceName: 'IronBCI-32',
        channels: this.numChannels,
        sampleRate: this.sampleRate,
      };
    }

    disconnect() {
      this.connected = false;

      if (this.updateTimer) {
        clearInterval(this.updateTimer);
        this.updateTimer = null;
      }

      if (this.deviceType === 'ble' && this.characteristic) {
        if (this._bleOnValueChanged) {
          this.characteristic.removeEventListener('characteristicvaluechanged', this._bleOnValueChanged);
        }
        if (this.device && this._bleOnDisconnect) {
          this.device.removeEventListener('gattserverdisconnected', this._bleOnDisconnect);
        }
        this._bleOnValueChanged = null;
        this._bleOnDisconnect = null;
        this.characteristic.stopNotifications().catch(() => {});
        if (this.device?.gatt?.connected) {
          this.device.gatt.disconnect();
        }
      } else if (this.deviceType === 'serial') {
        if (this.reader) {
          const reader = this.reader;
          // releaseLock() can throw if a read() is still pending, so wait for
          // cancellation to resolve before releasing.
          reader.cancel().catch(() => {}).finally(() => {
            try { reader.releaseLock(); } catch { /* already released */ }
          });
        }
        if (this.port) {
          this.port.close().catch(() => {});
        }
      }

      this.device = null;
      this.port = null;
      this.deviceType = null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Event Listeners
    // ═════════════════════════════════════════════════════════════════════════

    onData(callback) {
      this.onDataCallback = callback;
    }

    onBandPowers(callback) {
      this.onBandPowersCallback = callback;
    }

    onError(callback) {
      this.onErrorCallback = callback;
    }

    onDisconnect(callback) {
      this.onDisconnectCallback = callback;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Neural State Helpers
    // ═════════════════════════════════════════════════════════════════════════

    getRelaxationIndex() {
      if (!this.lastBandPowers) return 0;
      const alpha = this.lastBandPowers.Alpha || 0;
      const beta = this.lastBandPowers.Beta || 0;
      const sum = alpha + beta;
      return sum > 0 ? alpha / sum : 0.5;
    }

    getFocusIndex() {
      if (!this.lastBandPowers) return 0;
      const beta = this.lastBandPowers.Beta || 0;
      const theta = this.lastBandPowers.Theta || 0;
      const sum = beta + theta;
      return sum > 0 ? beta / sum : 0.5;
    }

    getMeditationIndex() {
      if (!this.lastBandPowers) return 0;
      const theta = this.lastBandPowers.Theta || 0;
      const alpha = this.lastBandPowers.Alpha || 0;
      let total = 0;
      for (const band of FREQUENCY_BANDS) {
        total += this.lastBandPowers[band.name] || 0;
      }
      return total > 0 ? (theta + alpha) / total : 0;
    }

    isFocused(threshold = 0.6) {
      return this.getFocusIndex() > threshold;
    }

    isRelaxed(threshold = 0.6) {
      return this.getRelaxationIndex() > threshold;
    }

    getBandPower(bandName) {
      if (!this.lastBandPowers) return 0;
      return this.lastBandPowers[bandName] || 0;
    }

    getBandPowers() {
      return this.lastBandPowers ? { ...this.lastBandPowers } : null;
    }

    getSpectrum() {
      return this.lastSpectrum ? { ...this.lastSpectrum } : null;
    }

    getStats() {
      return {
        connected: this.connected,
        deviceType: this.deviceType,
        numChannels: this.numChannels,
        sampleRate: this.sampleRate,
        samplesReceived: this.samplesReceived,
        bufferFill: this.channelBuffers.length > 0 
          ? this.channelBuffers[0].count / this.channelBuffers[0].size 
          : 0,
      };
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Internal Methods
    // ═════════════════════════════════════════════════════════════════════════

    _initBuffers() {
      const bufferSize = Math.ceil(this.sampleRate * this.options.bufferSeconds);
      this.channelBuffers = [];
      for (let i = 0; i < this.numChannels; i++) {
        this.channelBuffers.push(new RingBuffer(bufferSize));
      }
      this.fftEngine = new FFTEngine(this.options.fftSize, this.sampleRate);
      this.samplesReceived = 0;
    }

    _parseBLESamples(bytes) {
      const samples = [];
      const bytesPerSample = BLE_NUM_CHANNELS * 3;
      const sampleCount = Math.floor(bytes.length / bytesPerSample);

      for (let s = 0; s < sampleCount; s++) {
        const base = s * bytesPerSample;
        const channels = [];
        for (let ch = 0; ch < BLE_NUM_CHANNELS; ch++) {
          const offset = base + ch * 3;
          let raw = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
          if (raw >= ADS_SIGN_BIT) raw -= (ADS_FULL_SCALE + 1);
          const uv = 1000000 * ADS_VREF * (raw / ADS_FULL_SCALE);
          channels.push(Math.round(uv * 100) / 100);
        }
        samples.push(channels);
      }

      return samples;
    }

    _ingestSample(channels, timestamp) {
      for (let i = 0; i < this.numChannels && i < channels.length; i++) {
        this.channelBuffers[i].push(channels[i]);
      }
      this.samplesReceived++;

      if (this.onDataCallback) {
        try {
          this.onDataCallback(channels, timestamp);
        } catch (err) {
          if (this.onErrorCallback) this.onErrorCallback(err);
        }
      }
    }

    _startProcessing() {
      // Clear any existing loop so repeated connect*() calls don't stack timers.
      if (this.updateTimer) {
        clearInterval(this.updateTimer);
        this.updateTimer = null;
      }

      const intervalMs = Math.round(1000 / this.options.updateHz);

      this.updateTimer = setInterval(() => {
        if (!this.connected) return;

        // Average band powers across all channels
        const sumBandPowers = {};
        for (const band of FREQUENCY_BANDS) {
          sumBandPowers[band.name] = 0;
        }

        let validChannels = 0;
        let lastResult = null;

        for (let ch = 0; ch < this.numChannels; ch++) {
          const result = this.fftEngine.analyseRing(this.channelBuffers[ch]);
          if (result) {
            validChannels++;
            lastResult = result;
            for (const band of FREQUENCY_BANDS) {
              sumBandPowers[band.name] += result.bandPowers[band.name];
            }
          }
        }

        if (validChannels > 0) {
          const avgBandPowers = {};
          for (const band of FREQUENCY_BANDS) {
            avgBandPowers[band.name] = sumBandPowers[band.name] / validChannels;
          }

          this.lastBandPowers = avgBandPowers;
          this.lastSpectrum = lastResult;

          if (this.onBandPowersCallback) {
            try {
              this.onBandPowersCallback(avgBandPowers);
            } catch (err) {
              if (this.onErrorCallback) this.onErrorCallback(err);
            }
          }
        }
      }, intervalMs);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Export
  // ═══════════════════════════════════════════════════════════════════════════

  PiEEG.VERSION = VERSION;
  PiEEG.isWebBluetoothSupported = isWebBluetoothSupported;
  PiEEG.isWebSerialSupported = isWebSerialSupported;
  PiEEG.FREQUENCY_BANDS = FREQUENCY_BANDS;

  // Export to global scope
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PiEEG;
  } else {
    global.PiEEG = PiEEG;
  }

})(typeof window !== 'undefined' ? window : this);
