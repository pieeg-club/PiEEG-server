import { describe, it, expect } from "vitest";
import { assessCalibration, contactColor, CONTACT_META } from "../../lib/calibration";
import { CALIB_LAYOUTS, defaultLayoutId, getLayout } from "../../lib/calibrationLayouts";
import type { EEGData } from "../../types";

function makeEEGData(numChannels: number, bufferSize: number, samplesInBuffer: number, fillFn: (ch: number, idx: number) => number): EEGData {
  const bufs: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const arr = new Float32Array(bufferSize);
    for (let i = 0; i < bufferSize; i++) {
      arr[i] = fillFn(ch, i);
    }
    bufs.push(arr);
  }
  return {
    buffers: { current: bufs },
    writeIndex: { current: samplesInBuffer % bufferSize },
    samplesInBuffer: { current: samplesInBuffer },
    bufferSize,
    numChannels,
    gridSuspended: false,
  };
}

describe("calibration", () => {
  it("reports off when buffer has not filled window", () => {
    const eeg = makeEEGData(8, 500, 10, () => 20);
    const report = assessCalibration(eeg, 250, 60, 2);
    expect(report.overall).toBe("off");
    expect(report.ready).toBe(0);
    expect(report.total).toBe(8);
    expect(report.perChannel.every((c) => c.status === "off")).toBe(true);
  });

  it("classifies clean alpha sine wave as good contact", () => {
    const sr = 250;
    const eeg = makeEEGData(8, 1000, 1000, (_ch, i) => 25 * Math.sin((2 * Math.PI * 10 * i) / sr));
    const report = assessCalibration(eeg, sr, 60, 2);
    expect(report.overall).toBe("good");
    expect(report.ready).toBe(8);
    for (const c of report.perChannel) {
      expect(c.status).toBe("good");
      expect(c.p2p).toBeGreaterThan(40);
      expect(c.snrDb).toBeGreaterThan(18);
    }
  });

  it("classifies railed high-amplitude signal as railed", () => {
    const sr = 250;
    const eeg = makeEEGData(8, 1000, 1000, (_ch, i) => 600 * Math.sin((2 * Math.PI * 10 * i) / sr));
    const report = assessCalibration(eeg, sr, 60, 2);
    expect(report.perChannel[0].status).toBe("railed");
    expect(report.overall).toBe("poor");
  });

  it("detects heavy 60 Hz line noise as poor contact", () => {
    const sr = 250;
    const eeg = makeEEGData(8, 1000, 1000, (_ch, i) => 30 * Math.sin((2 * Math.PI * 60 * i) / sr));
    const report = assessCalibration(eeg, sr, 60, 2);
    expect(report.perChannel[0].status).toBe("poor");
    expect(report.perChannel[0].lineUv).toBeGreaterThan(20);
  });

  it("returns grey for off and interpolates RGB for live contact", () => {
    expect(contactColor("off", 0.8)).toBe("#6b7280");
    expect(contactColor("good", 1)).toBe("rgb(0, 200, 83)");
    expect(contactColor("poor", 0)).toBe("rgb(238, 68, 68)");
    expect(CONTACT_META.good.label).toBe("Good");
  });
});

describe("calibrationLayouts", () => {
  it("selects appropriate default layout for hardware kind and channel count", () => {
    expect(defaultLayoutId("xr", 8)).toBe("xr");
    expect(defaultLayoutId("octopus", 16)).toBe("octopus");
    expect(defaultLayoutId("scalp", 8)).toBe("generic8");
    expect(defaultLayoutId("scalp", 16)).toBe("generic16");
    expect(defaultLayoutId("scalp", 24)).toBe("generic24");
    expect(defaultLayoutId(undefined, 32)).toBe("generic32");
  });

  it("provides layouts for all supported device IDs", () => {
    expect(CALIB_LAYOUTS.length).toBe(6);
    expect(getLayout("xr").shape).toBe("board");
    expect(getLayout("generic8").signalChannels).toBe(8);
    expect(getLayout("generic16").signalChannels).toBe(16);
    expect(getLayout("generic24").signalChannels).toBe(24);
    expect(getLayout("generic32").signalChannels).toBe(32);
    expect(getLayout("octopus").signalChannels).toBe(16);
  });
});
