/* PiEEG Studio — offline EEG analysis UI (vanilla JS + Plotly, served locally) */
"use strict";

// ───────────────────────────────── state & utils ─────────────────────────────────
const S = {
  health: null, list: [], recordings: [], ds: null, view: "overview",
  theme: (() => { try { return localStorage.getItem("ps-theme") || "dark"; } catch { return "dark"; } })(),
  sig: { start: 0, dur: 10, scale: 50, stage: "processed", overlay: false, center: true, hidden: new Set(), addMode: false, label: "marker" },
  pipe: null, applyTimer: null, autoApply: true,
  spec: { stage: "processed", method: "welch", window: 2, fmax: 60, log: true, mode: "relative" },
  ica: { sel: null },
  erp: { result: null, cond: null, channel: "__gfp__" },
  conn: { method: "coherence", band: "Alpha" },
  tf: { channel: null, window: 1, fmax: 45 },
  mne: { start: 0, dur: 10 },
  exportStage: "processed",
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const fmtTime = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}`; };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const clone = (o) => JSON.parse(JSON.stringify(o));
const BAND_ORDER = ["Delta", "Theta", "Alpha", "Beta", "Gamma"];
const bandColor = (b) => (S.health?.band_colors || {})[b] || "#888";
const hashColor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; const pal = ["#3291ff", "#22c55e", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#14b8a6", "#eab308"]; return /^bad/i.test(s) ? "#ee4444" : pal[h % pal.length]; };

async function api(path, { method = "GET", body, form, raw } = {}) {
  const opt = { method, headers: {} };
  if (form) { opt.body = form; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, opt);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = j.detail || msg; } catch { }
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return raw ? r : r.json();
}
const dsUrl = (p = "") => `/api/datasets/${S.ds.id}${p}`;

function toast(msg, kind = "info", ms = 4200) {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.innerHTML = `<span class="i"></span><div>${msg}</div>`;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), ms);
}
let busyCount = 0;
function busy(on, text = "Processing…") {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  $("#busyText").textContent = text;
  $("#busy").classList.toggle("on", busyCount > 0);
}
async function task(text, fn) {
  busy(true, text);
  try { return await fn(); }
  catch (e) { toast(esc(e.message), "err", 7000); throw e; }
  finally { busy(false); }
}

// ───────────────────────────────── Plotly theme ─────────────────────────────────
function baseLayout(extra = {}) {
  const text = css("--text-2"), grid = css("--grid");
  const L = {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Geist, Inter, sans-serif", size: 11, color: text },
    margin: { l: 52, r: 16, t: 10, b: 38 },
    xaxis: { gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickfont: { family: "Geist Mono, monospace", size: 10 } },
    yaxis: { gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickfont: { family: "Geist Mono, monospace", size: 10 } },
    legend: { orientation: "h", y: 1.12, x: 0, font: { size: 11 } },
    hoverlabel: { bgcolor: css("--surface"), bordercolor: css("--border-strong"), font: { color: css("--text"), family: "Geist Mono" } },
  };
  for (const [k, v] of Object.entries(extra)) L[k] = (typeof v === "object" && !Array.isArray(v) && L[k]) ? { ...L[k], ...v } : v;
  return L;
}
const PCFG = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"], toImageButtonOptions: { format: "png", scale: 2 } };
function plot(el, data, layout, cfg = {}) { if (typeof el === "string") el = $(el); if (!el) return; Plotly.react(el, data, layout, { ...PCFG, ...cfg }); return el; }

// MNE figures (PNG) with readable error messages
async function mneImg(box, kind, params = {}) {
  if (typeof box === "string") box = $(box);
  if (!box || !S.ds) return;
  const q = new URLSearchParams({ theme: S.theme, v: S.ds.version, ...params });
  box.innerHTML = `<div class="skeleton" style="position:absolute;inset:0"></div>`;
  try {
    const r = await api(dsUrl(`/mne/${kind}.png?${q}`), { raw: true });
    const url = URL.createObjectURL(await r.blob());
    box.innerHTML = `<img class="mne-img fade-in" src="${url}" alt="${kind}"><span class="tag">MNE</span>`;
  } catch (e) {
    box.innerHTML = `<div class="msg">${esc(e.message.replace(/^\w+Error: /, ""))}</div>`;
  }
}

// ───────────────────────────────── shell ─────────────────────────────────
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  try { localStorage.setItem("ps-theme", S.theme); } catch { }
}
function renderTabs() {
  $("#dsSwitch").innerHTML = S.list.map((d) => `
    <div class="ds-tab ${S.ds && d.id === S.ds.id ? "active" : ""}" data-id="${d.id}" title="${esc(d.name)}">
      <span>${esc(d.name)}</span><span class="dim mono">${d.n_channels}ch·${d.sfreq}Hz</span>
      <span class="x" data-close="${d.id}">×</span></div>`).join("");
  $("#btnExport").disabled = !S.ds;
  const f = $("#sideFoot");
  f.innerHTML = S.ds ? `<b>${esc(S.ds.name)}</b><br>${S.ds.n_channels} ch · ${S.ds.sfreq} Hz · ${fmtTime(S.ds.duration)}<br>pipeline v${S.ds.version}`
    : `PiEEG Studio ${S.health?.version || ""}<br>MNE ${S.health?.mne || ""}`;
}
async function refreshList() { S.list = await api("/api/datasets"); renderTabs(); }

function setDs(info) {
  const changed = !S.ds || S.ds.id !== info.id;
  S.ds = info;
  S.pipe = clone(info.pipeline);
  if (changed) {
    S.sig.start = 0; S.sig.hidden = new Set(); S.erp = { result: null, cond: null, channel: "__gfp__" }; S.ica.sel = null;
    S.tf.channel = null;
  }
  renderTabs();
}

function go(view) {
  S.view = view;
  $$("#sidebar a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  render();
}
function render() {
  const main = $("#main");
  $$(".js-plotly-plot", main).forEach((p) => Plotly.purge(p));
  if (!S.ds) { main.innerHTML = viewEmpty(); bindEmpty(); return; }
  const v = VIEWS[S.view] || VIEWS.overview;
  main.innerHTML = `<div class="fade-in">${v.html()}</div>`;
  v.init && v.init();
}

// ───────────────────────────────── upload ─────────────────────────────────
async function uploadFile(file, opts = {}) {
  const form = new FormData();
  form.append("file", file);
  if (opts.sfreq) form.append("sfreq", opts.sfreq);
  form.append("map_10_20", opts.map_10_20 === false ? "false" : "true");
  const info = await task(`Loading ${esc(file.name)}…`, () => api("/api/datasets", { method: "POST", form }));
  setDs(info); await refreshList();
  const rep = info.report;
  toast(`<b>${esc(info.name)}</b> loaded — ${info.n_channels} channels · ${info.sfreq} Hz · ${fmtTime(info.duration)}<br><span class="dim">${esc(rep.source_format)}</span>`, "ok");
  (rep.warnings || []).forEach((w) => toast(esc(w), "info", 7000));
  go("overview");
}
async function loadServerRecording(filename, opts = {}) {
  const info = await task(`Loading ${esc(filename)}…`, () =>
    api("/api/recordings/open", { method: "POST", body: { filename, sfreq: opts.sfreq || null, map_10_20: opts.map_10_20 !== false } })
  );
  setDs(info); await refreshList();
  const rep = info.report;
  toast(`<b>${esc(info.name)}</b> loaded — ${info.n_channels} channels · ${info.sfreq} Hz · ${fmtTime(info.duration)}<br><span class="dim">${esc(rep.source_format)}</span>`, "ok");
  (rep.warnings || []).forEach((w) => toast(esc(w), "info", 7000));
  go("overview");
}
async function loadDemo() {
  const info = await task("Generating demo recording…", () => api("/api/demo", { method: "POST", body: { n_channels: 16, duration: 120 } }));
  setDs(info); await refreshList(); go("overview");
  toast("Demo PiEEG-16 session loaded: eyes-open/closed blocks, blinks, 50 Hz mains, a noisy F8 channel and electrode pops.", "ok", 7000);
}

function viewEmpty() {
  const recs = S.recordings || [];
  const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const recSection = recs.length ? `<div class="card" style="width:100%;max-width:720px;margin-top:8px;text-align:left">
    <div class="card-head"><h2>Server recordings <span class="sub">recordings/ (${recs.length})</span></h2></div>
    <div class="table-wrap" style="max-height:200px"><table><thead><tr><th>File</th><th>Size</th><th>Recorded</th><th></th></tr></thead><tbody>
      ${recs.map((r) => `<tr><td class="mono">${esc(r.filename)}${r.has_annotations ? ' <span class="pill info small">markers</span>' : ""}</td>
        <td class="mono dim">${fmtBytes(r.size)}</td>
        <td class="mono dim">${new Date(r.mtime * 1000).toLocaleString()}</td>
        <td style="text-align:right"><button class="btn btn-sm btn-primary" data-open-rec="${esc(r.filename)}">Open</button></td></tr>`).join("")}
    </tbody></table></div></div>` : "";
  return `<div class="empty fade-in">
    <img src="/static/logo.png" style="width:64px;height:64px;border-radius:16px">
    <div class="hero-title">Analyse your <span>PiEEG recordings</span><br>completely offline.</div>
    <p class="hero-sub">Load a session exported from PiEEG-server (CSV or Excel), clean it with research-grade filters,
      remove artefacts with ICA and explore spectra, topomaps, ERPs and connectivity — powered by MNE-Python.</p>
    <div class="drop" id="drop">
      <svg class="up" viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
      <div class="big">Drop a recording here or click to browse</div>
      <div class="muted small">PiEEG <code>timestamp, ch1…chN</code> (µV) · annotated session exports · any table with EEG columns</div>
      <div class="formats">${[".csv", ".xlsx", ".xls", ".tsv", ".edf", ".bdf", ".fif", ".vhdr", ".set"].map((f) => `<span class="pill mute mono">${f}</span>`).join("")}</div>
    </div>
    <div class="empty-opts">
      <label class="field" style="flex-direction:row;align-items:center;gap:8px">Sampling rate
        <select id="upRate"><option value="">Auto-detect</option>${[125, 250, 500, 1000, 2000, 4000].map((r) => `<option>${r}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="upMap" checked> Map ch1…chN to PiEEG 10-20 layout</label>
      <span class="dim">or</span>
      <button class="btn" id="btnDemo"><svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>Try a demo recording</button>
    </div>
    ${recSection}
    <div class="features">
      <div class="card"><b>Filters</b><span>Band-pass FIR/IIR, notch + harmonics, detrend, Hampel spike removal, re-reference, resample.</span></div>
      <div class="card"><b>Artefacts</b><span>Blink, amplitude & muscle detection, bad-channel interpolation, ICA with automatic EOG suggestions.</span></div>
      <div class="card"><b>Analysis</b><span>PSD, band powers, ratios, alpha asymmetry, spectrograms, ERPs, coherence / PLV / wPLI.</span></div>
      <div class="card"><b>MNE inside</b><span>Topomaps, ICA & ERP figures, native MNE browser, HTML reports, FIF/EDF and reproducible Python.</span></div>
    </div></div>`;
}
function bindEmpty() {
  const d = $("#drop");
  const opts = () => ({ sfreq: $("#upRate").value || null, map_10_20: $("#upMap").checked });
  d.onclick = () => { S._uploadOpts = opts(); $("#fileInput").click(); };
  d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); };
  d.ondragleave = () => d.classList.remove("over");
  d.ondrop = (e) => { e.preventDefault(); d.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) uploadFile(f, opts()); };
  $("#btnDemo").onclick = loadDemo;
  $$("[data-open-rec]").forEach((b) => { b.onclick = () => loadServerRecording(b.dataset.openRec, opts()); });
}

// ───────────────────────────────── views ─────────────────────────────────
const VIEWS = {};

function head(title, sub, tools = "") {
  return `<div class="view-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="toolbar">${tools}</div></div>`;
}
function seg(id, options, value) {
  return `<div class="seg" id="${id}">${options.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(value) ? "on" : ""}">${l}</button>`).join("")}</div>`;
}
function bindSeg(id, cb) {
  const el = $("#" + id); if (!el) return;
  el.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; $$("button", el).forEach((x) => x.classList.toggle("on", x === b)); cb(b.dataset.v); };
}
function annShapes(anns, yref = "paper", opts = {}) {
  const shapes = [], labels = [];
  for (const a of anns || []) {
    const c = hashColor(a.description);
    if (a.duration > 0) shapes.push({ type: "rect", xref: "x", yref, x0: a.onset, x1: a.onset + a.duration, y0: 0, y1: 1, fillcolor: c, opacity: /^bad/i.test(a.description) ? .14 : .1, line: { width: 0 }, layer: "below" });
    else shapes.push({ type: "line", xref: "x", yref, x0: a.onset, x1: a.onset, y0: 0, y1: 1, line: { color: c, width: 1.2, dash: "dot" } });
    if (opts.labels !== false) labels.push({ x: a.onset, y: 1, yref, xref: "x", text: esc(a.description), showarrow: false, xanchor: "left", yanchor: "bottom", font: { size: 10, color: c }, bgcolor: "rgba(0,0,0,0)" });
  }
  return { shapes, labels };
}

// ── Overview ──
VIEWS.overview = {
  html() {
    const d = S.ds, rep = d.report;
    const good = d.channels.filter((c) => !c.bad).length;
    const labels = Object.entries(d.annotation_labels);
    return head(esc(d.name), `${esc(rep.source_format)} · ${d.meas_date ? "recorded " + new Date(d.meas_date).toLocaleString() : "no absolute timestamp"}`,
      `<button class="btn" data-go="signals">Open signal browser</button><button class="btn btn-primary" data-go="pipeline">Preprocessing →</button>`) + `
    <div class="grid g4">
      <div class="card kpi"><div class="label">Duration</div><div class="value">${fmtTime(d.duration)}</div><div class="hint">${d.n_times.toLocaleString()} samples</div></div>
      <div class="card kpi"><div class="label">Sampling rate</div><div class="value">${d.sfreq}<small>Hz</small></div><div class="hint">${esc(rep.sfreq_source.split("(")[0])}</div></div>
      <div class="card kpi"><div class="label">Channels</div><div class="value">${d.n_channels}<small>${d.bads.length ? `· ${d.bads.length} bad` : ""}</small></div><div class="hint">${d.channels.filter((c) => c.positioned).length} with 10-20 positions</div></div>
      <div class="card kpi"><div class="label">Events</div><div class="value">${d.n_annotations}</div><div class="hint">${labels.length ? labels.slice(0, 3).map(([k, v]) => `${esc(k)} ×${v}`).join(" · ") : "no markers"}</div></div>
    </div>
    <div class="grid g3 mt">
      <div class="card span2"><div class="card-head"><h2>Recording overview <span class="sub">RMS envelope of processed signal · click to open in browser</span></h2></div><div id="ovEnv" class="plot" style="min-height:190px"></div></div>
      <div class="card"><div class="card-head"><h2>Band composition <span class="sub">mean relative power</span></h2></div><div id="ovBands" class="plot" style="min-height:190px"></div></div>
    </div>
    <div class="grid g3 mt">
      <div class="card"><div class="card-head"><h2>Import report</h2></div><div class="list">
        ${[["Format", rep.source_format], ["Rows", rep.n_rows?.toLocaleString()], ["Sampling rate", rep.sfreq_source], ["Time column", rep.time_column || "—"],
        ["Marker column", rep.annotation_column || "—"], ["Timing gaps", rep.gaps], ["Filled cells", rep.nan_filled]].map(([k, v]) => `<div class="list-row"><span class="k">${k}</span><span class="v" title="${esc(v)}">${esc(v)}</span></div>`).join("")}
      </div>${(rep.warnings || []).map((w) => `<div class="note warn mt">${esc(w)}</div>`).join("")}
      <div class="row mt"><label class="field" style="flex-direction:row;align-items:center;gap:8px">Override rate <input type="number" id="ovRate" style="width:90px" placeholder="${d.sfreq}"></label><button class="btn btn-sm" id="ovReload">Reload</button></div></div>
      <div class="card"><div class="card-head"><h2>Processing chain</h2><button class="btn btn-sm btn-ghost" data-go="pipeline">Edit</button></div>
        <div class="flow"><span class="pill mute">raw µV</span>${d.log.map((l) => `→<span class="pill ${l.ok ? "info" : "bad"}" title="${esc(l.message)}">${esc(l.label)}</span>`).join("")}→<span class="pill good">clean</span></div>
        <div class="list mt">${d.log.map((l) => `<div class="list-row"><span class="k">${esc(l.label)}</span><span class="v ${l.ok ? "" : "muted"}" title="${esc(l.message)}">${esc(l.message)}</span></div>`).join("") || `<div class="dim small">No steps enabled — showing raw data.</div>`}</div>
        <div class="dim small mt">Effective band: ${fmt(d.highpass, 2)}–${fmt(d.lowpass, 1)} Hz · ${d.processed_sfreq} Hz</div></div>
      <div class="card"><div class="card-head"><h2>Signal quality</h2><button class="btn btn-sm btn-ghost" data-go="channels">Details</button></div><div id="ovQuality"><div class="skeleton" style="height:180px;border-radius:8px"></div></div></div>
    </div>`;
  },
  async init() {
    const d = S.ds;
    $("#ovReload").onclick = async () => {
      const v = parseFloat($("#ovRate").value);
      if (!v) return toast("Enter a sampling rate first.");
      setDs(await task("Reloading…", () => api(dsUrl("/reload"), { method: "POST", body: { sfreq: v, map_10_20: true } }))); render();
    };
    const env = d.envelope; const t = env.values.map((_, i) => i * env.step);
    const { shapes } = annShapes(api && (await api(dsUrl("/annotations"))).filter((a) => !/^blink$/i.test(a.description)).slice(0, 400), "paper", { labels: false });
    plot("#ovEnv", [{ x: t, y: env.values, type: "scatter", mode: "lines", fill: "tozeroy", line: { color: css("--accent-light"), width: 1.2 }, fillcolor: "rgba(50,145,255,.12)", hovertemplate: "%{x:.1f} s · %{y:.1f} µV<extra></extra>" }],
      baseLayout({ shapes, margin: { l: 46, r: 10, t: 6, b: 32 }, xaxis: { title: { text: "time (s)", font: { size: 10 } } }, yaxis: { title: { text: "µV RMS", font: { size: 10 } } } }));
    $("#ovEnv").on("plotly_click", (ev) => { S.sig.start = Math.max(0, ev.points[0].x - S.sig.dur / 2); go("signals"); });
    const [bp, st] = await Promise.all([api(dsUrl("/bands")), api(dsUrl("/stats"))]);
    if (!$("#ovQuality")) return;
    const bands = Object.keys(bp.bands);
    plot("#ovBands", [{ type: "pie", hole: .62, labels: bands, values: bands.map((b) => bp.mean_relative[b]), marker: { colors: bands.map(bandColor), line: { color: css("--bg-subtle"), width: 2 } }, textinfo: "percent", textfont: { color: "#fff", size: 10 }, sort: false, hovertemplate: "%{label}: %{percent}<extra></extra>" }],
      baseLayout({ margin: { l: 8, r: 8, t: 8, b: 8 }, showlegend: true, legend: { orientation: "v", x: 1, y: .5 } }));
    const q = { good: 0, warn: 0, bad: 0 }; st.rows.forEach((r) => q[r.quality]++);
    const issues = st.rows.filter((r) => r.quality !== "good");
    $("#ovQuality").innerHTML = `<div class="row" style="gap:6px"><span class="pill good">${q.good} good</span><span class="pill warn">${q.warn} warning</span><span class="pill bad">${q.bad} bad</span></div>
      <div class="list mt">${issues.slice(0, 7).map((r) => `<div class="list-row"><span class="k mono">${esc(r.channel)}</span><span class="pill ${r.quality}">${esc(r.issues.join(", "))}</span></div>`).join("") || `<div class="dim small">All channels look clean after preprocessing. ✓</div>`}</div>
      ${q.bad ? `<button class="btn btn-sm mt" id="ovMarkBad">Mark ${q.bad} bad channel(s)</button>` : ""}`;
    const mb = $("#ovMarkBad");
    if (mb) mb.onclick = async () => {
      const bads = [...new Set([...S.ds.bads, ...st.rows.filter((r) => r.quality === "bad").map((r) => r.channel)])];
      setDs(await task("Updating channels…", () => api(dsUrl("/channels"), { method: "POST", body: { bads } }))); render();
      toast(`Marked as bad: ${bads.join(", ")}. Enable “Interpolate bad channels” in Preprocessing to rebuild them.`, "ok", 6000);
    };
  },
};

// ── Signal browser ──
VIEWS.signals = {
  html() {
    const sg = S.sig;
    return head("Signal browser", "Scroll through the recording. ←/→ move · Shift+←/→ half page · ↑/↓ amplitude · click the overview strip to jump. Turn on <b>Add marker</b> and click the traces to annotate events.",
      `${seg("sgStage", [["processed", "Processed"], ["raw", "Raw"]], sg.stage)}
       <label class="check"><input type="checkbox" id="sgOverlay" ${sg.overlay ? "checked" : ""}> Overlay raw</label>
       <button class="btn" id="sgNative" title="Open the interactive MNE (Qt) browser on this computer"><svg viewBox="0 0 24 24"><path d="M14 3h7v7M21 3l-9 9"/></svg>MNE browser</button>`) + `
    <div class="card flush">
      <div class="sig-toolbar">
        <button class="icon-btn" id="sgPrev" title="Previous (←)"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="time-readout" id="sgTime"></span>
        <button class="icon-btn" id="sgNext" title="Next (→)"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px">Window
          <select id="sgDur">${[2, 5, 10, 20, 30, 60, 120].map((v) => `<option ${v === sg.dur ? "selected" : ""} value="${v}">${v} s</option>`).join("")}</select></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px">Scale
          <select id="sgScale">${[5, 10, 20, 50, 100, 200, 500, 1000, 5000].map((v) => `<option ${v === sg.scale ? "selected" : ""} value="${v}">${v} µV</option>`).join("")}</select></label>
        <label class="check"><input type="checkbox" id="sgCenter" ${sg.center ? "checked" : ""}> Remove DC (display)</label>
        <span class="grow"></span>
        <label class="check"><span class="switch"><input type="checkbox" id="sgAdd" ${sg.addMode ? "checked" : ""}><span></span></span>Add marker</label>
        <input type="text" id="sgLabel" value="${esc(sg.label)}" style="width:120px" placeholder="label">
      </div>
      <div id="minimap"></div>
      <div id="sigPlot" style="height:calc(100vh - 290px);min-height:420px"></div>
      <div style="padding:10px 12px;border-top:1px solid var(--border)"><div class="chips" id="sgChips"></div></div>
    </div>`;
  },
  init() {
    const sg = S.sig;
    bindSeg("sgStage", (v) => { sg.stage = v; this.draw(); });
    $("#sgOverlay").onchange = (e) => { sg.overlay = e.target.checked; this.draw(); };
    $("#sgCenter").onchange = (e) => { sg.center = e.target.checked; this.draw(); };
    $("#sgDur").onchange = (e) => { sg.dur = +e.target.value; this.draw(); };
    $("#sgScale").onchange = (e) => { sg.scale = +e.target.value; this.draw(); };
    $("#sgPrev").onclick = () => this.move(-1);
    $("#sgNext").onclick = () => this.move(1);
    $("#sgAdd").onchange = (e) => { sg.addMode = e.target.checked; $("#sigPlot").style.cursor = sg.addMode ? "crosshair" : ""; };
    $("#sgLabel").oninput = (e) => { sg.label = e.target.value; };
    $("#sgNative").onclick = () => openNative("raw", sg.stage);
    this.chips();
    this.minimap();
    this.draw();
  },
  total() { return S.sig.stage === "raw" ? S.ds.duration : S.ds.processed_duration || S.ds.duration; },
  move(dir, frac = 1) { const sg = S.sig; sg.start = Math.min(Math.max(0, sg.start + dir * sg.dur * frac), Math.max(0, this.total() - sg.dur)); this.draw(); },
  chips() {
    const el = $("#sgChips");
    el.innerHTML = `<span class="dim small" style="margin-right:4px">Channels:</span>` + S.ds.channels.map((c) => `<span class="chipbtn ${S.sig.hidden.has(c.name) ? "" : "on"} ${c.bad ? "bad" : ""}" data-ch="${esc(c.name)}" title="${c.bad ? "marked bad" : ""}">${esc(c.name)}</span>`).join("")
      + `<span class="chipbtn" data-all="1">all</span><span class="chipbtn" data-none="1">none</span>`;
    el.onclick = (e) => {
      const c = e.target.closest(".chipbtn"); if (!c) return;
      if (c.dataset.all) S.sig.hidden.clear();
      else if (c.dataset.none) S.ds.channels.forEach((x) => S.sig.hidden.add(x.name));
      else { const n = c.dataset.ch; S.sig.hidden.has(n) ? S.sig.hidden.delete(n) : S.sig.hidden.add(n); }
      this.chips(); this.draw();
    };
  },
  minimap() {
    const env = S.ds.envelope; const t = env.values.map((_, i) => i * env.step);
    plot("#minimap", [{ x: t, y: env.values, type: "scatter", mode: "lines", line: { color: css("--text-dim"), width: 1 }, fill: "tozeroy", fillcolor: "rgba(127,127,127,.12)", hoverinfo: "skip" }],
      baseLayout({ margin: { l: 70, r: 16, t: 4, b: 4 }, xaxis: { visible: false, range: [0, S.ds.duration], fixedrange: true }, yaxis: { visible: false, fixedrange: true }, dragmode: false }), { displayModeBar: false });
    $("#minimap").on("plotly_click", (ev) => { S.sig.start = Math.max(0, Math.min(ev.points[0].x - S.sig.dur / 2, this.total() - S.sig.dur)); this.draw(); });
  },
  async draw() {
    const sg = S.sig, my = (this._tok = (this._tok || 0) + 1);
    const q = (stage) => api(dsUrl(`/signal?start=${sg.start}&duration=${sg.dur}&stage=${stage}&max_points=2400`));
    let w, wr;
    try { [w, wr] = await Promise.all([q(sg.stage), sg.overlay && sg.stage === "processed" ? q("raw") : null]); }
    catch (e) { toast(esc(e.message), "err"); return; }
    if (my !== this._tok || !$("#sigPlot")) return;
    const vis = w.channels.map((c, i) => [c, i]).filter(([c]) => !sg.hidden.has(c));
    const n = vis.length, bads = new Set(S.ds.bads);
    const traces = [];
    const center = (arr) => { if (!sg.center) return arr; let m = 0; for (const v of arr) m += v; m /= arr.length || 1; return arr.map((v) => v - m); };
    const accent = css("--accent-light"), red = css("--red");
    vis.forEach(([c, i], k) => {
      const off = (n - 1 - k);
      if (wr) {
        const j = wr.channels.indexOf(c);
        if (j >= 0) traces.push({ x: wr.times, y: center(wr.data[j]).map((v) => v / sg.scale + off), type: "scattergl", mode: "lines", line: { color: "rgba(150,150,150,.35)", width: 1 }, hoverinfo: "skip", showlegend: false });
      }
      traces.push({ x: w.times, y: center(w.data[i]).map((v) => v / sg.scale + off), type: "scattergl", mode: "lines", name: c,
        line: { color: bads.has(c) ? red : accent, width: 1 }, opacity: bads.has(c) ? .55 : 1, hoverinfo: "skip", showlegend: false });
    });
    const { shapes, labels } = annShapes(w.annotations, "paper");
    const L = baseLayout({
      margin: { l: 70, r: 16, t: 22, b: 34 }, shapes, annotations: labels, hovermode: false, dragmode: "zoom",
      xaxis: { range: [sg.start, sg.start + sg.dur], title: { text: "time (s)", font: { size: 10 } }, showgrid: true },
      yaxis: { tickvals: vis.map((_, k) => n - 1 - k), ticktext: vis.map(([c]) => c), range: [-1, Math.max(n, 1)], showgrid: false, zeroline: false, fixedrange: true, tickfont: { family: "Geist Mono", size: 11 } },
    });
    L.shapes.push({ type: "line", xref: "paper", yref: "y", x0: 1.002, x1: 1.002, y0: -0.5, y1: 0.5, line: { color: css("--text-2"), width: 2 } });
    L.annotations.push({ xref: "paper", yref: "y", x: 1, y: -.8, text: `${sg.scale} µV`, showarrow: false, xanchor: "right", font: { size: 10, family: "Geist Mono" } });
    const el = plot("#sigPlot", traces, L, { scrollZoom: false });
    $("#sgTime").textContent = `${fmtTime(sg.start)} – ${fmtTime(Math.min(sg.start + sg.dur, w.total))} / ${fmtTime(w.total)}`;
    Plotly.relayout($("#minimap"), { shapes: [{ type: "rect", xref: "x", yref: "paper", x0: sg.start, x1: sg.start + sg.dur, y0: 0, y1: 1, fillcolor: "rgba(50,145,255,.25)", line: { color: accent, width: 1 } }] });
    el.removeAllListeners && el.removeAllListeners("plotly_click");
    el.on("plotly_click", async (ev) => {
      if (!sg.addMode) return;
      const x = ev.points[0].x; const label = (sg.label || "marker").trim();
      setDs(await task("Adding marker…", () => api(dsUrl("/annotations"), { method: "POST", body: { items: [{ onset: x, duration: 0, description: label }] } })));
      toast(`Marker “${esc(label)}” at ${x.toFixed(3)} s`, "ok", 2000); this.draw();
    });
  },
};

document.addEventListener("keydown", (e) => {
  if (S.view !== "signals" || !S.ds || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  const V = VIEWS.signals;
  if (e.key === "ArrowRight") { V.move(1, e.shiftKey ? .5 : 1); e.preventDefault(); }
  if (e.key === "ArrowLeft") { V.move(-1, e.shiftKey ? .5 : 1); e.preventDefault(); }
  const scales = [5, 10, 20, 50, 100, 200, 500, 1000, 5000];
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    let i = scales.indexOf(S.sig.scale); i = Math.min(scales.length - 1, Math.max(0, i + (e.key === "ArrowUp" ? -1 : 1)));
    S.sig.scale = scales[i]; const sel = $("#sgScale"); if (sel) sel.value = S.sig.scale; V.draw(); e.preventDefault();
  }
});

// ── Channels ──
VIEWS.channels = {
  html() {
    return head("Channels & quality", "Rename channels or assign 10-20 positions (needed for topomaps & interpolation), mark bad channels, and inspect per-channel statistics.",
      `${seg("chStage", [["processed", "After processing"], ["raw", "Raw"]], this.stage || "processed")}<button class="btn" id="chReset">Reset to PiEEG 10-20</button><button class="btn" id="chOrig">Use original names</button>`) + `
    <div class="grid g3">
      <div class="card span2 flush"><div class="card-head"><h2>Channel table <span class="sub">click a column to sort</span></h2>
        <div class="row"><button class="btn btn-sm" id="chAutoBad">Mark “bad” quality as bad</button><button class="btn btn-sm btn-primary" id="chSave" disabled>Save names</button></div></div>
        <div class="table-wrap" style="margin:12px 16px 16px;max-height:calc(100vh - 260px)" id="chTable"><div class="skeleton" style="height:300px"></div></div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><div class="card-head"><h2>Sensor layout</h2><button class="btn btn-sm btn-ghost" id="chNative3d">3-D (MNE)</button></div><div class="img-box" id="chSensors"></div></div>
        <div class="card"><div class="card-head"><h2>Amplitude spread <span class="sub">std per channel (µV)</span></h2></div><div id="chStd" class="plot" style="min-height:220px"></div></div>
      </div>
    </div>`;
  },
  async init() {
    this.stage = this.stage || "processed";
    bindSeg("chStage", (v) => { this.stage = v; this.load(); });
    $("#chReset").onclick = () => this.reload(true);
    $("#chOrig").onclick = () => this.reload(false);
    $("#chNative3d").onclick = () => openNative("sensors");
    $("#chSave").onclick = () => this.save();
    $("#chAutoBad").onclick = async () => {
      const bads = [...new Set([...S.ds.bads, ...this.st.rows.filter((r) => r.quality === "bad").map((r) => r.channel)])];
      setDs(await task("Updating…", () => api(dsUrl("/channels"), { method: "POST", body: { bads } }))); this.load();
    };
    mneImg("#chSensors", "sensors");
    this.load();
  },
  async reload(map) {
    setDs(await task("Reloading…", () => api(dsUrl("/reload"), { method: "POST", body: { sfreq: S.ds.sfreq, map_10_20: map } }))); render();
  },
  async load() {
    this.st = await api(dsUrl(`/stats?stage=${this.stage}`));
    if (!$("#chTable")) return;
    this.sortKey = this.sortKey || null;
    this.table();
    const rows = this.st.rows;
    plot("#chStd", [{ type: "bar", x: rows.map((r) => r.channel), y: rows.map((r) => r.std), marker: { color: rows.map((r) => r.quality === "bad" ? css("--red") : r.quality === "warn" ? css("--yellow") : css("--accent-light")) }, hovertemplate: "%{x}: %{y:.1f} µV<extra></extra>" }],
      baseLayout({ margin: { l: 40, r: 8, t: 6, b: 46 }, yaxis: { type: rows.some((r) => r.std > 200) ? "log" : "linear" } }));
  },
  table() {
    const pos = S.health.positions;
    const chInfo = Object.fromEntries(S.ds.channels.map((c) => [c.name, c]));
    let rows = [...this.st.rows];
    if (this.sortKey) { const k = this.sortKey, d = this.sortDir; rows.sort((a, b) => ((a[k] > b[k]) - (a[k] < b[k])) * d); }
    const cols = [["std", "Std µV"], ["ptp", "P-P µV"], ["rms", "RMS"], ["line_noise_pct", "Mains %"], ["kurtosis", "Kurt"], ["hjorth_mobility", "Mobility"], ["hjorth_complexity", "Complex."]];
    $("#chTable").innerHTML = `<table><thead><tr><th>Bad</th><th>Source</th><th>Name / 10-20 position</th><th class="sortable" data-k="quality">Quality</th>${cols.map(([k, l]) => `<th class="sortable" data-k="${k}" style="text-align:right">${l}</th>`).join("")}<th>Issues</th></tr></thead><tbody>
      ${rows.map((r) => { const c = chInfo[r.channel] || {}; return `<tr class="${c.bad ? "is-bad" : ""}">
        <td><input type="checkbox" data-bad="${esc(r.channel)}" ${c.bad ? "checked" : ""}></td>
        <td class="mono dim">${esc(c.original)}</td>
        <td><input type="text" list="posList" data-ren="${esc(r.channel)}" value="${esc(r.channel)}" style="width:110px;font-family:var(--mono)"> ${c.positioned ? `<span class="pill good" title="has scalp position">●</span>` : `<span class="pill mute" title="no 10-20 position — excluded from topomaps">○</span>`}</td>
        <td><span class="pill ${r.quality}">${r.quality}</span></td>
        ${cols.map(([k]) => `<td class="num">${fmt(r[k], k.startsWith("hjorth") ? 3 : 1)}</td>`).join("")}
        <td class="small muted">${esc(r.issues.join(", "))}</td></tr>`; }).join("")}
      </tbody></table><datalist id="posList">${pos.map((p) => `<option value="${p}">`).join("")}</datalist>`;
    $$("#chTable th.sortable").forEach((th) => th.onclick = () => { const k = th.dataset.k; this.sortDir = this.sortKey === k ? -this.sortDir : -1; this.sortKey = k; this.table(); });
    $$("#chTable [data-ren]").forEach((i) => i.oninput = () => { $("#chSave").disabled = false; });
    $$("#chTable [data-bad]").forEach((i) => i.onchange = async () => {
      const bads = $$("#chTable [data-bad]").filter((x) => x.checked).map((x) => x.dataset.bad);
      setDs(await task("Updating bad channels…", () => api(dsUrl("/channels"), { method: "POST", body: { bads } })));
      mneImg("#chSensors", "sensors"); this.load();
    });
  },
  async save() {
    const rename = {};
    $$("#chTable [data-ren]").forEach((i) => { if (i.value.trim() && i.value.trim() !== i.dataset.ren) rename[i.dataset.ren] = i.value.trim(); });
    setDs(await task("Renaming channels…", () => api(dsUrl("/channels"), { method: "POST", body: { rename } })));
    toast(`Renamed ${Object.keys(rename).length} channel(s). Positions re-applied from the 10-05 montage.`, "ok");
    render();
  },
};

// ── Preprocessing pipeline ──
const PARAM_UI = {
  crop: [["tmin", "Start (s)", "num"], ["tmax", "End (s)", "num"]],
  detrend: [["type", "Mode", "sel", [["constant", "DC offset"], ["linear", "Linear drift"]]]],
  hampel: [["window", "Window (samples)", "int"], ["n_sigma", "Threshold (σ)", "num"], ["min_mad_uv", "Min MAD (µV)", "num"]],
  notch: [["freq", "Mains", "sel", [[50, "50 Hz"], [60, "60 Hz"]]], ["harmonics", "Harmonics", "bool"], ["method", "Method", "sel", [["fir", "FIR"], ["iir", "IIR"]]], ["width", "Width (Hz)", "num"]],
  bandpass: [["l_freq", "Low cut (Hz)", "num"], ["h_freq", "High cut (Hz)", "num"], ["method", "Design", "sel", [["fir", "FIR (linear phase)"], ["iir", "IIR"]]],
    ["ftype", "IIR type", "sel", [["butter", "Butterworth"], ["cheby1", "Chebyshev I"], ["cheby2", "Chebyshev II"], ["ellip", "Elliptic"], ["bessel", "Bessel"]], (p) => p.method === "iir"],
    ["order", "IIR order", "int", null, (p) => p.method === "iir"], ["fir_window", "FIR window", "sel", [["hamming", "Hamming"], ["hann", "Hann"], ["blackman", "Blackman"]], (p) => p.method !== "iir"],
    ["phase", "Phase", "sel", [["zero", "Zero (offline)"], ["causal", "Causal (real-time like)"]]]],
  interpolate: [["reset_bads", "Clear bad flags after", "bool"]],
  reference: [["ref", "Reference", "sel", [["average", "Common average (CAR)"], ["channels", "Selected channels"]]], ["channels", "Reference channels", "chans", null, (p) => p.ref === "channels"]],
  resample: [["sfreq", "New rate (Hz)", "num"]],
  ica: [],
};
const PRESETS = {
  "PiEEG-server default": [["detrend", true, {}], ["notch", true, {}], ["bandpass", true, { l_freq: 1, h_freq: 40, method: "iir", order: 5, ftype: "butter", phase: "causal" }]],
  "Research (FIR 1–40 Hz)": [["detrend", true, {}], ["hampel", true, {}], ["notch", true, {}], ["bandpass", true, { l_freq: 1, h_freq: 40, method: "fir", phase: "zero" }], ["interpolate", true, {}], ["reference", true, { ref: "average" }]],
  "ERP (0.1–30 Hz)": [["detrend", true, { type: "linear" }], ["notch", true, {}], ["bandpass", true, { l_freq: 0.1, h_freq: 30, method: "fir", phase: "zero" }], ["reference", true, { ref: "average" }]],
  "Sleep (0.3–35 Hz)": [["detrend", true, {}], ["notch", true, {}], ["bandpass", true, { l_freq: 0.3, h_freq: 35, method: "fir" }], ["resample", true, { sfreq: 100 }]],
  "Neurofeedback (2–30 Hz)": [["detrend", true, {}], ["hampel", true, {}], ["notch", true, {}], ["bandpass", true, { l_freq: 2, h_freq: 30, method: "iir", order: 4, phase: "causal" }]],
  "Raw (no processing)": [],
};
VIEWS.pipeline = {
  html() {
    return head("Preprocessing pipeline", "Build a reproducible MNE processing chain. Steps run top-to-bottom; changes are applied instantly to every view and can be exported as Python code.",
      `<select id="ppPreset"><option value="">Load preset…</option>${Object.keys(PRESETS).map((k) => `<option>${k}</option>`).join("")}</select>
       <button class="btn" id="ppSave" title="Download pipeline as JSON">Save preset</button><button class="btn" id="ppLoad">Load JSON</button>
       <label class="check"><span class="switch"><input type="checkbox" id="ppAuto" ${S.autoApply ? "checked" : ""}><span></span></span>Live apply</label>
       <button class="btn btn-primary" id="ppApply">Apply</button>`) + `
    <div class="grid g2">
      <div class="card"><div class="card-head"><h2>Steps</h2>
        <div class="row"><select id="ppAddSel">${S.health.steps.map((s) => `<option value="${s.type}">${esc(s.label)}</option>`).join("")}</select><button class="btn btn-sm" id="ppAdd">+ Add step</button></div></div>
        <div class="pipe" id="ppSteps"></div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><div class="card-head"><h2>Before / after spectrum <span class="sub">mean PSD over good channels</span></h2></div><div id="ppCompare" class="plot" style="min-height:300px"></div></div>
        <div class="card"><div class="card-head"><h2>Filter response <span class="sub">mne.viz.plot_filter of your band-pass</span></h2></div><div class="img-box" id="ppFilter"></div></div>
      </div>
    </div>`;
  },
  init() {
    this.steps();
    this.refreshSide();
    $("#ppAuto").onchange = (e) => { S.autoApply = e.target.checked; };
    $("#ppApply").onclick = () => this.apply(true);
    $("#ppAdd").onclick = () => {
      const t = $("#ppAddSel").value, def = S.health.steps.find((s) => s.type === t);
      const idx = S.pipe.findIndex((s) => s.type === "ica"); const st = { type: t, enabled: true, params: clone(def.defaults) };
      t === "ica" || idx < 0 ? S.pipe.push(st) : S.pipe.splice(idx, 0, st);
      this.steps(); this.changed();
    };
    $("#ppPreset").onchange = (e) => {
      const p = PRESETS[e.target.value]; if (!p) return;
      const defs = Object.fromEntries(S.health.steps.map((s) => [s.type, s]));
      const keepIca = S.pipe.find((s) => s.type === "ica") || { type: "ica", enabled: false, params: {} };
      S.pipe = p.map(([t, en, pr]) => ({ type: t, enabled: en, params: { ...clone(defs[t].defaults), ...(t === "notch" ? { freq: (S.ds.pipeline.find((s) => s.type === "notch")?.params.freq) || 50 } : {}), ...pr } }));
      S.pipe.push(keepIca);
      e.target.value = ""; this.steps(); this.apply(true);
    };
    $("#ppSave").onclick = () => downloadBlob(new Blob([JSON.stringify({ pieeg_studio_pipeline: 1, steps: S.pipe }, null, 2)], { type: "application/json" }), "pieeg_pipeline.json");
    $("#ppLoad").onclick = () => $("#presetInput").click();
  },
  steps() {
    const defs = Object.fromEntries(S.health.steps.map((s) => [s.type, s]));
    const logBy = Object.fromEntries((S.ds.log || []).map((l) => [l.index, l]));
    $("#ppSteps").innerHTML = S.pipe.map((s, i) => {
      const d = defs[s.type] || { label: s.type, description: "" }; const p = s.params || {};
      const fields = (PARAM_UI[s.type] || []).filter((f) => !f[4] || f[4](p)).map(([k, label, kind, opts]) => {
        const v = p[k];
        if (kind === "sel") return `<label class="field">${label}<select data-i="${i}" data-k="${k}">${opts.map(([ov, ol]) => `<option value="${ov}" ${String(ov) === String(v) ? "selected" : ""}>${ol}</option>`).join("")}</select></label>`;
        if (kind === "bool") return `<label class="check" style="height:30px"><input type="checkbox" data-i="${i}" data-k="${k}" ${v ? "checked" : ""}> ${label}</label>`;
        if (kind === "chans") return `<label class="field wide">${label}<div class="chips">${S.ds.channels.map((c) => `<span class="chipbtn ${(v || []).includes(c.name) ? "on" : ""}" data-i="${i}" data-k="${k}" data-ch="${esc(c.name)}">${esc(c.name)}</span>`).join("")}</div></label>`;
        return `<label class="field">${label}<input type="number" step="any" data-i="${i}" data-k="${k}" data-kind="${kind}" value="${v ?? ""}" placeholder="${k === "tmax" ? "end" : k === "width" ? "auto" : ""}"></label>`;
      }).join("");
      const lg = logBy[i];
      const extra = s.type === "ica" ? `<div class="step-body small muted">${S.ds.ica ? `ICA fitted (${S.ds.ica.n_components} comps) · excluded: ${S.ds.ica.exclude.map((x) => "IC" + String(x).padStart(2, "0")).join(", ") || "none"}` : "Not fitted yet."} <button class="btn btn-sm" data-go="artifacts">Open ICA</button></div>` : "";
      return `<div class="step ${s.enabled ? "on" : "off"}" data-i="${i}">
        <div class="step-head"><span class="step-idx">${i + 1}</span>
          <div class="step-title"><b>${esc(d.label)}</b><small title="${esc(d.description)}">${esc(d.description)}</small></div>
          <button class="icon-btn" style="width:26px;height:26px" data-up="${i}" title="Move up"><svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg></button>
          <button class="icon-btn" style="width:26px;height:26px" data-down="${i}" title="Move down"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
          <button class="icon-btn btn-danger" style="width:26px;height:26px" data-del="${i}" title="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
          <label class="switch"><input type="checkbox" data-en="${i}" ${s.enabled ? "checked" : ""}><span></span></label></div>
        ${s.enabled && fields ? `<div class="step-body">${fields}</div>` : ""}${s.enabled ? extra : ""}
        ${s.enabled && lg ? `<div class="step-log ${lg.ok ? "" : "err"}">${lg.ok ? "✓" : "✕"} ${esc(lg.message)}${lg.ms !== undefined ? ` · ${lg.ms} ms` : ""}</div>` : ""}</div>`;
    }).join("") || `<div class="note">No steps. Add one or load a preset.</div>`;
    const box = $("#ppSteps");
    box.onchange = (e) => {
      const t = e.target;
      if (t.dataset.en !== undefined) { S.pipe[+t.dataset.en].enabled = t.checked; this.steps(); return this.changed(); }
      if (t.dataset.k === undefined) return;
      const s = S.pipe[+t.dataset.i]; let v;
      if (t.type === "checkbox") v = t.checked;
      else if (t.type === "number") v = t.value === "" ? null : (t.dataset.kind === "int" ? parseInt(t.value, 10) : parseFloat(t.value));
      else v = /^\d+(\.\d+)?$/.test(t.value) ? parseFloat(t.value) : t.value;
      s.params[t.dataset.k] = v;
      if (t.tagName === "SELECT") this.steps();
      this.changed();
    };
    box.onclick = (e) => {
      const b = e.target.closest("[data-up],[data-down],[data-del],.chipbtn"); if (!b) return;
      if (b.classList.contains("chipbtn")) { const s = S.pipe[+b.dataset.i]; const arr = new Set(s.params[b.dataset.k] || []); arr.has(b.dataset.ch) ? arr.delete(b.dataset.ch) : arr.add(b.dataset.ch); s.params[b.dataset.k] = [...arr]; this.steps(); return this.changed(); }
      const i = +(b.dataset.up ?? b.dataset.down ?? b.dataset.del);
      if (b.dataset.del !== undefined) S.pipe.splice(i, 1);
      else { const j = b.dataset.up !== undefined ? i - 1 : i + 1; if (j < 0 || j >= S.pipe.length) return;[S.pipe[i], S.pipe[j]] = [S.pipe[j], S.pipe[i]]; }
      this.steps(); this.changed();
    };
  },
  changed() { if (!S.autoApply) return; clearTimeout(S.applyTimer); S.applyTimer = setTimeout(() => this.apply(), 650); },
  async apply(force) {
    clearTimeout(S.applyTimer);
    const info = await task("Running pipeline…", () => api(dsUrl("/pipeline"), { method: "PUT", body: { steps: S.pipe } }));
    setDs(info);
    if (S.view !== "pipeline") return;
    this.steps(); this.refreshSide();
    const errs = info.log.filter((l) => !l.ok);
    errs.forEach((l) => toast(`${esc(l.label)}: ${esc(l.message)}`, "err", 7000));
    if (force && !errs.length) toast(`Pipeline applied · ${info.log.length} step(s)`, "ok", 1800);
  },
  async refreshSide() {
    mneImg("#ppFilter", "filter");
    const c = await api(dsUrl("/compare_psd?fmax=" + Math.min(100, S.ds.sfreq / 2)));
    if (!$("#ppCompare")) return;
    const mean = (j) => j.mean_db;
    const bandsShapes = Object.entries(c.processed.bands).map(([b, [lo, hi]]) => ({ type: "rect", xref: "x", yref: "paper", x0: lo, x1: hi, y0: 0, y1: 1, fillcolor: bandColor(b), opacity: .06, line: { width: 0 }, layer: "below" }));
    plot("#ppCompare", [
      { x: c.raw.freqs, y: mean(c.raw), name: "raw", mode: "lines", line: { color: css("--text-dim"), width: 1.5 } },
      { x: c.processed.freqs, y: mean(c.processed), name: "processed", mode: "lines", line: { color: css("--accent-light"), width: 2 } },
    ], baseLayout({ shapes: bandsShapes, xaxis: { title: { text: "frequency (Hz)", font: { size: 10 } } }, yaxis: { title: { text: "dB (µV²/Hz)", font: { size: 10 } } }, hovermode: "x unified" }));
  },
};

// ── Artefacts & ICA ──
VIEWS.artifacts = {
  html() {
    const d = S.ds;
    return head("Artefacts & ICA", "Detect blinks, high-amplitude segments and muscle bursts as annotations (BAD_* segments are skipped by PSD/epochs), then remove ocular/muscle components with Independent Component Analysis.") + `
    <div class="grid g3">
      <div class="card"><div class="card-head"><h2>Automatic detection</h2></div>
        <div class="list">
          <div class="list-row"><span class="k">Eye blinks<br><span class="dim small">frontal channels as EOG proxy</span></span><span class="sp"></span><input type="number" id="dtBlinkThr" placeholder="auto µV" style="width:90px"><button class="btn btn-sm" data-detect="blinks">Detect</button></div>
          <div class="list-row"><span class="k">Amplitude<br><span class="dim small">peak-to-peak above → BAD_peak</span></span><span class="sp"></span><input type="number" id="dtPeak" value="150" style="width:90px"><button class="btn btn-sm" data-detect="amplitude">Detect</button></div>
          <div class="list-row"><span class="k">Muscle (EMG)<br><span class="dim small">high-freq z-score → BAD_muscle</span></span><span class="sp"></span><input type="number" id="dtMus" value="4" style="width:90px"><button class="btn btn-sm" data-detect="muscle">Detect</button></div>
        </div>
        <div class="row mt"><button class="btn btn-sm" id="annImport">Import markers (.annotations.json / CSV)</button></div></div>
      <div class="card span2"><div class="card-head"><h2>Annotations <span class="sub">${d.n_annotations} total</span></h2></div>
        <div class="chips mb" id="annLabels">${Object.entries(d.annotation_labels).map(([k, v]) => `<span class="pill mute" style="border-left:3px solid ${hashColor(k)}">${esc(k)} <b>${v}</b> <a data-dellabel="${esc(k)}" style="cursor:pointer;color:var(--text-dim)" title="delete all">×</a></span>`).join("") || `<span class="dim small">No annotations yet.</span>`}</div>
        <div id="annPlot" class="plot" style="min-height:120px"></div></div>
    </div>
    <div class="card mt"><div class="card-head"><h2>Independent Component Analysis</h2>
      <div class="row"><label class="field" style="flex-direction:row;align-items:center;gap:6px">Components <input type="number" id="icaN" style="width:70px" value="${d.ica?.n_components || Math.min(d.n_channels - d.bads.length - 1, 20)}"></label>
        <select id="icaMethod"><option value="fastica">FastICA</option><option value="infomax">Extended Infomax</option><option value="picard">Picard</option></select>
        <button class="btn btn-primary" id="icaFit">${d.ica ? "Re-fit ICA" : "Fit ICA"}</button>
        ${d.ica ? `<button class="btn" id="icaNative">MNE sources browser</button>` : ""}</div></div>
      ${d.ica ? `<div class="note mb">Click a component to inspect it; toggle <b>Exclude</b> to remove it from the data. Red = excluded (auto-suggested from Fp-channel correlation: ${d.ica.suggested.map((i) => "IC" + String(i).padStart(2, "0")).join(", ") || "none"}).</div>
      <div class="grid g2"><div><div class="ica-grid" id="icaGrid"></div><div class="mt"><h3 class="mb">Component sources</h3><div id="icaSrc" class="plot" style="height:360px"></div></div></div>
        <div class="grid" style="align-content:start"><div class="img-box" id="icaProps"><div class="msg">Select a component</div></div><div class="img-box" id="icaComps"></div><div class="img-box" id="icaOverlay"></div></div></div>`
        : `<div class="note">ICA is fitted on the output of your pipeline (before the ICA step) with an extra 1 Hz high-pass, and bad channels are skipped. With PiEEG-8 use ≤7 components, with PiEEG-16 ≤15.</div>`}
    </div>`;
  },
  async init() {
    const d = S.ds;
    $$("[data-detect]").forEach((b) => b.onclick = async () => {
      const kind = b.dataset.detect;
      const body = { kind, threshold_uv: parseFloat($("#dtBlinkThr").value) || null, peak_uv: parseFloat($("#dtPeak").value) || 150, threshold: parseFloat($("#dtMus").value) || 4 };
      const r = await task(`Detecting ${kind}…`, () => api(dsUrl("/detect"), { method: "POST", body }));
      setDs(r.info); render();
      toast(`${r.found} ${kind} event(s) found${r.channels ? " on " + r.channels.join("/") : ""}${r.suggested_bads?.length ? ` · suggested bad channels: ${r.suggested_bads.join(", ")}` : ""}`, "ok", 6000);
    });
    $("#annImport").onclick = () => $("#annInput").click();
    $$("[data-dellabel]").forEach((a) => a.onclick = async () => { setDs(await task("Deleting…", () => api(dsUrl("/annotations/delete"), { method: "POST", body: { label: a.dataset.dellabel } }))); render(); });
    const anns = await api(dsUrl("/annotations"));
    if (!$("#annPlot")) return;
    const labs = [...new Set(anns.map((a) => a.description))];
    plot("#annPlot", labs.map((l) => { const A = anns.filter((a) => a.description === l); return { type: "scatter", mode: "markers", name: l, x: A.map((a) => a.onset), y: A.map(() => l), marker: { symbol: "line-ns-open", size: 14, color: hashColor(l), line: { width: 2 } }, hovertemplate: `${esc(l)} @ %{x:.2f} s<extra></extra>` }; }),
      baseLayout({ showlegend: false, margin: { l: 90, r: 10, t: 6, b: 30 }, xaxis: { range: [0, d.duration], title: { text: "time (s)", font: { size: 10 } } }, height: Math.max(120, 40 + 26 * labs.length) }));
    $("#icaFit").onclick = async () => {
      const info = await task("Fitting ICA (this can take ~10–60 s)…", () => api(dsUrl("/ica/fit"), { method: "POST", body: { n_components: parseInt($("#icaN").value, 10) || null, method: $("#icaMethod").value } }));
      setDs(info); S.ica.sel = info.ica.suggested[0] ?? 0; render();
      toast(`ICA fitted · ${info.ica.n_components} components · auto-excluded ${info.ica.suggested.length}`, "ok");
    };
    if (!d.ica) return;
    $("#icaMethod").value = d.ica.method;
    const nb = $("#icaNative"); if (nb) nb.onclick = () => openNative("ica");
    this.grid();
    mneImg("#icaComps", "ica_components");
    mneImg("#icaOverlay", "ica_overlay");
    if (S.ica.sel !== null) mneImg("#icaProps", "ica_properties", { comp: S.ica.sel });
    this.sources();
  },
  grid() {
    const ic = S.ds.ica;
    $("#icaGrid").innerHTML = Array.from({ length: ic.n_components }, (_, i) => `
      <div class="ica-item ${ic.exclude.includes(i) ? "ex" : ""} ${S.ica.sel === i ? "sel" : ""}" data-c="${i}">
        <div class="row" style="justify-content:space-between"><b>IC${String(i).padStart(2, "0")}</b>
          <label class="check small" onclick="event.stopPropagation()"><input type="checkbox" data-ex="${i}" ${ic.exclude.includes(i) ? "checked" : ""}>Exclude</label></div>
        <div class="meta"><span>var ${fmt(ic.explained_variance_pct[i], 1)}%</span><span>kurt ${fmt(ic.kurtosis[i], 1)}</span></div>
        ${ic.eog_scores ? `<div class="meta"><span>EOG r</span><span>${fmt(ic.eog_scores[i], 2)}</span></div>` : ""}
        ${ic.suggested.includes(i) ? `<span class="pill warn" style="margin-top:4px">likely ocular</span>` : ""}</div>`).join("");
    $("#icaGrid").onclick = (e) => { const it = e.target.closest(".ica-item"); if (!it || e.target.dataset.ex) return; S.ica.sel = +it.dataset.c; this.grid(); mneImg("#icaProps", "ica_properties", { comp: S.ica.sel }); };
    $$("#icaGrid [data-ex]").forEach((c) => c.onchange = async () => {
      const ex = $$("#icaGrid [data-ex]").filter((x) => x.checked).map((x) => +x.dataset.ex);
      setDs(await task("Applying ICA exclusion…", () => api(dsUrl("/ica/exclude"), { method: "POST", body: { exclude: ex } })));
      this.grid(); mneImg("#icaOverlay", "ica_overlay");
    });
  },
  async sources() {
    const w = await api(dsUrl(`/ica/sources?start=${S.sig.start}&duration=10`));
    if (!$("#icaSrc")) return;
    const n = w.channels.length, ex = new Set(S.ds.ica.exclude);
    const tr = w.channels.map((c, i) => { const arr = w.data[i]; const sd = Math.sqrt(arr.reduce((a, v) => a + v * v, 0) / arr.length) || 1; return { x: w.times, y: arr.map((v) => v / (4 * sd) + (n - 1 - i)), type: "scattergl", mode: "lines", line: { width: 1, color: ex.has(i) ? css("--red") : css("--accent-light") }, hoverinfo: "skip" }; });
    plot("#icaSrc", tr, baseLayout({ showlegend: false, margin: { l: 52, r: 10, t: 6, b: 30 }, yaxis: { tickvals: w.channels.map((_, i) => n - 1 - i), ticktext: w.channels.map((_, i) => "IC" + String(i).padStart(2, "0")), showgrid: false, zeroline: false, fixedrange: true } }));
  },
};

// ── Spectral ──
VIEWS.spectral = {
  html() {
    const sp = S.spec;
    return head("Spectral analysis & band power", "Welch / multitaper power spectral density, absolute & relative band powers, clinical ratios, individual alpha frequency and frontal alpha asymmetry.",
      `${seg("spStage", [["processed", "Processed"], ["raw", "Raw"]], sp.stage)}${seg("spMethod", [["welch", "Welch"], ["multitaper", "Multitaper"]], sp.method)}
       <label class="field" style="flex-direction:row;align-items:center;gap:6px">Window <select id="spWin">${[1, 2, 4, 8].map((v) => `<option ${v === sp.window ? "selected" : ""}>${v}</option>`).join("")}</select>s</label>
       <label class="field" style="flex-direction:row;align-items:center;gap:6px">f<sub>max</sub> <input type="number" id="spFmax" value="${sp.fmax}" style="width:70px"></label>`) + `
    <div class="grid g6" id="spKpis"></div>
    <div class="grid g3 mt">
      <div class="card span2"><div class="card-head"><h2>Power spectral density</h2><div class="row">${seg("spScale", [["log", "dB"], ["lin", "Linear"]], sp.log ? "log" : "lin")}<div class="legend-bands">${BAND_ORDER.map((b) => `<span><i style="background:${bandColor(b)}"></i>${b}</span>`).join("")}</div></div></div><div id="spPsd" class="plot" style="height:380px"></div></div>
      <div class="card"><div class="card-head"><h2>Hemispheric asymmetry <span class="sub">ln(α right) − ln(α left)</span></h2></div><div id="spFaa"></div>
        <div class="note small mt">Positive frontal values (F4–F3) = relatively more left-frontal activity, linked to approach motivation (Davidson model).</div></div>
    </div>
    <div class="card mt"><div class="card-head"><h2>Topographic band maps <span class="sub">mne.viz.plot_topomap</span></h2>${seg("spTopoMode", [["relative", "Relative"], ["absolute", "Absolute"]], sp.mode)}</div><div class="img-box" id="spTopo"></div></div>
    <div class="grid g2 mt">
      <div class="card"><div class="card-head"><h2>Relative band power per channel</h2></div><div id="spBars" class="plot" style="height:340px"></div></div>
      <div class="card flush"><div class="card-head"><h2>Band power table</h2>${seg("spTab", [["relative", "%"], ["absolute", "µV²"]], this.tab || "relative")}</div><div class="table-wrap" style="margin:12px 16px 16px;max-height:300px" id="spTable"></div></div>
    </div>`;
  },
  init() {
    const sp = S.spec;
    bindSeg("spStage", (v) => { sp.stage = v; this.load(); });
    bindSeg("spMethod", (v) => { sp.method = v; this.load(); });
    bindSeg("spScale", (v) => { sp.log = v === "log"; this.drawPsd(); });
    bindSeg("spTopoMode", (v) => { sp.mode = v; mneImg("#spTopo", "topomap", { band_mode: v, stage: sp.stage }); });
    bindSeg("spTab", (v) => { this.tab = v; this.table(); });
    $("#spWin").onchange = (e) => { sp.window = +e.target.value; this.load(); };
    $("#spFmax").onchange = (e) => { sp.fmax = +e.target.value || 60; this.load(); };
    this.load();
  },
  async load() {
    const sp = S.spec;
    mneImg("#spTopo", "topomap", { band_mode: sp.mode, stage: sp.stage });
    const [psd, bp] = await Promise.all([
      api(dsUrl(`/psd?fmin=0.5&fmax=${sp.fmax}&method=${sp.method}&window_s=${sp.window}&stage=${sp.stage}`)),
      api(dsUrl(`/bands?stage=${sp.stage}&method=${sp.method}`)),
    ]);
    if (!$("#spKpis")) return;
    this.psd = psd; this.bp = bp;
    this.drawPsd(); this.kpis(); this.bars(); this.table();
  },
  drawPsd() {
    const p = this.psd, sp = S.spec; if (!p || !$("#spPsd")) return;
    const bads = new Set(p.bads);
    const tr = p.channels.map((c, i) => ({ x: p.freqs, y: sp.log ? p.db[i] : p.psd[i], name: c, mode: "lines", line: { width: 1, color: bads.has(c) ? css("--red") : undefined }, opacity: bads.has(c) ? .4 : .75, hovertemplate: `${c} · %{x:.1f} Hz · %{y:.2f}<extra></extra>` }));
    const good = p.channels.map((c, i) => i).filter((i) => !bads.has(p.channels[i]));
    const meanLin = p.freqs.map((_, k) => good.reduce((a, i) => a + p.psd[i][k], 0) / (good.length || 1));
    tr.push({ x: p.freqs, y: sp.log ? meanLin.map((v) => 10 * Math.log10(Math.max(v, 1e-12))) : meanLin, name: "mean", mode: "lines", line: { width: 3, color: css("--text") } });
    const shapes = Object.entries(p.bands).map(([b, [lo, hi]]) => ({ type: "rect", xref: "x", yref: "paper", x0: lo, x1: hi, y0: 0, y1: 1, fillcolor: bandColor(b), opacity: .07, line: { width: 0 }, layer: "below" }));
    plot("#spPsd", tr, baseLayout({ shapes, showlegend: true, legend: { orientation: "v", x: 1.01, y: 1, font: { size: 10 } }, margin: { l: 52, r: 8, t: 8, b: 38 },
      xaxis: { title: { text: "frequency (Hz)", font: { size: 10 } } }, yaxis: { title: { text: sp.log ? "dB (µV²/Hz)" : "µV²/Hz", font: { size: 10 } } } }));
  },
  kpis() {
    const bp = this.bp; const g = bp.rows.filter((r) => !r.bad);
    const avg = (k) => { const v = g.map((r) => r[k]).filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const faa = bp.asymmetry.find((a) => a.pair === "F4–F3") || bp.asymmetry[0];
    const k = [
      ["Peak alpha", fmt(avg("iaf"), 1), "Hz", "individual alpha frequency"],
      ["Theta / beta", fmt(avg("theta_beta"), 2), "", "attention marker"],
      ["Alpha / theta", fmt(avg("alpha_theta"), 2), "", "relaxed alertness"],
      ["Engagement", fmt(avg("engagement"), 2), "", "β / (α + θ)"],
      ["Alpha asym.", faa ? fmt(faa.value, 3) : "—", "", faa ? faa.pair + " (ln α)" : "needs symmetric pair"],
      ["1/f slope", fmt(avg("slope"), 2), "", "aperiodic exponent"],
    ];
    $("#spKpis").innerHTML = k.map(([l, v, u, h]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}<small>${u}</small></div><div class="hint">${h}</div></div>`).join("");
    $("#spFaa").innerHTML = bp.asymmetry.length ? bp.asymmetry.map((a) => { const w = Math.min(50, Math.abs(a.value) * 60); return `<div class="list-row"><span class="k mono" style="flex-basis:80px">${a.pair}</span><div style="flex:1;position:relative;height:8px;background:var(--surface);border-radius:4px"><i style="position:absolute;top:0;bottom:0;${a.value >= 0 ? "left:50%" : `right:50%`};width:${w}%;background:${a.value >= 0 ? css("--green") : css("--yellow")};border-radius:4px"></i><i style="position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--text-dim)"></i></div><span class="mono small" style="width:60px;text-align:right">${fmt(a.value, 3)}</span></div>`; }).join("") : `<div class="dim small">Needs symmetric 10-20 pairs (F3/F4, C3/C4, O1/O2…).</div>`;
  },
  bars() {
    const bp = this.bp; const bands = Object.keys(bp.bands);
    plot("#spBars", bands.map((b) => ({ type: "bar", name: b, x: bp.rows.map((r) => r.channel), y: bp.rows.map((r) => (r.relative[b] || 0) * 100), marker: { color: bandColor(b) }, hovertemplate: `%{x} · ${b}: %{y:.1f}%<extra></extra>` })),
      baseLayout({ barmode: "stack", yaxis: { title: { text: "% of 0.5–45 Hz power", font: { size: 10 } }, range: [0, 100] }, margin: { l: 50, r: 8, t: 30, b: 46 } }));
  },
  table() {
    const bp = this.bp; if (!bp) return; const bands = Object.keys(bp.bands); const rel = (this.tab || "relative") === "relative";
    const max = Object.fromEntries(bands.map((b) => [b, Math.max(...bp.rows.map((r) => (rel ? r.relative[b] : r.absolute[b]) || 0))]));
    $("#spTable").innerHTML = `<table><thead><tr><th>Channel</th>${bands.map((b) => `<th style="color:${bandColor(b)}">${b}</th>`).join("")}<th style="text-align:right">IAF</th><th style="text-align:right">θ/β</th><th style="text-align:right">SEF95</th><th style="text-align:right">Entropy</th></tr></thead><tbody>
      ${bp.rows.map((r) => `<tr class="${r.bad ? "is-bad" : ""}"><td class="mono">${esc(r.channel)}</td>${bands.map((b) => { const v = rel ? r.relative[b] : r.absolute[b]; return `<td><div class="bar-cell"><i style="width:${(v || 0) / (max[b] || 1) * 46}px;background:${bandColor(b)}"></i><span class="mono small">${rel ? fmt(v * 100, 1) : fmt(v, 1)}</span></div></td>`; }).join("")}
      <td class="num">${fmt(r.iaf, 1)}</td><td class="num">${fmt(r.theta_beta, 2)}</td><td class="num">${fmt(r.sef95, 1)}</td><td class="num">${fmt(r.entropy, 3)}</td></tr>`).join("")}</tbody></table>`;
  },
};

// ── Time-frequency ──
VIEWS.tf = {
  html() {
    const chs = S.ds.channels.map((c) => c.name);
    S.tf.channel = S.tf.channel && chs.includes(S.tf.channel) ? S.tf.channel : (chs.find((c) => /^O1|Oz|Pz$/.test(c)) || chs[0]);
    return head("Time–frequency", "Short-time spectrogram of one channel and the evolution of relative band power over the whole session (mean of good channels) — great for eyes-open/closed, meditation or task blocks.",
      `<label class="field" style="flex-direction:row;align-items:center;gap:6px">Channel <select id="tfCh">${chs.map((c) => `<option ${c === S.tf.channel ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
       <label class="field" style="flex-direction:row;align-items:center;gap:6px">Window <select id="tfWin">${[0.5, 1, 2, 4].map((v) => `<option ${v === S.tf.window ? "selected" : ""}>${v}</option>`).join("")}</select>s</label>
       <label class="field" style="flex-direction:row;align-items:center;gap:6px">f<sub>max</sub> <input type="number" id="tfFmax" value="${S.tf.fmax}" style="width:70px"></label>`) + `
    <div class="card"><div class="card-head"><h2>Spectrogram <span class="sub" id="tfSub"></span></h2></div><div id="tfSpec" class="plot" style="height:380px"></div></div>
    <div class="card mt"><div class="card-head"><h2>Band power timeline <span class="sub">2 s windows, 0.5 s step</span></h2>${seg("tfRel", [["1", "Relative"], ["0", "Absolute"]], this.rel ?? "1")}</div><div id="tfBands" class="plot" style="height:320px"></div></div>`;
  },
  init() {
    $("#tfCh").onchange = (e) => { S.tf.channel = e.target.value; this.spec(); };
    $("#tfWin").onchange = (e) => { S.tf.window = +e.target.value; this.spec(); };
    $("#tfFmax").onchange = (e) => { S.tf.fmax = +e.target.value || 45; this.spec(); };
    bindSeg("tfRel", (v) => { this.rel = v; this.bands(); });
    this.spec(); this.bands();
  },
  async spec() {
    const s = await api(dsUrl(`/spectrogram?channel=${encodeURIComponent(S.tf.channel)}&window_s=${S.tf.window}&fmax=${S.tf.fmax}`));
    if (!$("#tfSub")) return;
    $("#tfSub").textContent = `${s.channel} · dB µV²/Hz`;
    const { shapes, labels } = annShapes(s.annotations.filter((a) => a.description !== "blink").slice(0, 200), "paper");
    plot("#tfSpec", [{ type: "heatmap", x: s.times, y: s.freqs, z: s.db, colorscale: "Viridis", zsmooth: "best", colorbar: { thickness: 10, title: { text: "dB", side: "right" } }, hovertemplate: "%{x:.1f} s · %{y:.1f} Hz · %{z:.1f} dB<extra></extra>" }],
      baseLayout({ shapes, annotations: labels, margin: { l: 50, r: 10, t: 20, b: 38 }, xaxis: { title: { text: "time (s)", font: { size: 10 } } }, yaxis: { title: { text: "Hz", font: { size: 10 } } } }));
  },
  async bands() {
    const rel = (this.rel ?? "1") === "1";
    const b = await api(dsUrl(`/band_timecourse?relative=${rel}`));
    if (!$("#tfBands")) return;
    const { shapes, labels } = annShapes(b.annotations.filter((a) => a.description !== "blink").slice(0, 200), "paper");
    plot("#tfBands", Object.entries(b.series).map(([k, v]) => ({ x: b.times, y: rel ? v.map((x) => x * 100) : v, name: k, mode: "lines", stackgroup: rel ? "one" : undefined, line: { width: rel ? .5 : 1.6, color: bandColor(k) }, hovertemplate: `${k}: %{y:.1f}${rel ? "%" : " µV²"}<extra></extra>` })),
      baseLayout({ shapes, annotations: labels, hovermode: "x unified", legend: { orientation: "h", y: -0.22, x: 0 }, margin: { l: 50, r: 10, t: 22, b: 60 }, yaxis: { title: { text: rel ? "% power" : "µV²", font: { size: 10 } }, range: rel ? [0, 100] : undefined }, xaxis: { title: { text: "time (s)", font: { size: 10 } } } }));
  },
};

// ── ERP / epochs ──
VIEWS.erp = {
  html() {
    const labels = Object.keys(S.ds.annotation_labels).filter((l) => !/^bad|^edge/i.test(l));
    this.sel = this.sel && this.sel.filter((l) => labels.includes(l)).length ? this.sel : labels.slice();
    return head("Events, epochs & ERP", "Cut the processed signal around markers (from the PiEEG annotation column, imported marker files, detected blinks or your own clicks) and average them into event-related potentials.") + `
    <div class="card"><div class="row" style="align-items:flex-end;gap:14px">
      <label class="field">Source <select id="epSrc"><option value="annotations">Annotations / markers</option><option value="fixed">Fixed-length windows</option></select></label>
      <label class="field">Start t (s) <input type="number" step="any" id="epTmin" value="${this.p?.tmin ?? -0.2}" style="width:90px"></label>
      <label class="field">End t (s) <input type="number" step="any" id="epTmax" value="${this.p?.tmax ?? 0.8}" style="width:90px"></label>
      <label class="field">Fixed length (s) <input type="number" step="any" id="epLen" value="${this.p?.fixed_length ?? 2}" style="width:90px"></label>
      <label class="field">Reject p-p (µV) <input type="number" id="epRej" value="${this.p?.reject_uv ?? ""}" placeholder="off" style="width:90px"></label>
      <label class="check" style="height:30px"><input type="checkbox" id="epBase" ${this.p?.baseline === false ? "" : "checked"}> Baseline (t&lt;0)</label>
      <button class="btn btn-primary" id="epRun">Create epochs</button></div>
      <div class="row mt"><span class="dim small">Conditions:</span><div class="chips" id="epConds">${labels.map((l) => `<span class="chipbtn ${this.sel.includes(l) ? "on" : ""}" data-l="${esc(l)}">${esc(l)} <span class="dim">${S.ds.annotation_labels[l]}</span></span>`).join("") || `<span class="dim small">No markers — add some in the Signal browser, detect blinks, or use fixed-length windows.</span>`}</div></div></div>
    <div id="epOut"></div>`;
  },
  init() {
    if (this.p) $("#epSrc").value = this.p.source;
    $("#epConds").onclick = (e) => { const c = e.target.closest(".chipbtn"); if (!c) return; c.classList.toggle("on"); this.sel = $$("#epConds .chipbtn.on").map((x) => x.dataset.l); };
    $("#epRun").onclick = () => this.run();
    if (S.erp.result && S.erp.version === S.ds.version) this.show();
  },
  async run() {
    this.p = { source: $("#epSrc").value, tmin: parseFloat($("#epTmin").value), tmax: parseFloat($("#epTmax").value), fixed_length: parseFloat($("#epLen").value), reject_uv: parseFloat($("#epRej").value) || null, baseline: $("#epBase").checked, conditions: this.sel };
    const r = await task("Epoching…", () => api(dsUrl("/epochs"), { method: "POST", body: this.p }));
    S.ds.version += 1; S.erp.result = r; S.erp.version = S.ds.version; S.erp.cond = Object.keys(r.conditions)[0];
    if ($("#epOut")) this.show();
  },
  show() {
    const r = S.erp.result; const conds = Object.keys(r.conditions);
    if (!conds.length) { $("#epOut").innerHTML = `<div class="note warn mt">All epochs were dropped (${esc(JSON.stringify(r.drop_reasons))}). Relax the rejection threshold.</div>`; return; }
    $("#epOut").innerHTML = `
      <div class="grid g4 mt">
        <div class="card kpi"><div class="label">Epochs kept</div><div class="value">${r.n_kept}<small>/ ${r.n_total}</small></div><div class="hint">${Object.entries(r.drop_reasons).map(([k, v]) => `${esc(k)} ×${v}`).join(" · ") || "none dropped"}</div></div>
        ${conds.slice(0, 3).map((c) => `<div class="card kpi"><div class="label">${esc(c)}</div><div class="value">${r.conditions[c].n}<small>trials</small></div><div class="hint">GFP peak ${fmt(r.conditions[c].peak.gfp, 1)} µV @ ${fmt(r.conditions[c].peak.time * 1000, 0)} ms</div></div>`).join("")}
      </div>
      <div class="grid g2 mt">
        <div class="card"><div class="card-head"><h2>Condition average</h2><select id="erpCh"><option value="__gfp__">Global field power</option>${r.channels.map((c) => `<option ${c === S.erp.channel ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div><div id="erpPlot" class="plot" style="height:330px"></div></div>
        <div class="card"><div class="card-head"><h2>Butterfly</h2><select id="erpCond">${conds.map((c) => `<option ${c === S.erp.cond ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div><div id="erpButter" class="plot" style="height:330px"></div></div>
      </div>
      <div class="grid g2 mt"><div class="card"><div class="card-head"><h2>evoked.plot_joint</h2></div><div class="img-box" id="erpJoint"></div></div>
        <div class="card"><div class="card-head"><h2>epochs.plot_image</h2></div><div class="img-box" id="erpImage"></div></div></div>`;
    $("#erpCh").value = S.erp.channel;
    $("#erpCh").onchange = (e) => { S.erp.channel = e.target.value; this.cond(); };
    $("#erpCond").onchange = (e) => { S.erp.cond = e.target.value; this.butter(); };
    this.cond(); this.butter();
  },
  cond() {
    const r = S.erp.result, ch = S.erp.channel, gfp = ch === "__gfp__", i = r.channels.indexOf(ch), t = r.times.map((x) => x * 1000);
    const tr = [];
    Object.entries(r.conditions).forEach(([c, d]) => {
      const col = hashColor(c), y = gfp ? d.gfp : d.data[i];
      if (!gfp) { const s = d.sem[i]; tr.push({ x: [...t, ...t.slice().reverse()], y: [...y.map((v, k) => v + s[k]), ...y.map((v, k) => v - s[k]).reverse()], fill: "toself", fillcolor: col + "22", line: { width: 0 }, hoverinfo: "skip", showlegend: false }); }
      tr.push({ x: t, y, name: `${c} (n=${d.n})`, mode: "lines", line: { color: col, width: 2 } });
    });
    plot("#erpPlot", tr, baseLayout({ shapes: [{ type: "line", x0: 0, x1: 0, yref: "paper", y0: 0, y1: 1, line: { color: css("--text-dim"), dash: "dot", width: 1 } }], hovermode: "x unified", margin: { l: 50, r: 10, t: 30, b: 38 }, xaxis: { title: { text: "ms", font: { size: 10 } } }, yaxis: { title: { text: "µV", font: { size: 10 } } } }));
  },
  butter() {
    const r = S.erp.result, d = r.conditions[S.erp.cond], t = r.times.map((x) => x * 1000);
    plot("#erpButter", [...r.channels.map((c, i) => ({ x: t, y: d.data[i], name: c, mode: "lines", line: { width: 1 }, opacity: .8 })), { x: t, y: d.gfp, name: "GFP", mode: "lines", line: { width: 2.5, color: css("--text") } }],
      baseLayout({ showlegend: false, hovermode: "closest", margin: { l: 50, r: 10, t: 10, b: 38 }, xaxis: { title: { text: "ms", font: { size: 10 } } }, yaxis: { title: { text: "µV", font: { size: 10 } } } }));
    mneImg("#erpJoint", "evoked_joint", { condition: S.erp.cond });
    mneImg("#erpImage", "epochs_image", { condition: S.erp.cond });
  },
};

// ── Connectivity ──
VIEWS.connectivity = {
  html() {
    const c = S.conn;
    return head("Functional connectivity", "Channel-to-channel coupling in a frequency band: magnitude-squared coherence, phase-locking value, weighted phase-lag index (robust to volume conduction) or band-limited correlation.",
      `${seg("cnMethod", [["coherence", "Coherence"], ["plv", "PLV"], ["wpli", "wPLI"], ["correlation", "Correlation"]], c.method)}${seg("cnBand", BAND_ORDER.map((b) => [b, b]), c.band)}`) + `
    <div class="grid g2"><div class="card"><div class="card-head"><h2>Connectivity matrix</h2></div><div id="cnMat" class="plot" style="height:520px"></div></div>
      <div class="card"><div class="card-head"><h2>Strongest connections</h2></div><div class="img-box" id="cnCircle"></div><div id="cnTop" class="mt"></div></div></div>`;
  },
  init() {
    bindSeg("cnMethod", (v) => { S.conn.method = v; this.load(); });
    bindSeg("cnBand", (v) => { S.conn.band = v; this.load(); });
    this.load();
  },
  async load() {
    const c = S.conn;
    mneImg("#cnCircle", "circle", { method: c.method, band: c.band });
    const r = await api(dsUrl(`/connectivity?method=${c.method}&band=${c.band}`));
    if (!$("#cnMat")) return;
    const signed = c.method === "correlation";
    const z = r.matrix.map((row, i) => row.map((v, j) => (i === j ? null : v)));
    const MAGMA = [[0, "#000004"], [.25, "#3b0f70"], [.5, "#8c2981"], [.75, "#de4968"], [.9, "#fe9f6d"], [1, "#fcfdbf"]];
    plot("#cnMat", [{ type: "heatmap", z, x: r.channels, y: r.channels, colorscale: signed ? "RdBu" : MAGMA, reversescale: signed, zmin: signed ? -1 : undefined, zmax: signed ? 1 : undefined, colorbar: { thickness: 10 }, hovertemplate: "%{y} ↔ %{x}: %{z:.3f}<extra></extra>" }],
      baseLayout({ margin: { l: 60, r: 10, t: 10, b: 60 }, yaxis: { autorange: "reversed", scaleanchor: "x" }, xaxis: { tickangle: -45 } }));
    const pairs = [];
    r.channels.forEach((a, i) => r.channels.forEach((b, j) => { if (j > i) pairs.push([a, b, r.matrix[i][j]]); }));
    pairs.sort((x, y) => Math.abs(y[2]) - Math.abs(x[2]));
    $("#cnTop").innerHTML = `<div class="list">${pairs.slice(0, 8).map(([a, b, v]) => `<div class="list-row"><span class="k mono">${esc(a)} ↔ ${esc(b)}</span><span class="v">${fmt(v, 3)}</span></div>`).join("")}</div>`;
  },
};

// ── MNE lab ──
VIEWS.mne = {
  html() {
    const nv = S.health.native_viewer;
    return head("MNE visual lab", `Genuine <a href="https://mne.tools/stable/auto_tutorials/intro/10_overview.html" target="_blank" rel="noopener">MNE-Python</a> figures of your processed data, plus one-click access to MNE's interactive desktop browser and reproducible MNE code.`,
      `<button class="btn" id="mnRefresh">Re-render</button>`) + `
    <div class="card mb"><div class="card-head"><h2>Native MNE windows <span class="sub">${nv.available ? (nv.qt_browser ? "mne-qt-browser detected — full interactive browser" : "matplotlib backend · <code>pip install mne-qt-browser</code> for the fast Qt browser") : "no display detected on the machine running PiEEG Studio"}</span></h2></div>
      <div class="row">
        <button class="btn" data-native="raw">raw.plot() — scroll, mark bads, annotate</button>
        <button class="btn" data-native="psd">spectrum.plot()</button>
        <button class="btn" data-native="sensors">plot_sensors (3-D)</button>
        <button class="btn" data-native="ica" ${S.ds.ica ? "" : "disabled"}>ica.plot_sources()</button>
      </div></div>
    <div class="grid g2">
      <div class="card span2"><div class="card-head"><h2>raw.plot <span class="sub">static snapshot</span></h2>
        <div class="row"><label class="field" style="flex-direction:row;align-items:center;gap:6px">Start <input type="number" id="mnStart" value="${S.mne.start}" style="width:80px">s</label>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px">Duration <input type="number" id="mnDur" value="${S.mne.dur}" style="width:70px">s</label></div></div><div class="img-box" id="mnRaw"></div></div>
      <div class="card"><div class="card-head"><h2>compute_psd().plot</h2></div><div class="img-box" id="mnPsd"></div></div>
      <div class="card"><div class="card-head"><h2>plot_sensors</h2></div><div class="img-box" id="mnSensors"></div></div>
      <div class="card span2"><div class="card-head"><h2>plot_topomap · band powers</h2></div><div class="img-box" id="mnTopo"></div></div>
      <div class="card"><div class="card-head"><h2>plot_filter · band-pass response</h2></div><div class="img-box" id="mnFilter"></div></div>
      <div class="card"><div class="card-head"><h2>ica.plot_components</h2></div><div class="img-box" id="mnIca"></div></div>
    </div>
    <div class="card mt"><div class="card-head"><h2>Continue in Python / Jupyter</h2><div class="row"><button class="btn btn-sm" id="mnCopy">Copy</button><button class="btn btn-sm" data-export="py">Download .py</button><button class="btn btn-sm" data-export="ipynb">Download notebook</button></div></div>
      <pre class="code" id="mnCode">Loading…</pre></div>`;
  },
  async init() {
    $$("[data-native]").forEach((b) => b.onclick = () => openNative(b.dataset.native));
    const draw = () => {
      S.mne.start = +$("#mnStart").value || 0; S.mne.dur = +$("#mnDur").value || 10;
      mneImg("#mnRaw", "raw", { start: S.mne.start, duration: S.mne.dur });
      mneImg("#mnPsd", "psd"); mneImg("#mnSensors", "sensors"); mneImg("#mnTopo", "topomap"); mneImg("#mnFilter", "filter");
      if (S.ds.ica) mneImg("#mnIca", "ica_components"); else $("#mnIca").innerHTML = `<div class="msg">Fit ICA in “Artefacts & ICA” to see components.</div>`;
    };
    $("#mnRefresh").onclick = draw; $("#mnStart").onchange = draw; $("#mnDur").onchange = draw;
    draw();
    const r = await api(dsUrl("/export/py"), { raw: true }); const code = await r.text();
    if (!$("#mnCode")) return;
    $("#mnCode").innerHTML = highlight(code);
    $("#mnCopy").onclick = () => { navigator.clipboard?.writeText(code); toast("Script copied", "ok", 1500); };
  },
};
function highlight(code) {
  return esc(code).split("\n").map((ln) => {
    const ci = ln.indexOf("#");
    let a = ci >= 0 && !/['"]/.test(ln.slice(0, ci)) ? ln.slice(0, ci) : ln, c = ci >= 0 && a !== ln ? ln.slice(ci) : "";
    a = a.replace(/(&#39;[^&]*?&#39;|&quot;.*?&quot;)/g, '<span class="str">$1</span>')
      .replace(/\b(import|from|def|return|for|in|if|else|elif|with|as|not|and|or|None|True|False|try|except)\b/g, '<span class="kw">$1</span>')
      .replace(/\b(mne|np|pd|plt|raw|ica|epochs|spectrum)\./g, '<span class="fn">$1</span>.');
    return a + (c ? `<span class="com">${c}</span>` : "");
  }).join("\n");
}

// ── Export ──
const EXPORTS = [
  ["xlsx", "Excel workbook", "Data, band powers, statistics, annotations & pipeline in separate sheets."],
  ["csv", "CSV (PiEEG-compatible)", "time_s + channels in µV + annotation column."],
  ["fif", "MNE FIF", "Native MNE Raw file — keeps channel names, positions, bads, annotations."],
  ["edf", "EDF", "European Data Format for EEGLAB, EDFbrowser, clinical viewers."],
  ["html", "MNE HTML report", "mne.Report with raw/PSD, pipeline log, topomaps, ICA and ERPs."],
  ["py", "Python script", "Reproduces the whole analysis with MNE — load, filter, ICA, plots."],
  ["ipynb", "Jupyter notebook", "Same pipeline as a ready-to-run notebook."],
  ["json", "Features JSON", "Band powers, ratios and quality metrics for ML pipelines."],
];
function exportItems() {
  return EXPORTS.map(([f, t, d]) => `<a data-export="${f}"><span class="pill info mono" style="min-width:46px;justify-content:center">.${f}</span><div>${t}<small>${d}</small></div></a>`).join("");
}
async function doExport(fmt) {
  const stage = S.view === "export" ? S.exportStage : "processed";
  const r = await task(`Exporting ${fmt.toUpperCase()}…`, () => api(dsUrl(`/export/${fmt}?stage=${stage}`), { raw: true }));
  const name = (r.headers.get("Content-Disposition") || "").match(/filename="(.+?)"/)?.[1] || `export.${fmt}`;
  downloadBlob(await r.blob(), name);
  toast(`Saved <b>${esc(name)}</b>`, "ok");
}
function downloadBlob(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
VIEWS.export = {
  html() {
    return head("Export & reproducible code", "Everything you see can leave PiEEG Studio: cleaned signals, analysis tables, MNE files and the exact Python code to reproduce it.",
      seg("exStage", [["processed", "Processed data"], ["raw", "Raw data"]], S.exportStage)) + `
    <div class="export-grid">${EXPORTS.map(([f, t, d]) => `<div class="export-card" data-export="${f}"><span class="ext">.${f}</span><b>${t}</b><span>${d}</span></div>`).join("")}</div>
    <div class="card mt"><div class="card-head"><h2>Pipeline preset</h2></div><div class="row"><span class="muted small">Save the preprocessing chain and re-use it on your next PiEEG session for identical processing.</span><span class="sp"></span><button class="btn btn-sm" id="exPreset">Download pipeline.json</button><button class="btn btn-sm" id="exLoad">Load pipeline.json</button></div></div>`;
  },
  init() {
    bindSeg("exStage", (v) => { S.exportStage = v; });
    $("#exPreset").onclick = () => downloadBlob(new Blob([JSON.stringify({ pieeg_studio_pipeline: 1, steps: S.ds.pipeline }, null, 2)], { type: "application/json" }), "pieeg_pipeline.json");
    $("#exLoad").onclick = () => $("#presetInput").click();
  },
};

async function openNative(kind, stage = "processed") {
  if (!S.health.native_viewer.available) { toast("No display on the machine running PiEEG Studio — run it on your desktop to open native MNE windows. The MNE visual lab shows the same figures in the browser.", "err", 8000); return; }
  const r = await task("Launching MNE…", () => api(dsUrl("/native"), { method: "POST", body: { kind, stage } }));
  toast(r.message + " (check your taskbar)", "ok", 5000);
}

// ───────────────────────────────── boot ─────────────────────────────────
async function boot() {
  applyTheme();
  const [health, recRes] = await Promise.all([
    api("/api/health"),
    api("/api/recordings").catch(() => ({ recordings: [] })),
  ]);
  S.health = health;
  S.recordings = recRes.recordings || [];
  $("#mneChip").textContent = `MNE ${S.health.mne}`;
  $("#exportMenu").innerHTML = exportItems();
  await refreshList();
  const urlRec = new URLSearchParams(location.search).get("recording");
  if (urlRec) {
    try {
      await loadServerRecording(urlRec);
      history.replaceState({}, "", location.pathname);
    } catch {
      if (S.list.length) setDs(await api(`/api/datasets/${S.list[S.list.length - 1].id}`));
    }
  } else if (S.list.length) {
    setDs(await api(`/api/datasets/${S.list[S.list.length - 1].id}`));
  }
  render();

  $("#sidebar").onclick = (e) => { const a = e.target.closest("a[data-view]"); if (a) { if (!S.ds) return toast("Open a recording first."); go(a.dataset.view); } };
  document.body.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]"); if (g) go(g.dataset.go);
    const ex = e.target.closest("[data-export]"); if (ex && S.ds) { $("#exportMenu").classList.remove("open"); doExport(ex.dataset.export); }
    if (!e.target.closest(".menu-wrap")) $("#exportMenu").classList.remove("open");
  });
  $("#btnExport").onclick = (e) => { e.stopPropagation(); $("#exportMenu").classList.toggle("open"); };
  $("#btnOpen").onclick = () => { S._uploadOpts = {}; $("#fileInput").click(); };
  $("#fileInput").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadFile(f, S._uploadOpts || {}); };
  $("#annInput").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    const form = new FormData(); form.append("file", f);
    setDs(await task("Importing markers…", () => api(dsUrl("/annotations/import"), { method: "POST", form }))); render();
    toast(`Markers imported from ${esc(f.name)}`, "ok");
  };
  $("#presetInput").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f || !S.ds) return;
    try {
      const j = JSON.parse(await f.text()); const steps = j.steps || j;
      setDs(await task("Applying pipeline…", () => api(dsUrl("/pipeline"), { method: "PUT", body: { steps } }))); render();
      toast("Pipeline preset applied", "ok");
    } catch (err) { toast("Invalid pipeline file: " + esc(err.message), "err"); }
  };
  $("#btnTheme").onclick = () => { S.theme = S.theme === "dark" ? "light" : "dark"; applyTheme(); render(); };
  $("#dsSwitch").onclick = async (e) => {
    const x = e.target.closest("[data-close]");
    if (x) {
      e.stopPropagation(); await api(`/api/datasets/${x.dataset.close}`, { method: "DELETE" });
      if (S.ds?.id === x.dataset.close) S.ds = null;
      await refreshList(); if (!S.ds && S.list.length) setDs(await api(`/api/datasets/${S.list[0].id}`)); render(); return;
    }
    const t = e.target.closest(".ds-tab"); if (t && t.dataset.id !== S.ds?.id) { setDs(await api(`/api/datasets/${t.dataset.id}`)); render(); }
  };
  // global drag & drop
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { if (e.target.closest("#drop")) return; e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) uploadFile(f); });
}
boot().catch((e) => { document.getElementById("main").innerHTML = `<div class="note warn">Failed to start: ${esc(e.message)}</div>`; });
