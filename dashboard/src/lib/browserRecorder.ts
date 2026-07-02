/**
 * Client-side CSV recorder for browser-native (BLE / Web Serial) connections.
 *
 * The WebSocket transport records on the Python server, but the direct
 * browser-native paths have no server. This captures the live sample stream
 * in memory and, on stop, produces a CSV blob in the exact same format the
 * server writes (`timestamp, ch1, ch2, ..., chN`) so recordings remain
 * compatible with the dashboard playback library and the Jupyter notebooks.
 *
 * Memory: samples are kept in a flat `number[]`. A few minutes at 500 Hz × 32
 * channels stays well within a browser's heap; typical sessions are seconds
 * to a couple of minutes.
 */

export interface BrowserRecordingResult {
  blob: Blob;
  filename: string;
  frames: number;
  duration: number;
}

export class BrowserCsvRecorder {
  private times: number[] = [];
  private samples: number[] = []; // flat, frame-major: [f0c0,f0c1,…,f1c0,…]
  private readonly numChannels: number;
  private readonly startMs = performance.now();
  private readonly startedAt = new Date();

  constructor(numChannels: number) {
    this.numChannels = numChannels;
  }

  /** Append one frame of `numChannels` samples with its stream timestamp. */
  push(channels: number[], t: number): void {
    this.times.push(t);
    const n = this.numChannels;
    for (let i = 0; i < n; i++) this.samples.push(channels[i] ?? 0);
  }

  get frames(): number {
    return this.times.length;
  }

  /** Finalise the recording into a downloadable CSV blob. */
  finish(): BrowserRecordingResult {
    const n = this.numChannels;
    const frames = this.times.length;

    const header = ["timestamp"];
    for (let c = 1; c <= n; c++) header.push(`ch${c}`);

    const lines: string[] = [header.join(",")];
    for (let f = 0; f < frames; f++) {
      const base = f * n;
      let row = this.times[f].toFixed(6);
      for (let c = 0; c < n; c++) row += "," + this.samples[base + c].toFixed(2);
      lines.push(row);
    }

    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    const duration = (performance.now() - this.startMs) / 1000;

    const d = this.startedAt;
    const p = (x: number) => String(x).padStart(2, "0");
    const filename =
      `pieeg_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;

    return { blob, filename, frames, duration };
  }
}
