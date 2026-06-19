import { useState, useEffect } from "react";
import { PLUGINS, Plugin, getCategories, checkAllPluginStatuses } from "../lib/plugins";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function PluginsPanel({ open, onClose }: Props) {
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [pluginStatuses, setPluginStatuses] = useState<Record<string, "running" | "stopped" | "unknown">>({});
  const [checking, setChecking] = useState(false);

  // Check plugin statuses when panel opens
  useEffect(() => {
    if (!open) return;
    
    setChecking(true);
    checkAllPluginStatuses()
      .then(statuses => {
        setPluginStatuses(statuses);
        setChecking(false);
      })
      .catch(() => {
        setChecking(false);
      });
  }, [open]);

  const categories = ["All", ...getCategories()];
  const filteredPlugins = selectedCategory === "All" 
    ? PLUGINS 
    : PLUGINS.filter(p => p.category === selectedCategory);

  if (!open) return null;

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "Analysis": return "#3b82f6"; // blue
      case "Performance": return "#10b981"; // green
      case "Tools": return "#8b5cf6"; // purple
      case "Visualization": return "#f59e0b"; // amber
      case "Integration": return "#ec4899"; // pink
      default: return "#6b7280"; // gray
    }
  };

  return (
    <div className="plugins-panel side-panel">
      <div className="panel-header">
        <h2>Plugins</h2>
        <button className="btn-close" onClick={onClose}>×</button>
      </div>

      <div className="panel-body">
        <div className="plugins-filter">
          <div className="filter-label">Category:</div>
          <div className="filter-buttons">
            {categories.map(cat => (
              <button
                key={cat}
                className={`filter-btn ${selectedCategory === cat ? "active" : ""}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="plugins-grid">
          {filteredPlugins.map((plugin) => {
            const status = pluginStatuses[plugin.id] || "unknown";
            
            return (
            <div key={plugin.id} className="plugin-card">
              <div className="plugin-header">
                <div className="plugin-title-row">
                  <h3 className="plugin-name">{plugin.name}</h3>
                  <span 
                    className="plugin-category-badge"
                    style={{ backgroundColor: getCategoryColor(plugin.category) }}
                  >
                    {plugin.category}
                  </span>
                </div>
                {status !== "unknown" && (
                  <div className="plugin-status-row">
                    <span className={`plugin-status ${status}`}>
                      {checking ? "Checking..." : status === "running" ? "Running" : "Not running"}
                    </span>
                  </div>
                )}
              </div>

              <p className="plugin-description">{plugin.description}</p>

              <div className="plugin-features-section">
                <h4>Features</h4>
                <ul className="plugin-features-list">
                  {plugin.features.map((feature, idx) => (
                    <li key={idx}>{feature}</li>
                  ))}
                </ul>
              </div>

              <div className="plugin-actions">
                <a
                  className="btn plugin-repo-btn"
                  href={plugin.repo}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on GitHub →
                </a>
              </div>
            </div>
            );
          })}
        </div>

        <div className="plugins-footer">
          <p className="plugins-footer-text">
            Want to contribute a plugin? Check out the{" "}
            <a 
              href="https://github.com/pieeg-club" 
              target="_blank" 
              rel="noopener noreferrer"
            >
              PiEEG Club
            </a>{" "}
            organization on GitHub.
          </p>
        </div>
      </div>
    </div>
  );
}
