import { useState, useCallback, useEffect, type FormEvent, type KeyboardEvent } from "react";
import { useTheme } from "../hooks/useTheme";
import { isWebBluetoothSupported, requestIronBciDevice } from "../lib/ironbciBle";

declare const __APP_VERSION__: string;

const FLY_DEMO_URL = "wss://pieeg-server--mock.fly.dev";

/** Compute the default WS URL from the current page location. */
function defaultWsUrl(): string {
  const host = location.hostname || "localhost";
  // If the host looks like a real domain (has a valid TLD), don't prefill
  if (/\.[a-z]{2,}$/i.test(host) && host !== "localhost") return "";
  const port = import.meta.env.DEV ? 1616 : parseInt(location.port || "1617") - 1;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${host}:${port}`;
}

interface Props {
  onConnect: (wsUrl: string) => void;
}

export default function SessionLobby({ onConnect }: Props) {
  const [serverUrl, setServerUrl] = useState(defaultWsUrl);
  const [sessionCode, setSessionCode] = useState("");
  const [serverInfo, setServerInfo] = useState<{ version: string; branch: string | null } | null>(null);
  const [bleSupported] = useState(isWebBluetoothSupported);
  const [bleConnecting, setBleConnecting] = useState(false);
  const [bleError, setBleError] = useState<string | null>(null);
  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    fetch("/api/info")
      .then((r) => r.json())
      .then((d) => { if (d.version) setServerInfo(d); })
      .catch(() => {});
  }, []);

  const handleCreate = useCallback(() => {
    const url = serverUrl.trim();
    if (url) onConnect(url);
  }, [serverUrl, onConnect]);

  const handleJoin = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      const code = sessionCode.trim();
      if (!code) return;
      onConnect(code);
    },
    [sessionCode, onConnect],
  );

  const handleSessionKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") handleJoin();
    },
    [handleJoin],
  );

  const handleBluetooth = useCallback(async () => {
    setBleError(null);
    setBleConnecting(true);
    try {
      // Pairing must run inside this click handler (Web Bluetooth user gesture).
      await requestIronBciDevice();
      onConnect("ble:ironbci");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ignore the user dismissing the device chooser.
      if (!/cancel/i.test(msg)) setBleError(msg);
    } finally {
      setBleConnecting(false);
    }
  }, [onConnect]);

  return (
    <div className="lobby-backdrop">
      <div className="lobby-glow" aria-hidden="true" />
      <div className="lobby-card">
        <div className="lobby-title">
          Pi<span className="lobby-title-accent">EEG</span>-server
        </div>
        <span className="lobby-version">
          v{serverInfo?.version ?? __APP_VERSION__}{serverInfo?.branch ? ` · ${serverInfo.branch}` : ""}
        </span>

        {/* ── Connect ───────────────────────────────────── */}
        <div className="lobby-section">
          <h2 className="lobby-section-title">
            <span className="lobby-dot lobby-dot--green lobby-dot--pulse" />
            Connect to Server
          </h2>

          <label className="lobby-label">Server URL</label>
          <input
            className="lobby-input"
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            placeholder="ws://localhost:1616"
          />

          <button className="lobby-btn lobby-btn--connect" onClick={handleCreate}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{marginRight: 6}}>
              <path d="M2 8h12M10 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Connect
          </button>

          <div className="lobby-divider">
            <span>or</span>
          </div>

          <button
            className="lobby-btn lobby-btn--demo"
            type="button"
            onClick={() => setServerUrl(FLY_DEMO_URL)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{marginRight: 6}}>
              <path d="M4 2l10 6-10 6V2z" fill="currentColor"/>
            </svg>
            Try Demo Server
          </button>

          {bleSupported && (
            <>
              <div className="lobby-divider">
                <span>or</span>
              </div>

              <button
                className="lobby-btn lobby-btn--demo"
                type="button"
                onClick={handleBluetooth}
                disabled={bleConnecting}
                title="Connect an IronBCI board directly over Bluetooth — no server needed"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{marginRight: 6}}>
                  <path d="M5 4l6 4.5L7.5 11V2l3.5 2.5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {bleConnecting ? "Pairing…" : "Connect IronBCI (Bluetooth)"}
              </button>

              {bleError && (
                <p style={{ color: "#ef4444", fontSize: 12, marginTop: 8, lineHeight: 1.4 }}>
                  {bleError}
                </p>
              )}
            </>
          )}
        </div>

        {/* ── Join existing ────────────────────────────────── */}
        <div className="lobby-section lobby-section--secondary">
          <label className="lobby-label">Or join with a session code</label>
          <div className="lobby-join-row">
            <input
              className="lobby-input"
              type="text"
              value={sessionCode}
              onChange={(e) => setSessionCode(e.target.value)}
              onKeyDown={handleSessionKeyDown}
              placeholder="Paste session code or URL…"
            />
            <button
              className="lobby-btn lobby-btn--accent"
              disabled={!sessionCode.trim()}
              onClick={() => handleJoin()}
            >
              Join
            </button>
          </div>
        </div>

        {/* ── Feature pills ─────────────────────────────────── */}
        <div className="lobby-pills">
          <span className="lobby-pill lobby-pill--yellow">
            <span className="lobby-dot lobby-dot--yellow" />
            Visualization
          </span>
          <span className="lobby-pill lobby-pill--blue">
            <span className="lobby-dot lobby-dot--blue" />
            Neural Decoders
          </span>
          <span className="lobby-pill lobby-pill--green">
            <span className="lobby-dot lobby-dot--green" />
            Real-time Metrics
          </span>
        </div>

        {/* ── Footer ───────────────────────────────────────── */}
        <div className="lobby-footer-row">
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <a
            className="lobby-gh-link"
            href="https://github.com/pieeg-club/PiEEG-server"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{marginRight: 6}}>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            Submit an issue
          </a>
        </div>
      </div>
    </div>
  );
}
