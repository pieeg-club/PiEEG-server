import { useState, useCallback, useEffect, type FormEvent, type KeyboardEvent } from "react";
import { useTheme } from "../hooks/useTheme";
import { isWebBluetoothSupported, requestIronBciDevice } from "../lib/ironbciBle";
import { isWebSerialSupported, requestIronBci32Port } from "../lib/ironbci32Serial";

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

type TabId = "connect" | "browser" | "hardware";

export default function SessionLobby({ onConnect }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("connect");
  const [serverUrl, setServerUrl] = useState(defaultWsUrl);
  const [sessionCode, setSessionCode] = useState("");
  const [serverInfo, setServerInfo] = useState<{ version: string; branch: string | null } | null>(null);
  const [bleSupported] = useState(isWebBluetoothSupported);
  const [bleConnecting, setBleConnecting] = useState(false);
  const [bleError, setBleError] = useState<string | null>(null);
  const [serialSupported] = useState(isWebSerialSupported);
  const [serialConnecting, setSerialConnecting] = useState(false);
  const [serialError, setSerialError] = useState<string | null>(null);
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

  const handleSerial = useCallback(async () => {
    setSerialError(null);
    setSerialConnecting(true);
    try {
      // Port picking must run inside this click handler (Web Serial gesture).
      await requestIronBci32Port();
      onConnect("serial:ironbci32");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ignore the user dismissing the port chooser.
      if (!/no port selected|cancel/i.test(msg)) setSerialError(msg);
    } finally {
      setSerialConnecting(false);
    }
  }, [onConnect]);

  return (
    <div className="lobby-backdrop">
      {/* Animated background glows */}
      <div className="lobby-glow lobby-glow--primary" aria-hidden="true" />
      <div className="lobby-glow lobby-glow--secondary" aria-hidden="true" />
      
      <div className="lobby-card-glass">
        {/* Header */}
        <div className="lobby-header">
          <div className="lobby-title">
            Pi<span className="lobby-title-accent">EEG</span>-server
          </div>
          <span className="lobby-version">
            v{serverInfo?.version ?? __APP_VERSION__}{serverInfo?.branch ? ` · ${serverInfo.branch}` : ""}
          </span>
        </div>

        {/* Tab Navigation */}
        <div className="lobby-tabs">
          <button
            className={`lobby-tab${activeTab === "connect" ? " lobby-tab--active" : ""}`}
            onClick={() => setActiveTab("connect")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            PiEEG Server
          </button>
          <button
            className={`lobby-tab${activeTab === "browser" ? " lobby-tab--active" : ""}`}
            onClick={() => setActiveTab("browser")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M5 4l6 4.5L7.5 11V2l3.5 2.5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Browser-Native
            {(bleSupported || serialSupported) && <span className="lobby-tab-badge">No Install</span>}
          </button>
          <button
            className={`lobby-tab${activeTab === "hardware" ? " lobby-tab--active" : ""}`}
            onClick={() => setActiveTab("hardware")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Hardware
          </button>
        </div>

        {/* Tab Content */}
        <div className="lobby-tab-content">
          {/* Connect Tab */}
          {activeTab === "connect" && (
            <div className="lobby-tab-panel lobby-tab-panel--animate">
              <div className="lobby-section-glass">
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
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{marginRight: 8}}>
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
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{marginRight: 8}}>
                    <path d="M4 2l10 6-10 6V2z" fill="currentColor"/>
                  </svg>
                  Try Demo Server
                </button>
              </div>

              <div className="lobby-section-glass lobby-section-glass--secondary">
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
            </div>
          )}

          {/* Browser-Native Tab */}
          {activeTab === "browser" && (
            <div className="lobby-tab-panel lobby-tab-panel--animate">
              <div className="lobby-hero-badge">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Zero Installation Required
              </div>

              <p className="lobby-hero-text">
                Connect your hardware directly in the browser using modern Web APIs. No drivers, no software, instant connection.
              </p>

              {bleSupported && (
                <div className="lobby-section-glass">
                  <div className="lobby-device-header">
                    <div className="lobby-device-icon lobby-device-icon--bluetooth">
                      <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                        <path d="M5 4l6 4.5L7.5 11V2l3.5 2.5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                    <div>
                      <h3 className="lobby-device-title">IronBCI (Bluetooth)</h3>
                      <p className="lobby-device-subtitle">8-channel wireless • 250 Hz • Completely untethered</p>
                    </div>
                  </div>

                  <button
                    className="lobby-btn lobby-btn--device"
                    type="button"
                    onClick={handleBluetooth}
                    disabled={bleConnecting}
                  >
                    {bleConnecting ? (
                      <>
                        <span className="lobby-spinner" />
                        Pairing…
                      </>
                    ) : (
                      <>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <path d="M5 4l6 4.5L7.5 11V2l3.5 2.5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        Connect via Bluetooth
                      </>
                    )}
                  </button>

                  {bleError && (
                    <p className="lobby-error">
                      {bleError}
                    </p>
                  )}
                </div>
              )}

              {serialSupported && (
                <div className="lobby-section-glass">
                  <div className="lobby-device-header">
                    <div className="lobby-device-icon lobby-device-icon--serial">
                      <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                        <path d="M5 1v4M11 1v4M3 5h10v3a5 5 0 0 1-10 0V5zM8 13v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                    <div>
                      <h3 className="lobby-device-title">IronBCI-32 (USB)</h3>
                      <p className="lobby-device-subtitle">32-channel research-grade • 500 Hz • High-density mapping</p>
                    </div>
                  </div>

                  <button
                    className="lobby-btn lobby-btn--device"
                    type="button"
                    onClick={handleSerial}
                    disabled={serialConnecting}
                  >
                    {serialConnecting ? (
                      <>
                        <span className="lobby-spinner" />
                        Connecting…
                      </>
                    ) : (
                      <>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <path d="M5 1v4M11 1v4M3 5h10v3a5 5 0 0 1-10 0V5zM8 13v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        Connect via USB
                      </>
                    )}
                  </button>

                  {serialError && (
                    <p className="lobby-error">
                      {serialError}
                    </p>
                  )}
                </div>
              )}

              {!bleSupported && !serialSupported && (
                <div className="lobby-section-glass lobby-section-glass--warning">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{marginBottom: 12}}>
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                    <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <p style={{fontSize: 14, color: "var(--text-secondary)", textAlign: "center", lineHeight: 1.6}}>
                    Your browser doesn't support Web Bluetooth or Web Serial. Try Chrome, Edge, or Opera for browser-native connections.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Hardware Tab */}
          {activeTab === "hardware" && (
            <div className="lobby-tab-panel lobby-tab-panel--animate">
              <div className="lobby-hero-badge lobby-hero-badge--shop">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4zM3 6h18M16 10a4 4 0 11-8 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Get the Hardware
              </div>

              <p className="lobby-hero-text">
                Research-grade biosignal acquisition. Same ADCs as $10,000 systems. MIT-licensed software. No subscriptions.
              </p>

              <div className="lobby-products">
                <a
                  href="https://pieeg.com/products/ironbci-32"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lobby-product-card"
                >
                  <div className="lobby-product-badge">32ch</div>
                  <div className="lobby-product-icon">
                    <svg width="28" height="28" viewBox="0 0 16 16" fill="none">
                      <path d="M5 1v4M11 1v4M3 5h10v3a5 5 0 0 1-10 0V5zM8 13v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <h3 className="lobby-product-title">IronBCI-32</h3>
                  <p className="lobby-product-subtitle">32-channel USB • 500 Hz</p>
                  <span className="lobby-product-link">
                    View Product
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                </a>

                <a
                  href="https://pieeg.com/products/ironbci"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lobby-product-card"
                >
                  <div className="lobby-product-badge">8ch BLE</div>
                  <div className="lobby-product-icon lobby-product-icon--bluetooth">
                    <svg width="28" height="28" viewBox="0 0 16 16" fill="none">
                      <path d="M5 4l6 4.5L7.5 11V2l3.5 2.5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <h3 className="lobby-product-title">IronBCI</h3>
                  <p className="lobby-product-subtitle">8-channel Wireless • 250 Hz</p>
                  <span className="lobby-product-link">
                    View Product
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                </a>

                <a
                  href="https://pieeg.com/products/pieeg-16"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lobby-product-card"
                >
                  <div className="lobby-product-badge">16ch</div>
                  <div className="lobby-product-icon lobby-product-icon--pi">
                    <svg width="28" height="28" viewBox="0 0 16 16" fill="none">
                      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                  <h3 className="lobby-product-title">PiEEG-16</h3>
                  <p className="lobby-product-subtitle">16-channel Pi Shield • 250 Hz</p>
                  <span className="lobby-product-link">
                    View Product
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                </a>

                <a
                  href="https://pieeg.com/#products"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lobby-product-card lobby-product-card--more"
                >
                  <div className="lobby-product-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </div>
                  <h3 className="lobby-product-title">View All</h3>
                  <p className="lobby-product-subtitle">PiEEG, ardEEG, JNEEG & more</p>
                  <span className="lobby-product-link">
                    Browse Shop
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Feature Pills */}
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

        {/* Footer */}
        <div className="lobby-footer-row">
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="3.5" />
                <line x1="8" y1="1" x2="8" y2="2.5" />
                <line x1="8" y1="13.5" x2="8" y2="15" />
                <line x1="1" y1="8" x2="2.5" y2="8" />
                <line x1="13.5" y1="8" x2="15" y2="8" />
                <line x1="2.8" y1="2.8" x2="3.9" y2="3.9" />
                <line x1="12.1" y1="12.1" x2="13.2" y2="13.2" />
                <line x1="2.8" y1="13.2" x2="3.9" y2="12.1" />
                <line x1="12.1" y1="3.9" x2="13.2" y2="2.8" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 8.5a6.5 6.5 0 1 1-5-6.3 5 5 0 0 0 5 6.3z" />
              </svg>
            )}
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
