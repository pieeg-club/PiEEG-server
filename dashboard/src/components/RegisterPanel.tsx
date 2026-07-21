import { useState, useCallback, useEffect, useRef } from "react";

interface RegisterPanelProps {
  open: boolean;
  onClose: () => void;
  numChannels: number;
  sendCommand: (cmd: Record<string, unknown>) => void;
}

interface NoiseTestResult {
  rms: number[];
  max_rms: number;
  verdict: string;
  recommendation: string;
  duration: number;
  samples_collected: number;
}

const CH_OPTIONS: { value: number; label: string }[] = [
  { value: 0x00, label: "Normal electrode" },
  { value: 0x01, label: "Input shorted (noise test)" },
  { value: 0x02, label: "Bias measurement" },
  { value: 0x04, label: "Temperature sensor" },
  { value: 0x05, label: "Test signal" },
];

const PRESETS = [
  { id: "normal", label: "Normal", value: 0x00 },
  { id: "internal_short", label: "Internal Short", value: 0x01 },
  { id: "test_signal", label: "Test Signal", value: 0x05 },
  { id: "temp_sensor", label: "Temp Sensor", value: 0x04 },
] as const;

const NUM_CH_REGS = 8;
const CH_REG_BASE = 0x05; // CH1SET

// PiEEG shield only. 
const SPI_SPEED_OPTIONS: { value: number; label: string }[] = [
  { value: 4_000_000, label: "4 MHz (default)" },
  { value: 2_000_000, label: "2 MHz" },
  { value: 1_000_000, label: "1 MHz " },
  { value: 500_000, label: "500 kHz" },
];

export default function RegisterPanel({
  open,
  onClose,
  numChannels,
  sendCommand,
}: RegisterPanelProps) {
  const chCount = Math.min(numChannels, NUM_CH_REGS);
  const is16ch = numChannels > 8;
  const [chValues, setChValues] = useState<number[]>(() =>
    Array(NUM_CH_REGS).fill(0x00)
  );
  const [noiseResult, setNoiseResult] = useState<NoiseTestResult | null>(null);
  const [noiseRunning, setNoiseRunning] = useState(false);
  const [activePreset, setActivePreset] = useState<string>("normal");
  // SPI clock speed (Hz). null until the server reports it — non-shield
  // backends never report it, so the control stays hidden for them.
  const [spiSpeed, setSpiSpeed] = useState<number | null>(null);

  // Listen for reg_config and noise_test_result messages from server
  useEffect(() => {
    const handler = (msg: Record<string, unknown>) => {
      if ("reg_config" in msg) {
        const cfg = msg.reg_config as { regs?: Record<string, string>; status?: string };
        if (cfg?.regs) {
          const next = [...chValues];
          for (const [hexAddr, hexVal] of Object.entries(cfg.regs)) {
            const addr = parseInt(hexAddr, 16);
            if (addr >= CH_REG_BASE && addr < CH_REG_BASE + NUM_CH_REGS) {
              next[addr - CH_REG_BASE] = parseInt(hexVal, 16);
            }
          }
          setChValues(next);
          // Detect active preset
          const preset = PRESETS.find((p) => next.slice(0, chCount).every((v) => v === p.value));
          setActivePreset(preset?.id ?? "");
        }
      }
      if ("noise_test_result" in msg) {
        setNoiseResult(msg.noise_test_result as NoiseTestResult);
        setNoiseRunning(false);
      }
      if ("noise_test_status" in msg) {
        if (msg.noise_test_status === "running") setNoiseRunning(true);
        if (msg.noise_test_status === "busy") setNoiseRunning(false);
      }
      if ("spi_config" in msg) {
        const sc = msg.spi_config as { speed_hz?: number };
        if (typeof sc?.speed_hz === "number") setSpiSpeed(sc.speed_hz);
      }
    };
    (window as unknown as Record<string, unknown>).__regHandler = handler;
    return () => {
      delete (window as unknown as Record<string, unknown>).__regHandler;
    };
  }, [chValues, chCount]);

  // Sync register state from server when panel opens
  useEffect(() => {
    if (open) {
      sendCommand({ cmd: "reg_read" });
      sendCommand({ cmd: "spi_config" }); // request current SPI speed (shield only)
    }
  }, [open, sendCommand]);

  const handlePreset = useCallback(
    (presetId: string) => {
      sendCommand({ cmd: "reg_preset", preset: presetId });
      setActivePreset(presetId);
      const preset = PRESETS.find((p) => p.id === presetId);
      if (preset) {
        setChValues(Array(NUM_CH_REGS).fill(preset.value));
      }
      setNoiseResult(null);
    },
    [sendCommand]
  );

  const handleChChange = useCallback((chIdx: number, value: number) => {
    setChValues((prev) => {
      const next = [...prev];
      next[chIdx] = value;
      return next;
    });
    setActivePreset("");
  }, []);

  const handleApply = useCallback(() => {
    const regs: Record<string, number> = {};
    for (let i = 0; i < chCount; i++) {
      regs[`0x${(CH_REG_BASE + i).toString(16).padStart(2, "0")}`] = chValues[i];
    }
    sendCommand({ cmd: "reg_write", regs });
    setNoiseResult(null);
  }, [chValues, chCount, sendCommand]);

  const handleNoiseTest = useCallback(() => {
    setNoiseResult(null);
    setNoiseRunning(true);
    sendCommand({ cmd: "noise_test", duration: 3 });
  }, [sendCommand]);

  const handleSpiChange = useCallback(
    (speedHz: number) => {
      setSpiSpeed(speedHz);
      sendCommand({ cmd: "spi_config", config: { speed_hz: speedHz } });
    },
    [sendCommand]
  );

  if (!open) return null;

  const verdictIcon =
    noiseResult == null
      ? ""
      : noiseResult.max_rms < 5
        ? "✅"
        : noiseResult.max_rms > 15
          ? "❌"
          : "⚠️";

  return (
    <div className="register-panel">
      <div className="register-panel-header">
        <strong>ADS1299 Registers{is16ch ? " (×2 chips)" : ""}</strong>
        <button className="register-panel-close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="register-panel-body">
        {/* Presets */}
        <div className="register-presets">
          <span className="register-label">Presets:</span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`btn btn-sm${activePreset === p.id ? " active" : ""}`}
              onClick={() => handlePreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Channel registers */}
        <div className="register-channels">
          {Array.from({ length: chCount }, (_, i) => (
            <div key={i} className="register-ch-row">
              <span className="register-ch-label">
                CH{i + 1}{is16ch ? `+${i + 9}` : ""}SET:
              </span>
              <select
                value={chValues[i]}
                onChange={(e) => handleChChange(i, parseInt(e.target.value))}
              >
                {CH_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    0x{opt.value.toString(16).padStart(2, "0")} — {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <button className="btn btn-apply" onClick={handleApply}>
          Apply
        </button>

        {/* Noise Diagnostic */}
        <div className="register-divider">Noise Diagnostic</div>

        <button
          className={`btn btn-noise-test${noiseRunning ? " running" : ""}`}
          onClick={handleNoiseTest}
          disabled={noiseRunning}
        >
          {noiseRunning ? "Running…" : "▶ Run Noise Test"}{" "}
          <span className="noise-hint">(~5 seconds)</span>
        </button>

        {noiseResult && (
          <div className="noise-result">
            <div className="noise-verdict">
              <span className="noise-icon">{verdictIcon}</span>
              <span>{noiseResult.verdict}</span>
            </div>
            <div className="noise-rms">
              {noiseResult.rms.slice(0, numChannels).map((v, i) => (
                <span
                  key={i}
                  className={`noise-rms-ch${v > 15 ? " bad" : v > 5 ? " marginal" : " good"}`}
                >
                  CH{i + 1}: ±{v} µV
                </span>
              ))}
            </div>
            <p className="noise-recommendation">{noiseResult.recommendation}</p>
          </div>
        )}

        {/* SPI Clock — PiEEG shield only (hidden unless the server reports it) */}
        {spiSpeed !== null && (
          <>
            <div className="register-divider">SPI Clock</div>
            <div className="register-ch-row">
              <span className="register-ch-label">Speed:</span>
              <select
                value={spiSpeed}
                onChange={(e) => handleSpiChange(parseInt(e.target.value))}
              >
                {SPI_SPEED_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="noise-recommendation">
              Leave at the default unless channels show broadband noise. Lowering
              to 1 MHz can fix noisy readings on some rpi boards; it does not affect
              the sample rate.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
