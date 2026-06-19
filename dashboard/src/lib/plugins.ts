/**
 * Static plugin registry for PiEEG ecosystem.
 * Add new plugins here to make them discoverable in the dashboard.
 */

export interface Plugin {
  id: string;
  name: string;
  description: string;
  category: "Analysis" | "Performance" | "Tools" | "Visualization" | "Integration";
  repo: string;
  features: string[];
  docs?: string;
  checkUrl?: string; // URL to ping for status check (frontend only)
}

export const PLUGINS: Plugin[] = [
  {
    id: "pieeg-agent",
    name: "PiEEG Agent",
    description: "Natural language EEG lab notebook. Train pattern classifiers, analyze connectivity, compare sessions — all by talking to an AI copilot.",
    category: "Analysis",
    repo: "https://github.com/pieeg-club/PiEEG-agent",
    install_command: "pip install pieeg-agent",
    checkUrl: "http://localhost:8000",
    features: [
      "Real-time brain state monitoring (focus, relaxation, engagement)",
      "Pattern training with cross-validation",
      "Spectral analysis (IAF, 1/f slope, theta/beta ratio)",
      "Connectivity analysis",
      "Session recording & comparison",
      "Natural language interface via LLM"
    ]
  },
  {
    id: "pieeg-chrome",
    name: "PiEEG Chrome Extension",
    description: "Chrome extension (Manifest V3) that monitors your local PiEEG server and opens the dashboard with one click.",
    category: "Tools",
    repo: "https://github.com/pieeg-club/PiEEG-chrome",
    install_command: "Load unpacked extension in Chrome",
    features: [
      "Server status indicator (online/offline)",
      "One-click dashboard access",
      "WebSocket URL copy to clipboard",
      "Configurable port settings",
      "Live spectrum strip in toolbar popup"
    ]
  },
  {
    id: "pieeg-core",
    name: "PiEEG Core",
    description: "Native accelerator for PiEEG-server. Compiled Rust replacements for signal processing hot paths.",
    category: "Performance",
    repo: "https://github.com/pieeg-club/PiEEG-core",
    install_command: "pip install pieeg-core",
    features: [
      "Butterworth IIR bandpass filter (~1057× faster)",
      "Hampel spike rejection (~15× faster)",
      "24-bit ADC decoding (~9× faster)",
      "Zero-copy acquisition",
      "Pre-built wheels for Linux/Windows/macOS"
    ]
  }
];

/**
 * Get all plugins, optionally filtered by category.
 */
export function getPlugins(category?: Plugin["category"]): Plugin[] {
  if (!category) return PLUGINS;
  return PLUGINS.filter(p => p.category === category);
}

/**
 * Get a plugin by ID.
 */
export function getPlugin(id: string): Plugin | undefined {
  return PLUGINS.find(p => p.id === id);
}

/**
 * Get all unique categories.
 */
export function getCategories(): Plugin["category"][] {
  const categories = new Set(PLUGINS.map(p => p.category));
  return Array.from(categories).sort();
}

/**
 * Check if a plugin is running by pinging its health endpoint.
 * Returns: "running" | "stopped" | "unknown"
 */
export async function checkPluginStatus(plugin: Plugin): Promise<"running" | "stopped" | "unknown"> {
  if (!plugin.checkUrl) {
    return "unknown"; // No way to check this plugin from frontend
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout

    const response = await fetch(plugin.checkUrl, {
      method: "GET",
      signal: controller.signal,
      mode: "cors",
    });

    clearTimeout(timeoutId);
    
    if (response.ok) {
      return "running";
    }
    return "stopped";
  } catch (err) {
    // Network error, timeout, or CORS issue = not running
    return "stopped";
  }
}

/**
 * Check status for all plugins.
 * Returns a map of plugin ID to status.
 */
export async function checkAllPluginStatuses(): Promise<Record<string, "running" | "stopped" | "unknown">> {
  const results: Record<string, "running" | "stopped" | "unknown"> = {};
  
  await Promise.all(
    PLUGINS.map(async (plugin) => {
      results[plugin.id] = await checkPluginStatus(plugin);
    })
  );
  
  return results;
}
