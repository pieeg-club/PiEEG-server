import { useState, useMemo, Suspense } from "react";
import type { EEGData } from "../types";
import { EXPERIENCES, type ExperienceEntry } from "../experiences/registry";

interface ExperiencesPageProps {
  eegData: EEGData;
  yScale: number;
  onBack: () => void;
  sendCommand?: (cmd: Record<string, unknown>) => void;
  /** Optional: ID of experience to auto-launch on mount */
  initialExperienceId?: string;
}

const LATEST_COUNT = 4;
const LATEST = EXPERIENCES.slice(-LATEST_COUNT);

export default function ExperiencesPage({ eegData, yScale, onBack, sendCommand, initialExperienceId }: ExperiencesPageProps) {
  const initialExp = initialExperienceId ? EXPERIENCES.find(e => e.id === initialExperienceId) ?? null : null;
  const [active, setActive] = useState<ExperienceEntry | null>(initialExp);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return EXPERIENCES;
    return EXPERIENCES.filter(
      (exp) =>
        exp.name.toLowerCase().includes(q) ||
        exp.description.toLowerCase().includes(q) ||
        exp.tag.toLowerCase().includes(q) ||
        (exp.author?.toLowerCase().includes(q) ?? false),
    );
  }, [q]);

  const renderCard = (exp: ExperienceEntry) => (
    <button key={exp.id} className="exp-card" onClick={() => setActive(exp)}>
      <div
        className="exp-card-thumb"
        style={{
          background: `linear-gradient(135deg, ${exp.gradient[0]}, ${exp.gradient[1]})`,
        }}
      >
        <div className="exp-card-tags">
          <span className="exp-tag">{exp.tag}</span>
          {exp.vr && <span className="exp-tag exp-tag--vr">VR</span>}
          {exp.handTracking && <span className="exp-tag exp-tag--hand">Hands</span>}
        </div>
      </div>
      <div className="exp-card-body">
        <h3 className="exp-card-name">{exp.name}</h3>
        <p className="exp-card-desc">{exp.description}</p>
        {exp.author && <span className="exp-card-author">by {exp.author}</span>}
      </div>
    </button>
  );

  // Running an experience — render it full-screen
  if (active) {
    const Comp = active.component;
    return (
      <Suspense
        fallback={
          <div className="exp-loading">
            <div className="exp-loading-spinner" />
            <span>Loading {active.name}…</span>
          </div>
        }
      >
        <Comp eegData={eegData} yScale={yScale} onExit={() => setActive(null)} sendCommand={sendCommand} />
      </Suspense>
    );
  }

  // Gallery view
  return (
    <div className="exp-page">
      <header className="exp-header">
        <button className="btn exp-back" onClick={onBack}>
          ← Dashboard
        </button>
        <div className="exp-title-group">
          <h1 className="exp-title">
            Mini Games
          </h1>
          <span className="exp-count">{EXPERIENCES.length}</span>
        </div>
        <p className="exp-subtitle">
          Immersive EEG visualizations &amp; environments. Community-driven — add yours!
        </p>

        <div className="exp-search">
          <svg
            className="exp-search-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            className="exp-search-input"
            placeholder="Search mini games by name, tag, or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search mini games"
          />
          {query && (
            <button
              className="exp-search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
      </header>

      {/* Search results or all experiences */}
      {filtered.length === 0 ? (
          <div className="exp-empty">
            <p className="exp-empty-title">
              No mini games match “{query.trim()}”
            </p>
            <button className="btn" onClick={() => setQuery("")}>
              Clear search
            </button>
          </div>
        ) : (
        <>
          {/* Latest experiences — only shown when not searching */}
          {!q && (
            <>
              <div className="exp-latest-label">Latest</div>
              <div className="exp-grid exp-grid--latest">
                {LATEST.map(renderCard)}
              </div>
            </>
          )}

          <div className="exp-grid">
            {filtered.map(renderCard)}

            {/* Placeholder card encouraging contributions — only on full list */}
            {!q && (
              <a
                className="exp-card exp-card--add"
                href="https://github.com/pieeg-club/PiEEG-server/blob/main/dashboard/src/experiences/README.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                <div className="exp-card-thumb exp-card-thumb--add">
                  <span className="exp-add-icon">+</span>
                </div>
                <div className="exp-card-body">
                  <h3 className="exp-card-name">Add yours</h3>
                  <p className="exp-card-desc">
                    Follow the step-by-step guide to create your own brain-powered mini-game and open a PR.
                  </p>
                </div>
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
