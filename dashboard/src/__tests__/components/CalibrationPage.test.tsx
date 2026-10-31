import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CalibrationPage from "../../components/CalibrationPage";
import type { EEGData } from "../../types";

function makeDummyEEG(numChannels = 8): EEGData {
  const bufs = Array.from({ length: numChannels }, () => new Float32Array(500));
  return {
    buffers: { current: bufs },
    writeIndex: { current: 0 },
    samplesInBuffer: { current: 0 },
    bufferSize: 500,
    numChannels,
    gridSuspended: false,
  };
}

describe("CalibrationPage", () => {
  it("renders header, device tabs, and calls onBack when Dashboard button is clicked", () => {
    const onBack = vi.fn();
    render(<CalibrationPage eegData={makeDummyEEG(8)} onBack={onBack} lineFreq={60} deviceKind="scalp" />);

    expect(screen.getByText("Contact Calibration")).toBeInTheDocument();
    expect(screen.getByText("Waiting for signal")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Generic 8/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByText("← Dashboard"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("switches device layout tabs", () => {
    const onBack = vi.fn();
    render(<CalibrationPage eegData={makeDummyEEG(8)} onBack={onBack} />);

    const xrTab = screen.getByRole("tab", { name: /PiEEG XR/i });
    fireEvent.click(xrTab);
    expect(xrTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/PiEEG XR · 8-ch face board/i)).toBeInTheDocument();
  });
});
