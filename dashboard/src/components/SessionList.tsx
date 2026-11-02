import { useEffect, useState } from "react";
import type { Recording } from "../types";

interface SessionListProps {
  onSelect: (filename: string) => void;
  onBack: () => void;
}

export default function SessionList({ onSelect, onBack }: SessionListProps) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [studioNotice, setStudioNotice] = useState<string | null>(null);
  const [studioLoading, setStudioLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchRecordings();
  }, []);

  async function openInStudio(filename: string) {
    setStudioNotice(null);
    setStudioLoading(filename);
    try {
      const res = await fetch("/api/studio/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setStudioNotice(data.error || 'Install PiEEG Studio with: pip install "pieeg-server[studio]"');
        return;
      }
      const port = data.port || 1618;
      const studioUrl = `${window.location.protocol}//${window.location.hostname}:${port}/?recording=${encodeURIComponent(filename)}`;
      window.open(studioUrl, "_blank", "noopener");
    } catch {
      const studioUrl = `${window.location.protocol}//${window.location.hostname}:1618/?recording=${encodeURIComponent(filename)}`;
      window.open(studioUrl, "_blank", "noopener");
    } finally {
      setStudioLoading(null);
    }
  }

  async function fetchRecordings() {
    try {
      const res = await fetch("/api/recordings");
      const data = await res.json();
      setRecordings(data.recordings || []);
    } catch (error) {
      console.error("Failed to load recordings:", error);
    } finally {
      setLoading(false);
    }
  }

  function formatDate(mtime: number): string {
    const date = new Date(mtime * 1000);
    return date.toLocaleString();
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return (
    <div className="session-list">
      <header className="session-header">
        <h2>Saved Sessions</h2>
        <button className="btn btn-back" onClick={onBack}>
          ← Back to Live
        </button>
      </header>

      {studioNotice && (
        <div className="studio-notice">
          <span>{studioNotice}</span>
          <button className="studio-notice-close" onClick={() => setStudioNotice(null)}>✕</button>
        </div>
      )}

      {loading && (
        <div className="list-loading">
          <p>Loading recordings...</p>
        </div>
      )}

      {!loading && recordings.length === 0 && (
        <div className="list-empty">
          <p>No recordings yet. Record a session on the Live tab.</p>
        </div>
      )}

      {!loading && recordings.length > 0 && (
        <div className="list-container">
          <table className="recordings-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Size</th>
                <th>Date & Time</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {recordings.map((rec) => (
                <tr key={rec.filename}>
                  <td className="filename">{rec.filename}</td>
                  <td className="size">{formatSize(rec.size)}</td>
                  <td className="mtime">{formatDate(rec.mtime)}</td>
                  <td className="action">
                    <div className="action-buttons">
                      <button
                        className="btn btn-open"
                        onClick={() => onSelect(rec.filename)}
                      >
                        Open
                      </button>
                      <button
                        className="btn btn-studio"
                        disabled={studioLoading === rec.filename}
                        onClick={() => openInStudio(rec.filename)}
                        title="Open in PiEEG Studio (offline MNE-Python analysis)"
                      >
                        {studioLoading === rec.filename ? "Starting…" : "Studio ↗"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <style>{`
        .session-list {
          display: flex;
          flex-direction: column;
          height: 100%;
          padding: 20px;
          background: var(--bg);
        }

        .session-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          border-bottom: 1px solid var(--border);
          padding-bottom: 15px;
        }

        .session-header h2 {
          margin: 0;
          color: var(--text);
          font-size: 20px;
        }

        .btn-back {
          padding: 8px 16px;
          background: var(--border);
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          transition: background 0.2s;
        }

        .btn-back:hover {
          background: var(--accent);
          border-color: var(--accent);
        }

        .list-loading,
        .list-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 1;
          color: var(--dim);
          font-size: 14px;
        }

        .list-container {
          flex: 1;
          overflow-y: auto;
        }

        .recordings-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .recordings-table thead {
          position: sticky;
          top: 0;
          background: var(--surface);
          z-index: 1;
        }

        .recordings-table th {
          padding: 12px;
          text-align: left;
          color: var(--text-dim);
          font-weight: 600;
          border-bottom: 1px solid var(--border);
        }

        .recordings-table td {
          padding: 12px;
          border-bottom: 1px solid var(--border);
          color: var(--text);
        }

        .recordings-table tbody tr:hover {
          background: var(--surface);
        }

        .filename {
          font-family: monospace;
          font-size: 12px;
          max-width: 300px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .size {
          text-align: right;
          color: var(--dim);
          font-family: monospace;
        }

        .mtime {
          color: var(--dim);
          font-family: monospace;
          font-size: 12px;
        }

        .btn-open {
          padding: 6px 12px;
          background: var(--accent);
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          transition: opacity 0.2s;
        }

        .btn-open:hover {
          opacity: 0.8;
        }

        .action-buttons {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .btn-studio {
          padding: 6px 12px;
          background: transparent;
          color: var(--accent);
          border: 1px solid var(--accent);
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          transition: background 0.2s, color 0.2s;
        }

        .btn-studio:hover:not(:disabled) {
          background: var(--accent);
          color: white;
        }

        .btn-studio:disabled {
          opacity: 0.6;
          cursor: wait;
        }

        .studio-notice {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 14px;
          margin-bottom: 14px;
          background: var(--surface);
          border: 1px solid var(--accent);
          border-radius: 6px;
          font-family: monospace;
          font-size: 12px;
          color: var(--text);
        }

        .studio-notice-close {
          background: none;
          border: none;
          color: var(--dim);
          cursor: pointer;
          font-size: 14px;
        }
      `}</style>
    </div>
  );
}
