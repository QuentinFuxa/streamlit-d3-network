/**
 * streamlit-d3-network — D3.js network graph engine
 *
 * Streamlit Components v2 frontend module.
 * Renders an interactive force-directed graph with:
 *   - Zone-constrained layout (BFS topology-aware placement)
 *   - Multiple node shapes per type
 *   - Convex hulls per zone
 *   - Zoom/pan/drag with state persistence
 *   - Search, legend filter, info panel
 *   - Bidirectional: highlight/zoom_to from Python, actions/selections to Python
 *   - Export PNG/SVG
 */

/* global d3 */

// ─── D3 loader ───────────────────────────────────────────────
let _d3Ready = null;

function ensureD3() {
  if (window.d3) return Promise.resolve(window.d3);
  if (_d3Ready) return _d3Ready;
  _d3Ready = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://d3js.org/d3.v7.min.js";
    s.onload = () => resolve(window.d3);
    s.onerror = () => reject(new Error("Failed to load D3.js"));
    document.head.appendChild(s);
  });
  return _d3Ready;
}

// ─── Shape definitions ───────────────────────────────────────
const SHAPE_PATHS = {
  diamond: (r) => {
    const h = r * 1.3;
    return `M0,${-h} L${h},0 L0,${h} L${-h},0 Z`;
  },
  hexagon: (r) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push(`${r * Math.cos(a)},${r * Math.sin(a)}`);
    }
    return "M" + pts.join("L") + "Z";
  },
  triangle: (r) => {
    const h = r * 1.2;
    return `M0,${-h} L${h * 0.87},${h * 0.5} L${-h * 0.87},${h * 0.5} Z`;
  },
  "triangle-down": (r) => {
    const h = r * 1.2;
    return `M0,${h} L${h * 0.87},${-h * 0.5} L${-h * 0.87},${-h * 0.5} Z`;
  },
  star: (r) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.5;
      pts.push(`${rad * Math.cos(a)},${rad * Math.sin(a)}`);
    }
    return "M" + pts.join("L") + "Z";
  },
};

// ─── Utility ─────────────────────────────────────────────────
function darkenColor(hex, amount = 0.3) {
  if (!hex || hex.length < 7) return hex || "#333";
  const r = Math.max(0, Math.round(parseInt(hex.slice(1, 3), 16) * (1 - amount)));
  const g = Math.max(0, Math.round(parseInt(hex.slice(3, 5), 16) * (1 - amount)));
  const b = Math.max(0, Math.round(parseInt(hex.slice(5, 7), 16) * (1 - amount)));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function throttle(fn, delay) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= delay) {
      last = now;
      return fn.apply(this, args);
    }
  };
}

function shortLabel(text, maxLen = 24) {
  if (!text || text.length <= maxLen) return text || "";
  return text.slice(0, maxLen - 1) + "\u2026";
}

function _linkControl(l) {
  const src = typeof l.source === "object" ? l.source : { x: 0, y: 0 };
  const tgt = typeof l.target === "object" ? l.target : { x: 0, y: 0 };
  const sx = src.x ?? 0, sy = src.y ?? 0, tx = tgt.x ?? 0, ty = tgt.y ?? 0;
  const dx = tx - sx, dy = ty - sy;
  const dist = Math.hypot(dx, dy) || 1;
  let cx, cy;
  if (l._pairTotal > 1) {
    const offset = ((l._pairIdx - (l._pairTotal + 1) / 2) * 20);
    cx = (sx + tx) / 2 + offset * (dy / dist);
    cy = (sy + ty) / 2 - offset * (dx / dist);
  } else {
    const curvature = 0.15;
    cx = (sx + tx) / 2 + curvature * dist * (dy / dist);
    cy = (sy + ty) / 2 - curvature * dist * (dx / dist);
  }
  return { sx, sy, tx, ty, cx, cy };
}

function linkPath(l) {
  const { sx, sy, tx, ty, cx, cy } = _linkControl(l);
  return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
}

// Quadratic Bezier midpoint at t=0.5: (1-t)²·P0 + 2(1-t)t·Pc + t²·P1
function linkMidpoint(l) {
  const { sx, sy, tx, ty, cx, cy } = _linkControl(l);
  return { x: (sx + 2 * cx + tx) / 4, y: (sy + 2 * cy + ty) / 4 };
}

function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, ms);
  };
}

function findShortestPath(adj, fromId, toId) {
  if (fromId === toId) return [fromId];
  const visited = new Set([fromId]);
  const queue = [[fromId]];
  while (queue.length > 0) {
    const path = queue.shift();
    const current = path[path.length - 1];
    const neighbors = adj[current] || new Set();
    for (const next of neighbors) {
      if (next === toId) return [...path, next];
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return null; // No path found
}

function expandHull(points, pad) {
  if (points.length < 3) return points;
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  return points.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    return [x + (dx / dist) * pad, y + (dy / dist) * pad];
  });
}

// ─── Grid layout helper ──────────────────────────────────────
function gridLayout(items, maxCols, cellW = 160, cellH = 120) {
  const cols = Math.min(maxCols, items.length) || 1;
  const rows = Math.ceil(items.length / cols);
  const positions = items.map((item, i) => ({
    item,
    col: i % cols,
    row: Math.floor(i / cols),
  }));
  return { positions, cols, rows, width: cols * cellW, height: rows * cellH };
}

// ─── Community detection (Label Propagation) ────────────────
function detectCommunities(nodes, adj) {
  // Label propagation: each node starts with its own label,
  // then adopts the most frequent label among its neighbors.
  const labels = {};
  nodes.forEach((n, i) => { labels[n.id] = i; });

  let changed = true;
  let iterations = 0;
  const maxIter = 50;

  while (changed && iterations < maxIter) {
    changed = false;
    iterations++;
    // Process nodes in random order
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);
    for (const n of shuffled) {
      const nbrs = adj[n.id] || new Set();
      if (nbrs.size === 0) continue;
      // Count neighbor labels
      const freq = {};
      nbrs.forEach((nid) => {
        const lbl = labels[nid];
        freq[lbl] = (freq[lbl] || 0) + 1;
      });
      // Find most frequent label
      let bestLabel = labels[n.id];
      let bestCount = 0;
      Object.entries(freq).forEach(([lbl, cnt]) => {
        if (cnt > bestCount || (cnt === bestCount && Math.random() > 0.5)) {
          bestCount = cnt;
          bestLabel = Number(lbl);
        }
      });
      if (bestLabel !== labels[n.id]) {
        labels[n.id] = bestLabel;
        changed = true;
      }
    }
  }

  // Normalize: map labels to sequential community IDs
  const labelSet = [...new Set(Object.values(labels))];
  const labelMap = {};
  labelSet.forEach((l, i) => { labelMap[l] = i; });
  const communities = {};
  Object.entries(labels).forEach(([id, lbl]) => {
    communities[id] = labelMap[lbl];
  });
  return { communities, count: labelSet.length };
}

// ─── Betweenness centrality (approximate, sampling-based) ───
function approxBetweenness(nodes, adj, samples = 10) {
  const centrality = {};
  nodes.forEach((n) => { centrality[n.id] = 0; });

  const sampleNodes = nodes.length <= samples
    ? nodes
    : [...nodes].sort(() => Math.random() - 0.5).slice(0, samples);

  for (const src of sampleNodes) {
    // BFS from src
    const dist = { [src.id]: 0 };
    const paths = { [src.id]: 1 };
    const order = [];
    const pred = {};
    const queue = [src.id];

    while (queue.length > 0) {
      const v = queue.shift();
      order.push(v);
      const nbrs = adj[v] || new Set();
      for (const w of nbrs) {
        if (dist[w] === undefined) {
          dist[w] = dist[v] + 1;
          queue.push(w);
          paths[w] = 0;
          pred[w] = [];
        }
        if (dist[w] === dist[v] + 1) {
          paths[w] += paths[v];
          pred[w].push(v);
        }
      }
    }

    // Back-propagate
    const delta = {};
    nodes.forEach((n) => { delta[n.id] = 0; });
    while (order.length > 0) {
      const w = order.pop();
      if (pred[w]) {
        for (const v of pred[w]) {
          delta[v] += (paths[v] / paths[w]) * (1 + delta[w]);
        }
      }
      if (w !== src.id) {
        centrality[w] += delta[w];
      }
    }
  }

  // Normalize
  const maxC = Math.max(1, ...Object.values(centrality));
  Object.keys(centrality).forEach((id) => {
    centrality[id] /= maxC;
  });
  return centrality;
}

// ─── Main component ─────────────────────────────────────────
export default function (component) {
  const { data, setStateValue, setTriggerValue, parentElement } = component;
  if (!data || !data.nodes || data.nodes.length === 0) {
    parentElement.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#868e96;font-family:sans-serif;">No data</div>'; // pre-opts, no i18n
    return;
  }

  // Parse options
  const opts = data.options || {};
  const showLabels = opts.showLabels !== false;
  const showHulls = opts.showHulls !== false;
  const showLegend = opts.showLegend !== false;
  const showSearch = opts.showSearch !== false;
  const showExport = opts.showExport === true;
  const showParticles = opts.showParticles !== false;
  const showToolbar = opts.showToolbar !== false;
  const showStats = opts.showStats !== false;
  const showMinimap = opts.showMinimap !== false;
  const nodeTypes = data.node_types || {};
  const actions = data.actions || {};


  // Restore persisted state
  const savedPositions = data._state?.node_positions || {};
  const savedTransform = data._state?.zoom_transform || null;
  const savedSelectedNode = data._state?.selected_node || null;
  const hasRestoredLayout = Object.keys(savedPositions).length > 0;

  // Agent commands
  const highlightIds = new Set(data.highlight || []);
  const zoomToId = data.zoom_to || "";
  const filterType = data.filter_type || "";
  const filterValue = data.filter_value || "";

  // Load D3 then render
  ensureD3().then((d3) => {
    // Wait a frame so the container is laid out and has dimensions
    requestAnimationFrame(() => render(d3));
  });

  function render(d3) {
    // ── Build DOM ──
    // parentElement may be a ShadowRoot (v2 isolate_styles) or HTMLElement.
    // We always create our own root div inside it.
    const host =
      parentElement instanceof ShadowRoot
        ? parentElement.host
        : parentElement;

    // Inject CSS into shadow root / parent (Streamlit v2 doesn't propagate css= into shadow DOM)
    if (data._css) {
      const styleEl = document.createElement("style");
      styleEl.textContent = data._css;
      // Clear previous content safely
      while (parentElement.firstChild) parentElement.removeChild(parentElement.firstChild);
      parentElement.appendChild(styleEl);
    } else {
      while (parentElement.firstChild) parentElement.removeChild(parentElement.firstChild);
    }

    const root = document.createElement("div");
    // Use theme from Python options if provided, otherwise default to light
    const isDark = opts.dark === true;
    root.className = "sd3n-root" + (isDark ? " sd3n-dark" : " sd3n-light");
    // Set explicit height — prefer Python-provided height, then host, then fallback
    const explicitH = data._height || host.clientHeight || host.offsetHeight || 600;
    root.style.height = explicitH + "px";
    // Apply theme overrides as CSS custom properties
    const theme = opts.theme || {};
    Object.entries(theme).forEach(([key, value]) => {
      root.style.setProperty(`--sd3n-${key}`, value);
    });
    parentElement.appendChild(root);

    // Tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "sd3n-tooltip";
    root.appendChild(tooltip);

    function positionTooltip(e) {
      const rect = root.getBoundingClientRect();
      let x = e.clientX - rect.left + 12;
      let y = e.clientY - rect.top - 10;
      // Keep tooltip on-screen
      const tw = tooltip.offsetWidth || 200;
      const th = tooltip.offsetHeight || 60;
      if (x + tw > rect.width - 10) x = e.clientX - rect.left - tw - 12;
      if (y + th > rect.height - 10) y = rect.height - th - 10;
      if (y < 10) y = 10;
      tooltip.style.left = x + "px";
      tooltip.style.top = y + "px";
    }

    // Search box
    let searchInput, searchInfo;
    if (showSearch) {
      const searchBox = document.createElement("div");
      searchBox.className = "sd3n-search";
      searchBox.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="color:var(--sd3n-text-muted);flex-shrink:0">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input class="sd3n-search-input" type="text" placeholder="Search\u2026">
        <span class="sd3n-search-info"></span>
      `;
      if (showExport) {
        searchBox.innerHTML += `
          <button class="sd3n-btn sd3n-export-png">PNG</button>
          <button class="sd3n-btn sd3n-export-svg">SVG</button>
        `;
      }
      root.appendChild(searchBox);
      searchInput = searchBox.querySelector(".sd3n-search-input");
      searchInfo = searchBox.querySelector(".sd3n-search-info");
      if (searchInfo) searchInfo.textContent = data.nodes.length + " nodes";
    }

    // Toolbar (top-right) — hidden in compact mode
    const toolbar = document.createElement("div");
    toolbar.className = "sd3n-toolbar";
    if (!showToolbar) toolbar.style.display = "none";
    toolbar.innerHTML = `
      <button class="sd3n-btn sd3n-theme-btn" title="Toggle dark/light mode">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <button class="sd3n-btn sd3n-fullscreen-btn" title="Fullscreen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
      <button class="sd3n-btn sd3n-collapse-btn" title="Collapse zones into meta-nodes">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
      </button>
      <button class="sd3n-btn sd3n-heatmap-btn" title="Toggle degree heatmap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M12 6v6l4 2"/></svg>
      </button>
      <button class="sd3n-btn sd3n-fit-btn" title="Fit to content (F)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      </button>
      <button class="sd3n-btn sd3n-center-btn" title="Center on selection (C)" style="display:none">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
      </button>
      <button class="sd3n-btn sd3n-reset-btn" title="Unpin all nodes">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
      </button>
      <button class="sd3n-btn sd3n-zin-btn" title="Zoom in (+)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
      </button>
      <button class="sd3n-btn sd3n-zout-btn" title="Zoom out (-)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
      </button>
      <select class="sd3n-layout-select" title="Layout mode">
        <option value="force" selected>Force</option>
        <option value="radial">Radial</option>
        <option value="hierarchical">Hierarchy</option>
        <option value="grid">Grid</option>
        <option value="community">Community</option>
      </select>
      <button class="sd3n-btn sd3n-tuning-btn" title="Force tuning panel (T)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20V10M18 20v-6M6 20V4"/><circle cx="12" cy="7" r="3"/><circle cx="18" cy="11" r="3"/><circle cx="6" cy="10" r="3"/></svg>
      </button>
      <button class="sd3n-btn sd3n-snap-btn" title="Snap to grid (S)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3h18v18H3z"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18" opacity="0.4"/></svg>
      </button>
      <button class="sd3n-btn sd3n-bookmark-btn" title="Save/restore view bookmark (B)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      </button>
      <button class="sd3n-btn sd3n-path-mode-btn" title="Path mode — click two nodes to find shortest path (P)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="19" r="3"/><circle cx="19" cy="5" r="3"/><path d="M5 16V8a4 4 0 0 1 4-4h6"/><path d="M15 8l4-4"/></svg>
      </button>
      <button class="sd3n-btn sd3n-status-filter-btn" title="Filter by status (cycle: all → issues → ok → all) (I)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </button>
      <button class="sd3n-btn sd3n-help-btn" title="Keyboard shortcuts (?)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </button>
    `;
    root.appendChild(toolbar);

    // Info panel
    const infoPanel = document.createElement("div");
    infoPanel.className = "sd3n-info";
    infoPanel.innerHTML = '<button class="sd3n-info-close">&times;</button>';
    root.appendChild(infoPanel);
    // Prevent clicks inside info panel from reaching SVG
    infoPanel.addEventListener("click", (e) => e.stopPropagation());

    // Breadcrumb trail (bottom bar)
    const breadcrumbBar = document.createElement("div");
    breadcrumbBar.className = "sd3n-breadcrumb";
    root.appendChild(breadcrumbBar);

    // SVG
    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    root.insertBefore(svgEl, tooltip);

    const W = host.clientWidth || root.clientWidth || 800;
    const H = host.clientHeight || root.clientHeight || 600;

    const svg = d3.select(svgEl).attr("viewBox", `0 0 ${W} ${H}`);

    // Defs: arrow markers — one per unique link color for proper coloring
    const defs = svg.append("defs");
    const linkColors = new Set(data.links.map(l => l.color || "#adb5bd"));
    const markerIds = {};
    linkColors.forEach((color) => {
      const safeId = "sd3n-arrow-" + color.replace(/[^a-zA-Z0-9]/g, "");
      markerIds[color] = safeId;
      defs
        .append("marker")
        .attr("id", safeId)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 20)
        .attr("refY", 0)
        .attr("markerWidth", 8)
        .attr("markerHeight", 8)
        .attr("markerUnits", "userSpaceOnUse")
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-4L10,0L0,4")
        .attr("fill", color);
    });

    // Glow filter for selected/highlighted elements
    const glowFilter = defs.append("filter").attr("id", "sd3n-glow")
      .attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
    glowFilter.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "coloredBlur");
    const glowMerge = glowFilter.append("feMerge");
    glowMerge.append("feMergeNode").attr("in", "coloredBlur");
    glowMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // Layers
    const zoomG = svg.append("g").attr("id", "sd3n-zoom");
    const hullLayer = zoomG.append("g");
    const linkLayer = zoomG.append("g");
    const linkLabelLayer = zoomG.append("g");
    const nodeLayer = zoomG.append("g");
    const zoneLabelLayer = zoomG.append("g");

    // ── Process data ──
    const nodes = data.nodes.map((n) => ({ ...n }));
    const links = data.links.map((l) => ({ ...l }));
    const zones = data.zones || [];

    const nodeMap = {};
    nodes.forEach((n) => (nodeMap[n.id] = n));

    // Zone color/label maps
    const zoneColorMap = {};
    const zoneLabelMap = {};
    zones.forEach((z) => {
      zoneColorMap[z.name] = z.color;
      zoneLabelMap[z.name] = z.label || z.name;
    });
    const zoneKeys = zones.map((z) => z.name);

    // Adjacency
    const adj = {};
    links.forEach((l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      if (!adj[s]) adj[s] = new Set();
      if (!adj[t]) adj[t] = new Set();
      adj[s].add(t);
      adj[t].add(s);
    });

    // Parent tracking (for meter → sector linking)
    const meterParent = {};
    links.forEach((l) => {
      const s = typeof l.source === "string" ? l.source : l.source?.id;
      const t = typeof l.target === "string" ? l.target : l.target?.id;
      if (!s || !t) return;
      const sn = nodeMap[s],
        tn = nodeMap[t];
      if (!sn || !tn) return;
      if (sn.type !== tn.type) {
        // Assume smaller radius is child
        if ((sn.radius || 20) < (tn.radius || 20)) meterParent[s] = t;
        else if ((tn.radius || 20) < (sn.radius || 20)) meterParent[t] = s;
      }
    });

    // ── Zone-constrained layout ──
    const zonePadX = 60,
      zonePadY = 60;

    // Group nodes by zone
    const zoneSectors = {};
    zoneKeys.forEach((z) => (zoneSectors[z] = []));
    nodes.forEach((n) => {
      if (n.zone && zoneSectors[n.zone]) zoneSectors[n.zone].push(n.id);
    });

    // Grid within each zone
    const zoneGrids = {};
    zoneKeys.forEach((z) => {
      const items = zoneSectors[z];
      const maxCols = Math.max(2, Math.ceil(Math.sqrt(items.length)));
      zoneGrids[z] = gridLayout(items, maxCols);
    });

    // BFS zone placement by inter-zone connectivity
    const nodeZone = {};
    nodes.forEach((n) => {
      if (n.zone) nodeZone[n.id] = n.zone;
    });
    Object.entries(meterParent).forEach(([mid, sid]) => {
      if (!nodeZone[mid] && nodeZone[sid]) nodeZone[mid] = nodeZone[sid];
    });

    const zoneAdj = {};
    links.forEach((l) => {
      const sId = typeof l.source === "string" ? l.source : l.source?.id;
      const tId = typeof l.target === "string" ? l.target : l.target?.id;
      const zA = nodeZone[sId],
        zB = nodeZone[tId];
      if (zA && zB && zA !== zB) {
        const key = [zA, zB].sort().join("||");
        zoneAdj[key] = (zoneAdj[key] || 0) + 1;
      }
    });

    const zoneNeighbors = {};
    zoneKeys.forEach((z) => (zoneNeighbors[z] = {}));
    Object.entries(zoneAdj).forEach(([key, w]) => {
      const [a, b] = key.split("||");
      if (zoneNeighbors[a]) zoneNeighbors[a][b] = (zoneNeighbors[a][b] || 0) + w;
      if (zoneNeighbors[b]) zoneNeighbors[b][a] = (zoneNeighbors[b][a] || 0) + w;
    });

    // BFS from most-connected zone
    const placed = new Set();
    const sortedZoneKeys = [];
    const zoneDegree = {};
    zoneKeys.forEach((z) => {
      zoneDegree[z] = Object.values(zoneNeighbors[z] || {}).reduce((s, v) => s + v, 0);
    });
    const seedZone = [...zoneKeys].sort((a, b) => zoneDegree[b] - zoneDegree[a])[0];
    if (seedZone) {
      const queue = [seedZone];
      placed.add(seedZone);
      while (queue.length > 0) {
        const cur = queue.shift();
        sortedZoneKeys.push(cur);
        const nbrs = Object.entries(zoneNeighbors[cur] || {})
          .filter(([z]) => !placed.has(z))
          .sort((a, b) => b[1] - a[1]);
        nbrs.forEach(([z]) => {
          if (!placed.has(z)) {
            placed.add(z);
            queue.push(z);
          }
        });
      }
    }
    zoneKeys.forEach((z) => {
      if (!placed.has(z)) sortedZoneKeys.push(z);
    });

    // Place zones in 2D grid
    const nZones = zoneKeys.length || 1;
    const gridCols = Math.max(2, Math.ceil(Math.sqrt(nZones)));
    const gridRows = Math.ceil(nZones / gridCols);
    const cellOccupied = {};
    const zoneCells = {};
    const centerR = Math.floor(gridRows / 2),
      centerC = Math.floor(gridCols / 2);

    function cellKey(r, c) {
      return r + "," + c;
    }
    function freeNeighborCells(r, c) {
      const cands = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr,
            nc = c + dc;
          if (nr >= 0 && nc >= 0 && !cellOccupied[cellKey(nr, nc)]) {
            cands.push({ r: nr, c: nc, dist: Math.abs(nr - centerR) + Math.abs(nc - centerC) });
          }
        }
      }
      return cands.sort((a, b) => a.dist - b.dist);
    }

    if (sortedZoneKeys.length > 0) {
      const seed = sortedZoneKeys[0];
      zoneCells[seed] = { row: centerR, col: centerC };
      cellOccupied[cellKey(centerR, centerC)] = seed;
      for (let i = 1; i < sortedZoneKeys.length; i++) {
        const z = sortedZoneKeys[i];
        let bestNb = null,
          bestW = -1;
        for (const pz of Object.keys(zoneCells)) {
          const key = [z, pz].sort().join("||");
          const w = zoneAdj[key] || 0;
          if (w > bestW) {
            bestW = w;
            bestNb = pz;
          }
        }
        let tR = centerR,
          tC = centerC;
        if (bestNb && zoneCells[bestNb]) {
          tR = zoneCells[bestNb].row;
          tC = zoneCells[bestNb].col;
        }
        const freeCells = freeNeighborCells(tR, tC);
        if (freeCells.length > 0) {
          zoneCells[z] = { row: freeCells[0].r, col: freeCells[0].c };
          cellOccupied[cellKey(freeCells[0].r, freeCells[0].c)] = z;
        } else {
          let best = null,
            bestD = Infinity;
          for (let r = 0; r < gridRows + 2; r++) {
            for (let c = 0; c < gridCols + 2; c++) {
              if (!cellOccupied[cellKey(r, c)]) {
                const d = Math.abs(r - tR) + Math.abs(c - tC);
                if (d < bestD) {
                  bestD = d;
                  best = { r, c };
                }
              }
            }
          }
          if (best) {
            zoneCells[z] = { row: best.r, col: best.c };
            cellOccupied[cellKey(best.r, best.c)] = z;
          }
        }
      }
    }

    // Compute cell dimensions
    const colWidths = {},
      rowHeights = {};
    Object.entries(zoneCells).forEach(([z, { row, col }]) => {
      const g = zoneGrids[z];
      if (!g) return;
      const w = g.width + zonePadX * 2;
      const h = g.height + zonePadY * 2;
      colWidths[col] = Math.max(colWidths[col] || 0, w);
      rowHeights[row] = Math.max(rowHeights[row] || 0, h);
    });
    const colX = {},
      rowY = {};
    const usedCols = Object.keys(colWidths)
      .map(Number)
      .sort((a, b) => a - b);
    const usedRows = Object.keys(rowHeights)
      .map(Number)
      .sort((a, b) => a - b);
    const zoneGap = 30;
    let cx = 0;
    usedCols.forEach((c, i) => {
      colX[c] = cx;
      cx += colWidths[c] + (i < usedCols.length - 1 ? zoneGap : 0);
    });
    let ry = 0;
    usedRows.forEach((r, i) => {
      rowY[r] = ry;
      ry += rowHeights[r] + (i < usedRows.length - 1 ? zoneGap : 0);
    });

    const zonePlacements = {};
    Object.entries(zoneCells).forEach(([z, { row, col }]) => {
      zonePlacements[z] = {
        xStart: colX[col] || 0,
        yStart: rowY[row] || 0,
        cellW: colWidths[col] || 400,
        cellH: rowHeights[row] || 400,
      };
    });

    const totalW = cx || 400;
    const totalH = ry || 400;
    const defaultCenter = { x: totalW / 2, y: totalH / 2 };

    // Zone rects
    const zoneRects = {};
    sortedZoneKeys.forEach((z) => {
      const pl = zonePlacements[z];
      if (pl) zoneRects[z] = { x: pl.xStart, y: pl.yStart, w: pl.cellW, h: pl.cellH };
    });

    // ── Position nodes ──
    if (hasRestoredLayout) {
      // Restore from saved positions
      nodes.forEach((n) => {
        const sp = savedPositions[n.id];
        if (sp) {
          n.x = sp.x;
          n.y = sp.y;
          n.fx = sp.pinned ? sp.x : undefined;
          n.fy = sp.pinned ? sp.y : undefined;
        } else {
          n.x = defaultCenter.x;
          n.y = defaultCenter.y;
        }
      });
    } else {
      // Compute initial positions from zone grids
      const sectorPositions = {};
      sortedZoneKeys.forEach((z) => {
        const g = zoneGrids[z];
        const pl = zonePlacements[z];
        if (!g || !pl) return;
        g.positions.forEach(({ item, col, row }) => {
          const x = pl.xStart + zonePadX + col * 160 + 80;
          const y = pl.yStart + zonePadY + row * 120 + 60;
          sectorPositions[item] = { x, y };
          const node = nodeMap[item];
          if (node) {
            node.x = x;
            node.y = y;
          }
        });
      });

      // Fan out children around parents
      nodes.forEach((n) => {
        if (n.x !== undefined) return;
        const parentId = meterParent[n.id];
        if (parentId && sectorPositions[parentId]) {
          const p = sectorPositions[parentId];
          const siblings = Object.entries(meterParent).filter(([, v]) => v === parentId);
          const idx = siblings.findIndex(([k]) => k === n.id);
          const total = siblings.length;
          const angle = (2 * Math.PI * idx) / Math.max(total, 1);
          const dist = 60 + total * 5;
          n.x = p.x + Math.cos(angle) * dist;
          n.y = p.y + Math.sin(angle) * dist;
        } else {
          n.x = defaultCenter.x + (Math.random() - 0.5) * 100;
          n.y = defaultCenter.y + (Math.random() - 0.5) * 100;
        }
      });
    }

    // ── Force simulation ──
    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(80)
          .strength((l) => {
            const s = typeof l.source === "object" ? l.source : nodeMap[l.source];
            const t = typeof l.target === "object" ? l.target : nodeMap[l.target];
            return s && t && s.zone && t.zone && s.zone !== t.zone ? 0.1 : 0.4;
          })
      )
      .force("charge", d3.forceManyBody().strength(-200).distanceMax(400))
      .force("collision", d3.forceCollide().radius((d) => (d.radius || 20) + 8))
      .force(
        "x",
        d3
          .forceX()
          .x((d) => d._targetX || d.x || defaultCenter.x)
          .strength(0.08)
      )
      .force(
        "y",
        d3
          .forceY()
          .y((d) => d._targetY || d.y || defaultCenter.y)
          .strength(0.08)
      )
      .alphaDecay(0.02)
      .velocityDecay(0.35);

    // Set target positions for x/y forces
    nodes.forEach((n) => {
      n._targetX = n.x;
      n._targetY = n.y;
    });

    // Stop auto-tick — we'll run manually to avoid async lifecycle issues with Streamlit v2
    simulation.stop();

    if (hasRestoredLayout) {
      // Run one tick so forceLink resolves string IDs to node objects
      simulation.tick();
    } else {
      // Run simulation synchronously
      const nTicks = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
      for (let i = 0; i < nTicks; i++) {
        simulation.tick();
      }
    }

    // ── Detect parallel edges ──
    const edgePairCount = {};
    const edgePairIdx = {};
    links.forEach((l) => {
      const s = typeof l.source === "string" ? l.source : l.source?.id;
      const t = typeof l.target === "string" ? l.target : l.target?.id;
      const key = [s, t].sort().join("||");
      edgePairCount[key] = (edgePairCount[key] || 0) + 1;
    });
    links.forEach((l) => {
      const s = typeof l.source === "string" ? l.source : l.source?.id;
      const t = typeof l.target === "string" ? l.target : l.target?.id;
      const key = [s, t].sort().join("||");
      edgePairIdx[key] = (edgePairIdx[key] || 0) + 1;
      l._pairTotal = edgePairCount[key];
      l._pairIdx = edgePairIdx[key];
    });

    // ── Render links ──
    const linkSel = linkLayer
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("class", "sd3n-link")
      .attr("d", linkPath)
      .attr("stroke", (d) => d.color || "#adb5bd")
      .attr("stroke-width", (d) => d.width || 1.5)
      .attr("stroke-dasharray", (d) => (d.dashed ? "5,3" : null))
      .attr("marker-end", (d) => {
        if (d.directed === false) return null; // Undirected edge
        const color = d.color || "#adb5bd";
        const id = markerIds[color] || Object.values(markerIds)[0];
        return `url(#${id})`;
      })
      .style("opacity", (d) => d.opacity != null && d.opacity < 1 ? d.opacity : null)
      .style("pointer-events", "stroke")
      .on("mouseover", (e, d) => {
        const s = typeof d.source === "object" ? d.source : nodeMap[d.source];
        const t = typeof d.target === "object" ? d.target : nodeMap[d.target];
        const sLabel = s?.label || d.source;
        const tLabel = t?.label || d.target;
        let html = `<div class="sd3n-tt-title">${sLabel} \u2192 ${tLabel}</div>`;
        if (d.label) html += `<div class="sd3n-tt-line">${d.label}</div>`;
        if (d.data && Object.keys(d.data).length > 0) {
          Object.entries(d.data).forEach(([k, v]) => {
            html += `<div class="sd3n-tt-line">${k}: ${typeof v === "object" ? JSON.stringify(v) : v}</div>`;
          });
        }
        tooltip.innerHTML = html;
        tooltip.style.opacity = "1";
        // Show hover label on edge when labels are off
        if (!showLabels && d.label) {
          const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
          linkLabelLayer.append("text")
            .attr("class", "sd3n-link-label sd3n-hover-label")
            .attr("x", mx).attr("y", my - 6)
            .attr("text-anchor", "middle")
            .attr("font-size", "0.6875rem")
            .text(d.label)
            .style("opacity", 0)
            .transition().duration(150).style("opacity", 1);
        }
        // Glow effect on hovered edge
        d3.select(e.target).classed("sd3n-link-hover", true);
      })
      .on("mousemove", (e) => {
        positionTooltip(e);
      })
      .on("mouseout", (e) => {
        tooltip.style.opacity = "0";
        linkLabelLayer.selectAll(".sd3n-hover-label").remove();
        d3.select(e.target).classed("sd3n-link-hover", false);
      })
      .on("click", (e, d) => {
        e.stopPropagation();
        const s = typeof d.source === "object" ? d.source : nodeMap[d.source];
        const t = typeof d.target === "object" ? d.target : nodeMap[d.target];
        const sLabel = s?.label || d.source;
        const tLabel = t?.label || d.target;
        let panelHtml = `<button class="sd3n-info-close">&times;</button>`;
        panelHtml += `<div class="sd3n-info-title">${sLabel} \u2192 ${tLabel}</div>`;
        panelHtml += `<div class="sd3n-info-subtitle">Edge</div>`;
        if (d.label) panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Label</span><span class="sd3n-info-value">${d.label}</span></div>`;
        panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Width</span><span class="sd3n-info-value">${d.width || 1.5}px</span></div>`;
        if (d.dashed) panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Style</span><span class="sd3n-info-value">Dashed</span></div>`;
        if (d.data && Object.keys(d.data).length > 0) {
          panelHtml += `<div class="sd3n-info-data"><div class="sd3n-info-data-title">Data</div>`;
          Object.entries(d.data).forEach(([k, v]) => {
            const val = typeof v === "object" ? JSON.stringify(v) : String(v);
            panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">${k}</span><span class="sd3n-info-value">${val}</span></div>`;
          });
          panelHtml += '</div>';
        }
        // Shared neighbors between source and target
        if (s && t && adj[s.id] && adj[t.id]) {
          const shared = [...adj[s.id]].filter((n) => adj[t.id].has(n));
          if (shared.length > 0) {
            panelHtml += `<div class="sd3n-info-data"><div class="sd3n-info-data-title">Shared neighbors</div>`;
            shared.forEach((id) => {
              const n = nodeMap[id];
              if (n) panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label" style="cursor:pointer;text-decoration:underline dotted" data-goto="${id}">${n.label}</span></div>`;
            });
            panelHtml += '</div>';
          }
        }
        // Navigate to source/target
        panelHtml += `<div class="sd3n-info-row" style="margin-top:6px"><span class="sd3n-info-label" style="cursor:pointer;text-decoration:underline dotted" data-goto="${s?.id || ""}">${sLabel}</span><span class="sd3n-info-label" style="cursor:pointer;text-decoration:underline dotted" data-goto="${t?.id || ""}">${tLabel}</span></div>`;
        infoPanel.innerHTML = panelHtml;
        infoPanel.classList.add("visible");
        infoPanel.querySelector(".sd3n-info-close").addEventListener("click", () => {
          infoPanel.classList.remove("visible");
          clearHighlight();
        });
        // Wire goto links
        infoPanel.querySelectorAll("[data-goto]").forEach((el) => {
          el.addEventListener("click", function (evt) {
            evt.stopPropagation();
            const targetId = this.dataset.goto;
            if (targetId && nodeMap[targetId]) {
              selectNode(nodeMap[targetId], true);
            }
          });
        });
        // Highlight the two connected nodes
        const visible = new Set([s?.id, t?.id].filter(Boolean));
        nodeSel.classed("dimmed", (n) => !visible.has(n.id));
        linkSel.classed("dimmed", (l) => l !== d);
        linkLabelSel.classed("dimmed", (l) => l !== d);
      });

    const linkLabelSel = linkLabelLayer
      .selectAll("text")
      .data(links.filter((l) => l.label && showLabels))
      .join("text")
      .attr("class", "sd3n-link-label")
      .text((d) => shortLabel(d.label, 20));

    // ── Render nodes ──
    const nodeSel = nodeLayer
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", (d) => {
        let cls = "sd3n-node";
        if (highlightIds.has(d.id)) cls += " highlighted sd3n-pulse";
        // Status glow classes
        if (["warn", "warning", "yellow", "orange"].includes(d.status)) cls += " sd3n-status-warn";
        if (["error", "bad", "red", "critical"].includes(d.status)) cls += " sd3n-status-error";
        return cls;
      })
      .style("opacity", (d) => d.opacity != null && d.opacity < 1 ? d.opacity : null);

    // Node shapes based on type
    nodeSel.each(function (d) {
      const g = d3.select(this);
      const typeConfig = nodeTypes[d.type] || {};
      const shape = typeConfig.shape || "circle";
      const fill = d.color || typeConfig.color || "#e9ecef";
      const border = d.border_color || typeConfig.border_color || darkenColor(fill);
      const r = d.radius || 20;
      // Degree-based border width: more connections = thicker border
      const degree = (adj[d.id] || new Set()).size;
      const strokeW = Math.min(1.5 + degree * 0.3, 4);

      if (shape === "rect") {
        const w = Math.max(r * 3, 60),
          h = r * 1.6;
        g.append("rect")
          .attr("x", -w / 2)
          .attr("y", -h / 2)
          .attr("width", w)
          .attr("height", h)
          .attr("rx", 6)
          .attr("fill", fill)
          .attr("stroke", border)
          .attr("stroke-width", strokeW);
      } else if (SHAPE_PATHS[shape]) {
        g.append("path")
          .attr("d", SHAPE_PATHS[shape](r))
          .attr("fill", fill)
          .attr("stroke", border)
          .attr("stroke-width", strokeW);
      } else {
        // Default circle
        g.append("circle")
          .attr("r", r)
          .attr("fill", fill)
          .attr("stroke", border)
          .attr("stroke-width", strokeW);
      }

      // Degree ring — subtle outer halo for high-degree nodes
      const maxDeg = Math.max(1, ...nodes.map((n) => (adj[n.id] || new Set()).size));
      const degRatio = degree / maxDeg;
      if (degRatio > 0.3) {
        const ringR = r + 4 + degRatio * 4;
        g.insert("circle", ":first-child")
          .attr("class", "sd3n-degree-ring")
          .attr("r", ringR)
          .attr("fill", "none")
          .attr("stroke", fill)
          .attr("stroke-width", 1 + degRatio * 2)
          .attr("stroke-opacity", 0.2 + degRatio * 0.3)
          .attr("stroke-dasharray", `${degRatio * 8},${3 - degRatio * 2}`);
      }

      // Icon text
      const icon = typeConfig.icon || "";
      if (d.image) {
        // Clip image to node shape
        const clipId = "sd3n-clip-" + d.id.replace(/[^a-zA-Z0-9]/g, "_");
        const clipPath = g.append("clipPath").attr("id", clipId);
        if (shape === "rect") {
          clipPath.append("rect").attr("x", -r * 1.5).attr("y", -r * 0.8).attr("width", r * 3).attr("height", r * 1.6).attr("rx", 6);
        } else {
          clipPath.append("circle").attr("r", r - 2);
        }
        g.append("image")
          .attr("href", d.image)
          .attr("x", shape === "rect" ? -r * 1.5 : -r + 2)
          .attr("y", shape === "rect" ? -r * 0.8 : -r + 2)
          .attr("width", shape === "rect" ? r * 3 : (r - 2) * 2)
          .attr("height", shape === "rect" ? r * 1.6 : (r - 2) * 2)
          .attr("clip-path", `url(#${clipId})`)
          .attr("preserveAspectRatio", "xMidYMid slice")
          .attr("pointer-events", "none");
      } else if (icon) {
        g.append("text")
          .text(icon)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", r * 0.8)
          .attr("pointer-events", "none");
      }

      // Status badge (small colored dot)
      if (d.status) {
        const statusColors = {
          ok: "#2f9e44", good: "#2f9e44", green: "#2f9e44",
          warn: "#f08c00", warning: "#f08c00", yellow: "#f08c00", orange: "#f08c00",
          error: "#e03131", bad: "#e03131", red: "#e03131", critical: "#e03131",
          info: "#1971c2", blue: "#1971c2",
          off: "#868e96", gray: "#868e96", disabled: "#868e96",
        };
        const badgeColor = statusColors[d.status] || d.status;
        const badgeR = Math.max(4, r * 0.22);
        const badge = g.append("circle")
          .attr("class", "sd3n-status-badge")
          .attr("cx", r * 0.7)
          .attr("cy", -r * 0.7)
          .attr("r", badgeR)
          .attr("fill", badgeColor)
          .attr("stroke", isDark ? "#0e1117" : "#ffffff")
          .attr("stroke-width", 1.5);
        // Pulse animation for warn/error statuses
        if (["warn", "warning", "error", "bad", "critical", "red"].includes(d.status)) {
          badge.attr("data-pulse", "true");
        }
      }

      // Degree badge (small count in top-left, visible when zoomed in)
      const degCount = (adj[d.id] || new Set()).size;
      if (degCount > 0) {
        const bx = -r * 0.65, by = -r * 0.65;
        const bRadius = Math.max(6, r * 0.28);
        g.append("circle")
          .attr("class", "sd3n-degree-badge")
          .attr("cx", bx).attr("cy", by)
          .attr("r", bRadius)
          .attr("fill", "var(--sd3n-surface)")
          .attr("stroke", "var(--sd3n-border)")
          .attr("stroke-width", 0.5);
        g.append("text")
          .attr("class", "sd3n-degree-badge")
          .attr("x", bx).attr("y", by)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", Math.max(7, bRadius * 1.1))
          .attr("font-weight", 600)
          .attr("fill", "var(--sd3n-text-muted)")
          .attr("pointer-events", "none")
          .text(degCount);
      }

      // Label with text shadow for readability
      g.append("text")
        .text(shortLabel(d.label, 24))
        .attr("y", r + 14)
        .attr("text-anchor", "middle")
        .attr("font-size", "10px")
        .attr("fill", d.fontColor || (isDark ? "#fafafa" : "#333"))
        .attr("pointer-events", "none")
        .style("text-shadow", isDark
          ? "0 0 4px rgba(0,0,0,0.8), 0 1px 2px rgba(0,0,0,0.6)"
          : "0 0 3px rgba(255,255,255,0.9), 0 1px 1px rgba(255,255,255,0.7)");
    });

    // ── Position nodes on first render ──
    if (!hasRestoredLayout) {
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    }

    // ── Legend ──
    if (showLegend && (zones.length > 0 || Object.keys(nodeTypes).length > 0)) {
      const legend = document.createElement("div");
      legend.className = "sd3n-legend";
      let html = "";

      if (zones.length > 0) {
        html += `<div class="sd3n-lg-title">Zones</div>`;
        zones.forEach((z) => {
          const count = nodes.filter((n) => n.zone === z.name).length;
          html += `<div class="sd3n-lg-item" data-filter-type="zone" data-filter-value="${z.name}">
            <span class="sd3n-lg-swatch" style="background:${z.color}"></span>${z.label || z.name}<span style="opacity:0.4;margin-left:auto;font-size:0.625rem">${count}</span></div>`;
        });
      }

      const typeEntries = Object.entries(nodeTypes);
      if (typeEntries.length > 0) {
        html += `<div class="sd3n-lg-title">Types</div>`;
        typeEntries.forEach(([key, cfg]) => {
          const count = nodes.filter((n) => n.type === key).length;
          const shape = cfg.shape || "circle";
          const fill = cfg.color || "#e9ecef";
          // Generate small SVG shape preview
          let shapeSvg = "";
          if (shape === "rect") {
            shapeSvg = `<svg width="14" height="14" viewBox="-7 -7 14 14" style="flex-shrink:0"><rect x="-6" y="-4" width="12" height="8" rx="2" fill="${fill}" stroke="${cfg.border_color || ""}" stroke-width="0.5"/></svg>`;
          } else if (shape === "diamond") {
            shapeSvg = `<svg width="14" height="14" viewBox="-7 -7 14 14" style="flex-shrink:0"><path d="M0,-6 L6,0 L0,6 L-6,0 Z" fill="${fill}" stroke="${cfg.border_color || ""}" stroke-width="0.5"/></svg>`;
          } else if (shape === "hexagon") {
            shapeSvg = `<svg width="14" height="14" viewBox="-7 -7 14 14" style="flex-shrink:0"><path d="M0,-6 L5.2,-3 L5.2,3 L0,6 L-5.2,3 L-5.2,-3 Z" fill="${fill}" stroke="${cfg.border_color || ""}" stroke-width="0.5"/></svg>`;
          } else if (shape === "triangle") {
            shapeSvg = `<svg width="14" height="14" viewBox="-7 -7 14 14" style="flex-shrink:0"><path d="M0,-6 L5.2,3 L-5.2,3 Z" fill="${fill}" stroke="${cfg.border_color || ""}" stroke-width="0.5"/></svg>`;
          } else if (shape === "star") {
            shapeSvg = `<svg width="14" height="14" viewBox="-7 -7 14 14" style="flex-shrink:0"><path d="M0,-6 L1.9,-1.9 L6,-1.9 L2.9,1.2 L3.8,6 L0,3.5 L-3.8,6 L-2.9,1.2 L-6,-1.9 L-1.9,-1.9 Z" fill="${fill}" stroke="${cfg.border_color || ""}" stroke-width="0.5"/></svg>`;
          } else {
            shapeSvg = `<svg width="14" height="14" viewBox="-7 -7 14 14" style="flex-shrink:0"><circle r="6" fill="${fill}" stroke="${cfg.border_color || ""}" stroke-width="0.5"/></svg>`;
          }
          html += `<div class="sd3n-lg-item" data-filter-type="type" data-filter-value="${key}">
            ${shapeSvg}${cfg.label || key}<span style="opacity:0.4;margin-left:auto;font-size:0.625rem">${count}</span></div>`;
        });
      }

      legend.innerHTML = html;
      root.appendChild(legend);

      // Legend toggle button
      const legendToggle = document.createElement("button");
      legendToggle.className = "sd3n-legend-toggle";
      legendToggle.textContent = "Legend";
      root.appendChild(legendToggle);

      // Close button inside legend

      // Adjust top position when toolbar is hidden
      if (!showToolbar) {
        legend.style.top = "10px";
        legendToggle.style.top = "10px";
      }

      function collapseLegend() {
        legend.classList.add("collapsed");
        legendToggle.style.display = "";
      }
      function expandLegend() {
        legend.classList.remove("collapsed");
        legendToggle.style.display = "none";
      }

      // Start collapsed if option set
      if (legendCollapsed) {
        collapseLegend();
      } else {
        legendToggle.style.display = "none";
      }

      // Toggle legend
      legendToggle.addEventListener("click", expandLegend);

      // Legend click-to-filter
      let activeFilter = null;
      legend.querySelectorAll(".sd3n-lg-item").forEach((item) => {
        item.addEventListener("click", function () {
          const fType = this.dataset.filterType;
          const fVal = this.dataset.filterValue;
          const key = fType + ":" + fVal;

          if (activeFilter === key) {
            activeFilter = null;
            clearHighlight();
            legend.querySelectorAll(".sd3n-lg-item").forEach((el) => el.classList.remove("active"));
            return;
          }
          activeFilter = key;
          legend.querySelectorAll(".sd3n-lg-item").forEach((el) => el.classList.remove("active"));
          this.classList.add("active");

          const matchIds = new Set();
          nodes.forEach((n) => {
            if (fType === "zone" && n.zone === fVal) matchIds.add(n.id);
            else if (fType === "type" && n.type === fVal) matchIds.add(n.id);
          });

          nodeSel.classed("dimmed", (n) => !matchIds.has(n.id));
          linkSel.classed("dimmed", (l) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            return !matchIds.has(s) && !matchIds.has(t);
          });
          linkLabelSel.classed("dimmed", true);
        });
      });
    }

    // ── Tick ──
    let tickCount = 0;
    simulation.on("tick", () => {
      tickCount++;

      // Clamp nodes to zone rects (only in force layout)
      if (_currentLayout === "force") {
        nodes.forEach((n) => {
          const zr = zoneRects[n.zone];
          if (!zr) return;
          const pad = (n.radius || 20) + 10;
          n.x = Math.max(zr.x + pad, Math.min(zr.x + zr.w - pad, n.x));
          n.y = Math.max(zr.y + pad, Math.min(zr.y + zr.h - pad, n.y));
        });
      }

      // Update link paths
      linkSel.attr("d", linkPath);

      // Update link labels
      linkLabelSel
        .attr("x", (l) => linkMidpoint(l).x)
        .attr("y", (l) => linkMidpoint(l).y - 4);

      // Update nodes
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);

      // Update hulls periodically
      if (showHulls && tickCount % 5 === 0) updateHulls();

      // Update minimap periodically
      if (tickCount % 10 === 0 && typeof updateMinimap === "function") updateMinimap();
    });

    let _settled = false;
    let _currentLayout = "force";

    // ── Convex hulls ──
    function updateHulls() {
      const hullData = [];
      zoneKeys.forEach((z) => {
        const zNodes = nodes.filter((n) => n.zone === z);
        if (zNodes.length < 2) return;
        const pts = zNodes.map((n) => [n.x, n.y]);
        let hull = d3.polygonHull(pts);
        if (!hull) return;
        hull = expandHull(hull, 30);
        // Clamp to zone rect
        const zr = zoneRects[z];
        if (zr) {
          hull = hull.map(([x, y]) => [
            Math.max(zr.x, Math.min(zr.x + zr.w, x)),
            Math.max(zr.y, Math.min(zr.y + zr.h, y)),
          ]);
        }
        hullData.push({ zone: z, hull, color: zoneColorMap[z] || "#e9ecef" });
      });

      hullLayer
        .selectAll("path")
        .data(hullData, (d) => d.zone)
        .join("path")
        .attr("class", "sd3n-hull")
        .attr("d", (d) => "M" + d.hull.map((p) => p.join(",")).join("L") + "Z")
        .attr("fill", (d) => d.color)
        .attr("fill-opacity", 0.08)
        .attr("stroke", (d) => darkenColor(d.color, 0.2))
        .attr("stroke-opacity", 0.3);

      // Zone labels (clickable to focus zone)
      zoneLabelLayer
        .selectAll("text")
        .data(hullData, (d) => d.zone)
        .join("text")
        .attr("class", "sd3n-zone-label")
        .text((d) => zoneLabelMap[d.zone] || d.zone)
        .attr("fill", (d) => darkenColor(d.color, 0.3))
        .attr("x", (d) => {
          const xs = d.hull.map((p) => p[0]);
          return (Math.min(...xs) + Math.max(...xs)) / 2;
        })
        .attr("y", (d) => Math.min(...d.hull.map((p) => p[1])) - 8)
        .attr("text-anchor", "middle")
        .style("cursor", "pointer")
        .style("pointer-events", "all")
        .on("click", (e, d) => {
          e.stopPropagation();
          // Focus on this zone's nodes
          const matchIds = new Set();
          nodes.forEach((n) => { if (n.zone === d.zone) matchIds.add(n.id); });
          nodeSel.classed("dimmed", (n) => !matchIds.has(n.id));
          linkSel.classed("dimmed", (l) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            return !matchIds.has(s) && !matchIds.has(t);
          });
          linkLabelSel.classed("dimmed", true);
          showToast(`Zone: ${zoneLabelMap[d.zone] || d.zone}`);
        })
        .on("mouseover", (e, d) => {
          // Zone stats tooltip
          const zNodes = nodes.filter((n) => n.zone === d.zone);
          const zNodeIds = new Set(zNodes.map((n) => n.id));
          let internalEdges = 0, externalEdges = 0;
          links.forEach((l) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            if (zNodeIds.has(s) && zNodeIds.has(t)) internalEdges++;
            else if (zNodeIds.has(s) || zNodeIds.has(t)) externalEdges++;
          });
          const maxEdges = zNodes.length * (zNodes.length - 1) / 2;
          const density = maxEdges > 0 ? (internalEdges / maxEdges * 100).toFixed(0) : 0;
          let html = `<div class="sd3n-tt-title">${zoneLabelMap[d.zone] || d.zone}</div>`;
          html += `<div class="sd3n-tt-line">${zNodes.length} nodes</div>`;
          html += `<div class="sd3n-tt-line">${internalEdges} internal · ${externalEdges} external edges</div>`;
          html += `<div class="sd3n-tt-line">Density: ${density}%</div>`;
          // Type breakdown
          const typeCounts = {};
          zNodes.forEach((n) => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
          const typeStr = Object.entries(typeCounts).map(([t, c]) => `${(nodeTypes[t] || {}).label || t}: ${c}`).join(", ");
          if (typeStr) html += `<div class="sd3n-tt-line" style="font-size:0.6rem;opacity:0.6">${typeStr}</div>`;
          tooltip.innerHTML = html;
          tooltip.style.opacity = "1";
          positionTooltip(e);
          // Highlight zone nodes
          hullLayer.selectAll("path").attr("fill-opacity", (h) => h.zone === d.zone ? 0.18 : 0.05);
        })
        .on("mousemove", (e) => { positionTooltip(e); })
        .on("mouseout", () => {
          tooltip.style.opacity = "0";
          hullLayer.selectAll("path").attr("fill-opacity", 0.08);
        })
        .on("dblclick", (e, d) => {
          e.stopPropagation();
          // Zoom to fit this zone's nodes
          const zNodes = nodes.filter((n) => n.zone === d.zone);
          if (zNodes.length === 0) return;
          const xs = zNodes.map((n) => n.x);
          const ys = zNodes.map((n) => n.y);
          const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 60;
          const minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 60;
          const bw = maxX - minX, bh = maxY - minY;
          const scale = Math.min(W / bw, H / bh, 2.0) * 0.9;
          const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
          _programmaticZoom = true;
          svg.transition().duration(500).call(
            zoomBehavior.transform,
            d3.zoomIdentity.translate(W / 2 - cx * scale, H / 2 - cy * scale).scale(scale)
          );
        });
    }

    // ── Zoom ──
    let _programmaticZoom = false;
    // Track current zoom transform in-memory (no setStateValue to avoid reruns)
    let _currentZoomTransform = savedTransform
      ? d3.zoomIdentity.translate(savedTransform.x, savedTransform.y).scale(savedTransform.k)
      : null;
    const zoomBehavior = d3
      .zoom()
      .scaleExtent([0.1, 5])
      .on("zoom", (e) => {
        zoomG.attr("transform", e.transform);
        if (!_programmaticZoom) _currentZoomTransform = e.transform;
      })
      .on("end", (e) => {
        if (_programmaticZoom) {
          _programmaticZoom = false;
          return;
        }
        _currentZoomTransform = e.transform;
      });

    svg.call(zoomBehavior);

    // Restore saved zoom (skip if zoom_to command will override)
    if (savedTransform && !zoomToId) {
      _programmaticZoom = true;
      svg.call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(savedTransform.x, savedTransform.y).scale(savedTransform.k)
      );
    }

    function fitToContent(duration = 0) {
      const bounds = zoomG.node().getBBox();
      if (bounds.width === 0) return;
      const padX = 80, padY = 100;
      const scale = Math.min(W / (bounds.width + padX * 2), H / (bounds.height + padY * 2), 1.0);
      const tx = W / 2 - (bounds.x + bounds.width / 2) * scale;
      const ty = H / 2 - (bounds.y + bounds.height / 2) * scale;
      const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
      _programmaticZoom = true;
      _currentZoomTransform = t; // Track so it survives reruns
      if (duration > 0) {
        svg.transition().duration(duration).call(zoomBehavior.transform, t);
      } else {
        svg.call(zoomBehavior.transform, t);
      }
    }

    // ── Undo stack ──
    const _undoStack = [];
    const MAX_UNDO = 30;
    let _dragStartPos = null;

    function pushUndo(nodeId, fromX, fromY, toX, toY) {
      _undoStack.push({ nodeId, fromX, fromY, toX, toY });
      if (_undoStack.length > MAX_UNDO) _undoStack.shift();
    }

    function undo() {
      if (_undoStack.length === 0) { showToast("Nothing to undo"); return; }
      const action = _undoStack.pop();
      const n = nodeMap[action.nodeId];
      if (!n) return;
      n.x = action.fromX;
      n.y = action.fromY;
      n.fx = action.fromX;
      n.fy = action.fromY;
      nodeSel.filter((d) => d.id === action.nodeId)
        .transition().duration(300)
        .attr("transform", `translate(${action.fromX},${action.fromY})`);
      // Update links
      setTimeout(() => {
        linkSel.attr("d", linkPath);
        linkLabelSel
          .attr("x", (l) => linkMidpoint(l).x)
          .attr("y", (l) => linkMidpoint(l).y - 4);
        if (showHulls) updateHulls();
        updateMinimap();
      }, 320);
      showToast("Undo: moved node back");
    }

    // ── Drag ──
    const drag = d3
      .drag()
      .on("start", (e, d) => {
        if (!e.active) simulation.alphaTarget(0.1).restart();
        _dragStartPos = { x: d.x, y: d.y };
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (e, d) => {
        let x = e.x,
          y = e.y;
        // Clamp to zone (only in force layout)
        if (_currentLayout === "force") {
          const zr = zoneRects[d.zone];
          if (zr) {
            const pad = (d.radius || 20) + 5;
            x = Math.max(zr.x + pad, Math.min(zr.x + zr.w - pad, x));
            y = Math.max(zr.y + pad, Math.min(zr.y + zr.h - pad, y));
          }
        }
        d.fx = x;
        d.fy = y;
      })
      .on("end", (e, d) => {
        if (!e.active) simulation.alphaTarget(0);
        // Save undo state
        if (_dragStartPos && (Math.abs(d.x - _dragStartPos.x) > 2 || Math.abs(d.y - _dragStartPos.y) > 2)) {
          pushUndo(d.id, _dragStartPos.x, _dragStartPos.y, d.x, d.y);
        }
        _dragStartPos = null;
        // Keep pinned
        d._pinned = true;
        updatePinIndicator(e.sourceEvent?.target?.closest?.(".sd3n-node") || e.sourceEvent?.target?.parentNode, d);
        if (_settled) persistPositions();
      });

    nodeSel.call(drag);

    // Pin indicator management
    function updatePinIndicator(nodeG, d) {
      const g = d3.select(nodeG);
      g.selectAll(".sd3n-pin-icon").remove();
      if (d._pinned) {
        const r = d.radius || 20;
        g.append("text")
          .attr("class", "sd3n-pin-icon")
          .attr("x", -r * 0.7)
          .attr("y", -r * 0.7)
          .attr("font-size", Math.max(8, r * 0.4))
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .text("\uD83D\uDCCC"); // pin emoji
      }
    }

    // Show pin for initially pinned nodes (from saved positions)
    nodeSel.each(function(d) {
      if (d._pinned || (d.fx != null && d.fy != null)) {
        d._pinned = true;
        updatePinIndicator(this, d);
      }
    });

    // Double-click to unpin
    nodeSel.on("dblclick", (e, d) => {
      e.stopPropagation();
      d.fx = null;
      d.fy = null;
      d._pinned = false;
      updatePinIndicator(e.currentTarget, d);
      simulation.alpha(0.3).restart();
      if (_settled) persistPositions();
      showToast("Node unpinned");
    });

    // ── Tooltips + connected edge highlight ──
    nodeSel
      .on("mouseover", (e, d) => {
        let html = `<div class="sd3n-tt-title">${d.label}</div>`;
        if (d.tooltip && d.tooltip.length > 0) {
          d.tooltip.forEach((line) => {
            html += `<div class="sd3n-tt-line">${line}</div>`;
          });
        }
        // Connection summary
        let inCount = 0, outCount = 0;
        links.forEach((l) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          if (s === d.id) outCount++;
          if (t === d.id) inCount++;
        });
        if (inCount + outCount > 0) {
          html += `<div class="sd3n-tt-line" style="margin-top:2px;font-size:0.625rem;opacity:0.7">\u2190 ${inCount} in \u00b7 ${outCount} out \u2192</div>`;
        }
        tooltip.innerHTML = html;
        tooltip.style.opacity = "1";
        // Highlight connected edges on hover
        linkSel.classed("sd3n-link-connected", (l) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          return s === d.id || t === d.id;
        });
        // Pulse connected neighbor nodes
        const neighbors = adj[d.id] || new Set();
        nodeSel.classed("sd3n-neighbor-pulse", (n) => neighbors.has(n.id));
      })
      .on("mousemove", (e) => {
        positionTooltip(e);
      })
      .on("mouseout", (e, d) => {
        tooltip.style.opacity = "0";
        linkSel.classed("sd3n-link-connected", false);
        // Remove pulse from connected nodes
        nodeSel.classed("sd3n-neighbor-pulse", false);
      });

    // ── Click to select / info panel ──
    let selectedId = null;
    const selectionHistory = [];
    const selectedIds = new Set(); // Multi-select tracking

    let _neighborDepth = 1; // How many hops of neighbors to show

    // ── Path mode ──
    let _pathMode = false;
    let _pathModeStart = null;
    const pathModeBtn = root.querySelector(".sd3n-path-mode-btn");
    if (pathModeBtn) {
      pathModeBtn.addEventListener("click", () => {
        _pathMode = !_pathMode;
        pathModeBtn.classList.toggle("active", _pathMode);
        _pathModeStart = null;
        if (_pathMode) {
          showToast("Path mode ON — click source node, then target");
          root.style.cursor = "crosshair";
        } else {
          showToast("Path mode OFF");
          root.style.cursor = "";
          clearHighlight();
        }
      });
    }

    function getNeighborsAtDepth(startId, depth) {
      const result = new Set([startId]);
      let frontier = new Set([startId]);
      for (let d = 0; d < depth; d++) {
        const nextFrontier = new Set();
        frontier.forEach((id) => {
          (adj[id] || new Set()).forEach((nb) => {
            if (!result.has(nb)) {
              result.add(nb);
              nextFrontier.add(nb);
            }
          });
        });
        frontier = nextFrontier;
      }
      return result;
    }

    // ── Breadcrumb trail update ──
    function updateBreadcrumbs() {
      if (!breadcrumbBar) return;
      // Show last 8 entries + current
      const trail = [...selectionHistory.slice(-8)];
      if (selectedId) trail.push(selectedId);
      if (trail.length === 0) {
        breadcrumbBar.style.display = "none";
        return;
      }
      breadcrumbBar.style.display = "flex";
      breadcrumbBar.innerHTML = trail.map((id, i) => {
        const n = nodeMap[id];
        if (!n) return "";
        const isCurrent = i === trail.length - 1 && id === selectedId;
        const label = n.label.length > 14 ? n.label.slice(0, 12) + "\u2026" : n.label;
        return `<span class="sd3n-breadcrumb-item${isCurrent ? " active" : ""}" data-goto="${id}">${label}</span>`;
      }).filter(Boolean).join('<span class="sd3n-breadcrumb-sep">\u203A</span>');
      // Wire click handlers
      breadcrumbBar.querySelectorAll("[data-goto]").forEach((el) => {
        el.addEventListener("click", (evt) => {
          evt.stopPropagation();
          const targetId = el.dataset.goto;
          if (targetId && nodeMap[targetId]) {
            selectNode(nodeMap[targetId], true);
            const n = nodeMap[targetId];
            const t = d3.zoomTransform(svg.node());
            const scale = Math.max(t.k, 1.0);
            _programmaticZoom = true;
            svg.transition().duration(350).call(
              zoomBehavior.transform,
              d3.zoomIdentity.translate(W / 2 - n.x * scale, H / 2 - n.y * scale).scale(scale)
            );
          }
        });
      });
    }

    // ── Selection wave propagation ──
    // Selection wave animation removed for robustness

    function selectNode(d, notifyPython) {
      if (selectedId && selectedId !== d.id) {
        selectionHistory.push(selectedId);
        if (selectionHistory.length > 20) selectionHistory.shift();
      }
      selectedId = d.id;

      // Selection ring (simple, no animation)
      nodeLayer.selectAll(".sd3n-select-ring").remove();
      const selR = (d.radius || 20) + 6;
      nodeLayer.append("circle")
        .attr("class", "sd3n-select-ring")
        .attr("cx", d.x).attr("cy", d.y).attr("r", selR);

      // Update breadcrumb trail
      updateBreadcrumbs();

      // Highlight neighbors at configured depth
      const visible = getNeighborsAtDepth(d.id, _neighborDepth);
      nodeSel.classed("dimmed", (n) => !visible.has(n.id));
      nodeSel.classed("highlighted", (n) => n.id === d.id);
      linkSel.classed("dimmed", (l) => {
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        return !visible.has(s) || !visible.has(t);
      });
      linkLabelSel.classed("dimmed", (l) => {
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        return !visible.has(s) || !visible.has(t);
      });

      // Info panel
      const typeConfig = nodeTypes[d.type] || {};
      const hasBack = selectionHistory.length > 0;
      let panelHtml = `<button class="sd3n-info-close">&times;</button>`;
      if (hasBack) {
        panelHtml += `<button class="sd3n-info-back" style="position:absolute;top:6px;right:34px;cursor:pointer;color:var(--sd3n-text-muted);font-size:16px;border:none;background:none;padding:4px 8px;transition:color 0.15s;line-height:1" title="Back to previous node">\u2190</button>`;
      }
      // Status indicator in title
      let statusDot = "";
      if (d.status) {
        const sc = {
          ok: "#2f9e44", good: "#2f9e44", green: "#2f9e44",
          warn: "#f08c00", warning: "#f08c00", yellow: "#f08c00", orange: "#f08c00",
          error: "#e03131", bad: "#e03131", red: "#e03131", critical: "#e03131",
          info: "#1971c2", blue: "#1971c2",
          off: "#868e96", gray: "#868e96", disabled: "#868e96",
        };
        const col = sc[d.status] || d.status;
        statusDot = ` <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};vertical-align:middle;margin-left:4px"></span>`;
      }
      panelHtml += `<div class="sd3n-info-title">${d.label}${statusDot}</div>`;
      // Importance score (based on degree + betweenness proxy)
      const nodeDegree = (adj[d.id] || new Set()).size;
      panelHtml += `<div class="sd3n-info-subtitle">${typeConfig.label || d.type}${d.zone ? " | " + (zoneLabelMap[d.zone] || d.zone) : ""}</div>`;

      if (d.tooltip) {
        d.tooltip.forEach((line) => {
          panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">${line}</span></div>`;
        });
      }

      // Node data (arbitrary key-value pairs)
      if (d.data && Object.keys(d.data).length > 0) {
        panelHtml += `<div class="sd3n-info-data"><div class="sd3n-info-data-title">Data</div>`;
        Object.entries(d.data).forEach(([k, v]) => {
          const val = typeof v === "object" ? JSON.stringify(v) : String(v);
          panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">${k}</span><span class="sd3n-info-value">${val}</span></div>`;
        });
        panelHtml += '</div>';
      }

      // Connected nodes with link info + depth control
      const connected = [...(adj[d.id] || [])].map((id) => nodeMap[id]).filter(Boolean);
      if (connected.length > 0) {
        panelHtml += `<div class="sd3n-info-row" style="margin-top:4px;align-items:center">
          <span class="sd3n-info-label" style="font-weight:600">Connected (${connected.length})</span>
          <span style="display:flex;gap:2px">
            <button class="sd3n-btn sd3n-depth-btn" data-depth="1" style="padding:1px 6px;font-size:0.625rem;${_neighborDepth === 1 ? "background:var(--sd3n-accent);color:#fff;border-color:var(--sd3n-accent)" : ""}">1</button>
            <button class="sd3n-btn sd3n-depth-btn" data-depth="2" style="padding:1px 6px;font-size:0.625rem;${_neighborDepth === 2 ? "background:var(--sd3n-accent);color:#fff;border-color:var(--sd3n-accent)" : ""}">2</button>
            <button class="sd3n-btn sd3n-depth-btn" data-depth="3" style="padding:1px 6px;font-size:0.625rem;${_neighborDepth === 3 ? "background:var(--sd3n-accent);color:#fff;border-color:var(--sd3n-accent)" : ""}">3</button>
          </span>
        </div>`;
        connected.forEach((n) => {
          // Find link between d and n to show direction and label
          const link = links.find((l) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            return (s === d.id && t === n.id) || (s === n.id && t === d.id);
          });
          let linkInfo = "";
          if (link) {
            const s = typeof link.source === "object" ? link.source.id : link.source;
            const arrow = s === d.id ? "\u2192" : "\u2190";
            linkInfo = link.label ? ` ${arrow} ${link.label}` : ` ${arrow}`;
          }
          panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" data-goto="${n.id}">${n.label}<span style="opacity:0.5;font-size:0.6875rem">${linkInfo}</span></span></div>`;
        });
      }

      // Action buttons
      const typeActions = actions[d.type] || [];
      const wildcardActions = (actions["*"] || []).filter(
        (wa) => !typeActions.some((ta) => ta.key === wa.key)
      );
      const nodeActions = [...typeActions, ...wildcardActions];
      if (nodeActions.length > 0) {
        panelHtml += '<div class="sd3n-actions">';
        nodeActions.forEach((a) => {
          panelHtml += `<button class="sd3n-btn" data-action="${a.key}">${a.label}</button>`;
        });
        panelHtml += "</div>";
      }

      infoPanel.innerHTML = panelHtml;
      infoPanel.classList.add("visible");

      // Wire close button
      infoPanel.querySelector(".sd3n-info-close").addEventListener("click", () => {
        infoPanel.classList.remove("visible");
        clearHighlight();
        selectionHistory.length = 0;
        selectedId = null;
        updateBreadcrumbs();
        /* setStateValue("selected_node", null); // disabled: avoid rerun */
      });

      // Wire back button
      const backBtn = infoPanel.querySelector(".sd3n-info-back");
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          const prevId = selectionHistory.pop();
          if (prevId && nodeMap[prevId]) {
            selectedId = null; // Reset so history doesn't re-push
            selectNode(nodeMap[prevId], true);
          }
        });
      }

      // Wire action buttons
      infoPanel.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", function () {
          const actionKey = this.dataset.action;
          setTriggerValue("action", {
            key: actionKey,
            node_id: d.id,
            node_label: d.label,
            node_type: d.type,
            node_zone: d.zone,
            node_data: d.data || {},
            connected: [...(adj[d.id] || [])],
          });
          this.disabled = true;
          this.style.opacity = "0.4";
          showToast(`${actionKey} \u2192 ${d.label}`);
        });
      });

      // Wire goto links (connected nodes)
      infoPanel.querySelectorAll("[data-goto]").forEach((el) => {
        el.addEventListener("click", function (evt) {
          evt.stopPropagation();
          const targetId = this.dataset.goto;
          if (targetId && nodeMap[targetId]) {
            const n = nodeMap[targetId];
            // Navigate without notifying Python (avoids rerun that wipes JS state)
            selectNode(n, false);
            // Smooth pan to the target node
            const t = d3.zoomTransform(svg.node());
            const scale = Math.max(t.k, 1.0);
            _programmaticZoom = true;
            svg.transition().duration(350).call(
              zoomBehavior.transform,
              d3.zoomIdentity.translate(W / 2 - n.x * scale, H / 2 - n.y * scale).scale(scale)
            );
          }
        });
      });

      // Wire depth buttons
      infoPanel.querySelectorAll(".sd3n-depth-btn").forEach((btn) => {
        btn.addEventListener("click", function (evt) {
          evt.stopPropagation();
          _neighborDepth = parseInt(this.dataset.depth) || 1;
          selectNode(d, false); // Re-render with new depth
        });
      });

      // Show center button
      if (centerBtn) centerBtn.style.display = "";

      // Selection is purely JS-side — no setStateValue to avoid reruns
    }

    nodeSel.on("click", (e, d) => {
      e.stopPropagation();
      // Path mode intercept
      if (_pathMode) {
        if (!_pathModeStart) {
          _pathModeStart = d.id;
          nodeSel.classed("highlighted", (n) => n.id === d.id);
          nodeSel.classed("dimmed", false);
          showToast(`Source: ${shortLabel(d.label, 16)} — now click target`);
          return;
        } else if (_pathModeStart !== d.id) {
          const path = findShortestPath(adj, _pathModeStart, d.id);
          if (path) {
            const pathIds = new Set(path);
            nodeSel.classed("dimmed", (n) => !pathIds.has(n.id));
            nodeSel.classed("highlighted", (n) => pathIds.has(n.id));
            linkSel.classed("dimmed", (l) => {
              const s = typeof l.source === "object" ? l.source.id : l.source;
              const t = typeof l.target === "object" ? l.target.id : l.target;
              for (let i = 0; i < path.length - 1; i++) {
                if ((path[i] === s && path[i + 1] === t) || (path[i] === t && path[i + 1] === s)) return false;
              }
              return true;
            });
            linkLabelSel.classed("dimmed", true);
            showToast(`Shortest path: ${path.length - 1} hop${path.length > 2 ? "s" : ""}`);
            animatePathParticle(path);
            // Show path info
            let panelHtml = `<button class="sd3n-info-close">&times;</button>`;
            panelHtml += `<div class="sd3n-info-title">Shortest path</div>`;
            panelHtml += `<div class="sd3n-info-subtitle">${path.length - 1} hop${path.length > 2 ? "s" : ""}</div>`;
            path.forEach((id, i) => {
              const n = nodeMap[id];
              if (!n) return;
              const arrow = i < path.length - 1 ? " \u2192" : "";
              panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label" style="cursor:pointer" data-goto="${id}">${i + 1}. ${n.label}${arrow}</span></div>`;
            });
            infoPanel.innerHTML = panelHtml;
            infoPanel.classList.add("visible");
            infoPanel.querySelector(".sd3n-info-close").addEventListener("click", () => {
              infoPanel.classList.remove("visible");
              clearHighlight();
            });
            infoPanel.querySelectorAll("[data-goto]").forEach((el) => {
              el.addEventListener("click", function (evt) {
                evt.stopPropagation();
                const targetId = this.dataset.goto;
                if (targetId && nodeMap[targetId]) selectNode(nodeMap[targetId], true);
              });
            });
          } else {
            showToast("No path found");
          }
          _pathModeStart = null;
          return;
        }
        return;
      }
      if (e.shiftKey) {
        // Multi-select: toggle this node in selection
        if (selectedIds.has(d.id)) {
          selectedIds.delete(d.id);
        } else {
          selectedIds.add(d.id);
        }
        if (selectedIds.size === 0) {
          clearHighlight();
          infoPanel.classList.remove("visible");
          /* setStateValue("selected_node", null); // disabled: avoid rerun */
          return;
        }
        // Build visible set: all selected nodes + their neighbors
        const visible = new Set(selectedIds);
        selectedIds.forEach((id) => {
          (adj[id] || new Set()).forEach((n) => visible.add(n));
        });
        nodeSel.classed("dimmed", (n) => !visible.has(n.id));
        nodeSel.classed("highlighted", (n) => selectedIds.has(n.id));
        linkSel.classed("dimmed", (l) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          return !visible.has(s) || !visible.has(t);
        });
        linkLabelSel.classed("dimmed", (l) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          return !visible.has(s) || !visible.has(t);
        });
        // Notify Python of multi-selection
        const selNodes = [...selectedIds].map((id) => nodeMap[id]).filter(Boolean);
        // Show multi-select summary in info panel
        let panelHtml = `<button class="sd3n-info-close">&times;</button>`;
        panelHtml += `<div class="sd3n-info-title">${selNodes.length} nodes selected</div>`;
        panelHtml += `<div class="sd3n-info-subtitle">Shift+click to add/remove</div>`;
        selNodes.forEach((n) => {
          panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label" style="cursor:pointer" data-goto="${n.id}">${n.label}</span><span class="sd3n-info-value" style="font-size:0.6875rem;opacity:0.5">${n.type}</span></div>`;
        });
        // Type breakdown
        const typeCounts = {};
        selNodes.forEach((n) => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
        if (Object.keys(typeCounts).length > 1) {
          panelHtml += `<div class="sd3n-info-data"><div class="sd3n-info-data-title">Type breakdown</div>`;
          Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
            const tc = nodeTypes[type] || {};
            panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">${tc.label || type}</span><span class="sd3n-info-value">${count}</span></div>`;
          });
          panelHtml += `</div>`;
        }
        // Zone breakdown
        const selZoneCounts = {};
        selNodes.forEach((n) => { if (n.zone) selZoneCounts[n.zone] = (selZoneCounts[n.zone] || 0) + 1; });
        if (Object.keys(selZoneCounts).length > 1) {
          panelHtml += `<div class="sd3n-info-data"><div class="sd3n-info-data-title">Zone breakdown</div>`;
          Object.entries(selZoneCounts).sort((a, b) => b[1] - a[1]).forEach(([zone, count]) => {
            panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">${zoneLabelMap[zone] || zone}</span><span class="sd3n-info-value">${count}</span></div>`;
          });
          panelHtml += `</div>`;
        }
        // Shared connections between selected nodes
        const sharedLinks = links.filter((l) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          return selectedIds.has(s) && selectedIds.has(t);
        });
        if (sharedLinks.length > 0) {
          panelHtml += `<div class="sd3n-info-row" style="margin-top:6px"><span class="sd3n-info-label" style="font-weight:600">${sharedLinks.length} internal link${sharedLinks.length > 1 ? "s" : ""}</span></div>`;
        }
        // External connections count
        let externalCount = 0;
        selectedIds.forEach((id) => {
          (adj[id] || new Set()).forEach((nb) => {
            if (!selectedIds.has(nb)) externalCount++;
          });
        });
        if (externalCount > 0) {
          panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label" style="opacity:0.6">${externalCount} external connection${externalCount > 1 ? "s" : ""}</span></div>`;
        }
        infoPanel.innerHTML = panelHtml;
        infoPanel.classList.add("visible");
        infoPanel.querySelector(".sd3n-info-close").addEventListener("click", () => {
          selectedIds.clear();
          infoPanel.classList.remove("visible");
          clearHighlight();
          /* setStateValue("selected_node", null); // disabled: avoid rerun */
        });
        // Wire goto links
        infoPanel.querySelectorAll("[data-goto]").forEach((el) => {
          el.addEventListener("click", function (evt) {
            evt.stopPropagation();
            const targetId = this.dataset.goto;
            if (targetId && nodeMap[targetId]) {
              selectNode(nodeMap[targetId], true);
              selectedIds.clear();
            }
          });
        });
        return;
      }
      // Single click: clear multi-select
      selectedIds.clear();
      selectNode(d, true);
    });

    svg.on("click", () => {
      clearHighlight();
      selectedIds.clear();
      infoPanel.classList.remove("visible");
      /* setStateValue("selected_node", null); // disabled: avoid rerun */
    });

    function clearHighlight() {
      selectedId = null;
      nodeSel.classed("dimmed", false).classed("highlighted", false);
      nodeSel.attr("filter", null); // Remove glow filter
      linkSel.classed("dimmed", false);
      linkLabelSel.classed("dimmed", false);
      nodeLayer.selectAll(".sd3n-select-ring").remove();
      if (centerBtn) centerBtn.style.display = "none";
      updateBreadcrumbs();
    }

    // ── Search ──
    if (searchInput) {
      let matches = [],
        mIdx = 0;

      searchInput.addEventListener("input", doSearch);
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && matches.length > 1) {
          e.preventDefault();
          mIdx = (mIdx + 1) % matches.length;
          focusMatch();
        }
        if (e.key === "Escape") {
          searchInput.value = "";
          doSearch();
          searchInput.blur();
        }
      });
      if (searchInfo) {
        searchInfo.addEventListener("click", () => {
          if (matches.length > 1) {
            mIdx = (mIdx + 1) % matches.length;
            focusMatch();
          }
        });
      }

      // Search dropdown
      const searchDropdown = document.createElement("div");
      searchDropdown.className = "sd3n-search-dropdown";
      searchDropdown.style.display = "none";
      root.querySelector(".sd3n-search")?.appendChild(searchDropdown);

      function doSearch() {
        const q = searchInput.value.trim().toLowerCase();
        matches = [];
        mIdx = 0;
        if (!q) {
          clearHighlight();
          if (searchInfo) searchInfo.textContent = nodes.length + " nodes";
          searchDropdown.style.display = "none";
          return;
        }
        nodes.forEach((n) => {
          const txt = (n.label + " " + (n.tooltip || []).join(" ")).toLowerCase();
          if (txt.includes(q)) matches.push(n);
        });
        const ids = new Set(matches.map((m) => m.id));
        nodeSel.classed("dimmed", (n) => !ids.has(n.id));
        linkSel.classed("dimmed", (l) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          return !ids.has(s) && !ids.has(t);
        });
        linkLabelSel.classed("dimmed", true);
        if (searchInfo) searchInfo.textContent = matches.length + " result" + (matches.length !== 1 ? "s" : "");

        // Show dropdown with top matches
        if (matches.length > 0 && matches.length <= 12) {
          let ddHtml = "";
          matches.forEach((n, i) => {
            const tc = nodeTypes[n.type] || {};
            const fill = n.color || tc.color || "#adb5bd";
            const statusDot = n.status ? {ok:"#2f9e44",warn:"#f08c00",error:"#e03131",off:"#868e96"}[n.status] || n.status : "";
            ddHtml += `<div class="sd3n-search-item${i === mIdx ? " active" : ""}" data-idx="${i}">
              <span style="width:8px;height:8px;border-radius:50%;background:${fill};flex-shrink:0;display:inline-block"></span>
              <span>${shortLabel(n.label, 22)}</span>
              <span style="opacity:0.4;font-size:0.6rem;margin-left:auto">${tc.label || n.type}${statusDot ? ' <span style="color:' + statusDot + '">●</span>' : ""}</span>
            </div>`;
          });
          searchDropdown.innerHTML = ddHtml;
          searchDropdown.style.display = "";
          searchDropdown.querySelectorAll(".sd3n-search-item").forEach((el) => {
            el.addEventListener("click", function () {
              mIdx = parseInt(this.dataset.idx) || 0;
              focusMatch();
              selectNode(matches[mIdx], true);
              searchDropdown.style.display = "none";
            });
            el.addEventListener("mouseenter", function () {
              searchDropdown.querySelectorAll(".sd3n-search-item").forEach((e) => e.classList.remove("active"));
              this.classList.add("active");
            });
          });
        } else {
          searchDropdown.style.display = "none";
        }

        if (matches.length > 0) focusMatch();
      }

      // Hide dropdown on blur (with slight delay for click handling)
      searchInput.addEventListener("blur", () => {
        setTimeout(() => { searchDropdown.style.display = "none"; }, 200);
      });
      searchInput.addEventListener("focus", () => {
        if (matches.length > 0 && matches.length <= 12 && searchInput.value.trim()) {
          searchDropdown.style.display = "";
        }
      });

      function focusMatch() {
        const n = matches[mIdx];
        if (!n) return;
        if (searchInfo) searchInfo.textContent = mIdx + 1 + "/" + matches.length;
        const t = d3.zoomTransform(svg.node());
        const scale = Math.max(t.k, 1.3);
        _programmaticZoom = true;
        svg
          .transition()
          .duration(400)
          .call(zoomBehavior.transform, d3.zoomIdentity.translate(W / 2 - n.x * scale, H / 2 - n.y * scale).scale(scale));
      }
    }

    // ── Agent command: zoom to node (called after layout is ready) ──
    function zoomToNode() {
      if (!zoomToId || !nodeMap[zoomToId]) return;
      const n = nodeMap[zoomToId];
      const scale = 1.5;
      _programmaticZoom = true;
      svg
        .transition()
        .duration(600)
        .call(zoomBehavior.transform, d3.zoomIdentity.translate(W / 2 - n.x * scale, H / 2 - n.y * scale).scale(scale));
    }

    // ── Toolbar buttons ──
    const fitBtn = root.querySelector(".sd3n-fit-btn");
    const centerBtn = root.querySelector(".sd3n-center-btn");
    const resetBtn = root.querySelector(".sd3n-reset-btn");
    if (fitBtn) {
      fitBtn.addEventListener("click", () => fitToContent(300));
    }
    if (centerBtn) {
      centerBtn.addEventListener("click", () => {
        if (selectedId && nodeMap[selectedId]) {
          const n = nodeMap[selectedId];
          const t = d3.zoomTransform(svg.node());
          const scale = Math.max(t.k, 1.2);
          _programmaticZoom = true;
          svg.transition().duration(400).call(
            zoomBehavior.transform,
            d3.zoomIdentity.translate(W / 2 - n.x * scale, H / 2 - n.y * scale).scale(scale)
          );
        }
      });
    }
    // ── Bookmark handler ──
    const bookmarkBtn = root.querySelector(".sd3n-bookmark-btn");
    let _bookmark = null;
    if (bookmarkBtn) {
      bookmarkBtn.addEventListener("click", () => {
        if (_bookmark) {
          // Restore bookmark
          _programmaticZoom = true;
          svg.transition().duration(500).call(
            zoomBehavior.transform,
            d3.zoomIdentity.translate(_bookmark.x, _bookmark.y).scale(_bookmark.k)
          );
          if (_bookmark.selectedId && nodeMap[_bookmark.selectedId]) {
            selectNode(nodeMap[_bookmark.selectedId], true);
          }
          showToast("Bookmark restored");
          _bookmark = null;
          bookmarkBtn.classList.remove("active");
        } else {
          // Save bookmark
          const t = d3.zoomTransform(svg.node());
          _bookmark = { k: t.k, x: t.x, y: t.y, selectedId: selectedId };
          bookmarkBtn.classList.add("active");
          showToast("View bookmarked — click again to restore");
        }
      });
    }

    const helpBtn = root.querySelector(".sd3n-help-btn");
    if (helpBtn) {
      helpBtn.addEventListener("click", () => helpOverlay.classList.toggle("visible"));
    }
    const zinBtn = root.querySelector(".sd3n-zin-btn");
    const zoutBtn = root.querySelector(".sd3n-zout-btn");
    if (zinBtn) {
      zinBtn.addEventListener("click", () => {
        _programmaticZoom = true;
        svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.5);
      });
    }
    if (zoutBtn) {
      zoutBtn.addEventListener("click", () => {
        _programmaticZoom = true;
        svg.transition().duration(200).call(zoomBehavior.scaleBy, 1 / 1.5);
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        nodes.forEach((n) => {
          n.fx = null;
          n.fy = null;
          n._pinned = false;
        });
        // Remove all pin indicators
        nodeSel.each(function(d) {
          d3.select(this).selectAll(".sd3n-pin-icon").remove();
        });
        // Clear all filters and selections
        clearHighlight();
        selectedIds.clear();
        infoPanel.classList.remove("visible");
        const legend = root.querySelector(".sd3n-legend");
        if (legend) legend.querySelectorAll(".sd3n-lg-item").forEach((el) => el.classList.remove("active"));
        simulation.alpha(0.5).restart();
        if (_settled) persistPositions();
        /* setStateValue("selected_node", null); // disabled: avoid rerun */
        showToast("View reset");
      });
    }

    // ── Layout mode switching ──
    // ── Fullscreen toggle ──
    const fullscreenBtn = root.querySelector(".sd3n-fullscreen-btn");
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener("click", () => {
        if (document.fullscreenElement || root.classList.contains("sd3n-fullscreen")) {
          if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
          root.classList.remove("sd3n-fullscreen");
        } else {
          if (root.requestFullscreen) {
            root.requestFullscreen().catch(() => {
              // Fallback: CSS-based fullscreen
              root.classList.toggle("sd3n-fullscreen");
            });
          } else {
            root.classList.toggle("sd3n-fullscreen");
          }
        }
        setTimeout(() => fitToContent(300), 300);
      });
    }

    // ── Dark mode toggle ──
    const themeBtn = root.querySelector(".sd3n-theme-btn");
    if (themeBtn) {
      themeBtn.addEventListener("click", () => {
        const wasDark = root.classList.contains("sd3n-dark");
        root.classList.toggle("sd3n-dark", !wasDark);
        root.classList.toggle("sd3n-light", wasDark);
        // Update node label colors
        nodeLayer.selectAll(".sd3n-node text:last-of-type")
          .attr("fill", !wasDark ? "#fafafa" : "#333")
          .style("text-shadow", !wasDark
            ? "0 0 4px rgba(0,0,0,0.8), 0 1px 2px rgba(0,0,0,0.6)"
            : "0 0 3px rgba(255,255,255,0.9), 0 1px 1px rgba(255,255,255,0.7)");
        // Update status badge strokes
        nodeLayer.selectAll(".sd3n-status-badge")
          .attr("stroke", !wasDark ? "#0e1117" : "#ffffff");
        showToast(!wasDark ? "Dark mode" : "Light mode");
      });
    }

    // ── Collapse zones toggle ──
    const collapseBtn = root.querySelector(".sd3n-collapse-btn");
    let _zonesCollapsed = false;
    if (collapseBtn && zoneKeys.length > 0) {
      collapseBtn.addEventListener("click", () => {
        _zonesCollapsed = !_zonesCollapsed;
        if (_zonesCollapsed) {
          collapseZones();
        } else {
          expandZones();
        }
      });
    }

    function collapseZones() {
      // Hide all nodes/links, show zone meta-nodes
      nodeSel.style("display", "none");
      linkSel.style("display", "none");
      linkLabelSel.style("display", "none");
      hullLayer.style("display", "none");
      zoneLabelLayer.style("display", "none");

      // Create meta-node data
      const metaNodes = zoneKeys.map((z, i) => {
        const zNodes = nodes.filter((n) => n.zone === z);
        const cx = zNodes.length > 0 ? zNodes.reduce((s, n) => s + n.x, 0) / zNodes.length : W / 2;
        const cy = zNodes.length > 0 ? zNodes.reduce((s, n) => s + n.y, 0) / zNodes.length : H / 2;
        return { zone: z, x: cx, y: cy, count: zNodes.length, color: zoneColorMap[z] || "#e9ecef", label: zoneLabelMap[z] || z };
      });

      // Count inter-zone edges
      const metaEdges = [];
      const edgeMap = {};
      links.forEach((l) => {
        const s = typeof l.source === "object" ? l.source : nodeMap[l.source];
        const t = typeof l.target === "object" ? l.target : nodeMap[l.target];
        if (!s || !t || !s.zone || !t.zone || s.zone === t.zone) return;
        const key = [s.zone, t.zone].sort().join("||");
        edgeMap[key] = (edgeMap[key] || 0) + 1;
      });
      Object.entries(edgeMap).forEach(([key, count]) => {
        const [a, b] = key.split("||");
        metaEdges.push({ source: a, target: b, count });
      });

      // Render meta-nodes
      const metaLayer = zoomG.append("g").attr("class", "sd3n-meta-layer");

      const metaLinkSel = metaLayer.selectAll(".sd3n-meta-link")
        .data(metaEdges)
        .join("line")
        .attr("class", "sd3n-meta-link")
        .attr("x1", (d) => metaNodes.find((m) => m.zone === d.source)?.x || 0)
        .attr("y1", (d) => metaNodes.find((m) => m.zone === d.source)?.y || 0)
        .attr("x2", (d) => metaNodes.find((m) => m.zone === d.target)?.x || 0)
        .attr("y2", (d) => metaNodes.find((m) => m.zone === d.target)?.y || 0)
        .attr("stroke", "#adb5bd")
        .attr("stroke-width", (d) => Math.min(1 + d.count, 8))
        .attr("stroke-opacity", 0.5);

      // Add edge count labels on meta-links
      metaLayer.selectAll(".sd3n-meta-link-label")
        .data(metaEdges)
        .join("text")
        .attr("class", "sd3n-meta-link-label")
        .attr("x", (d) => {
          const a = metaNodes.find((m) => m.zone === d.source);
          const b = metaNodes.find((m) => m.zone === d.target);
          return ((a?.x || 0) + (b?.x || 0)) / 2;
        })
        .attr("y", (d) => {
          const a = metaNodes.find((m) => m.zone === d.source);
          const b = metaNodes.find((m) => m.zone === d.target);
          return ((a?.y || 0) + (b?.y || 0)) / 2 - 6;
        })
        .attr("text-anchor", "middle")
        .attr("font-size", "11px")
        .attr("fill", "var(--sd3n-text-muted)")
        .text((d) => d.count + " edge" + (d.count > 1 ? "s" : ""));

      const metaNodeSel = metaLayer.selectAll(".sd3n-meta-node")
        .data(metaNodes)
        .join("g")
        .attr("class", "sd3n-meta-node sd3n-zone-collapsed")
        .attr("transform", (d) => `translate(${d.x},${d.y})`)
        .style("cursor", "pointer");

      metaNodeSel.append("rect")
        .attr("x", -60).attr("y", -30).attr("width", 120).attr("height", 60)
        .attr("rx", 10).attr("ry", 10)
        .attr("fill", (d) => d.color)
        .attr("fill-opacity", 0.3)
        .attr("stroke", (d) => darkenColor(d.color, 0.2))
        .attr("stroke-width", 2);

      metaNodeSel.append("text")
        .text((d) => d.label)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("y", -6)
        .attr("font-size", "12px")
        .attr("font-weight", "600")
        .attr("fill", "var(--sd3n-text)");

      metaNodeSel.append("text")
        .text((d) => d.count + " nodes")
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("y", 12)
        .attr("font-size", "10px")
        .attr("fill", "var(--sd3n-text-muted)");

      // Click meta-node to expand just that zone
      metaNodeSel.on("click", (e, d) => {
        e.stopPropagation();
        _zonesCollapsed = false;
        expandZones();
        // Then filter to that zone
        const matchIds = new Set();
        nodes.forEach((n) => { if (n.zone === d.zone) matchIds.add(n.id); });
        nodeSel.classed("dimmed", (n) => !matchIds.has(n.id));
        linkSel.classed("dimmed", (l) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          return !matchIds.has(s) && !matchIds.has(t);
        });
        linkLabelSel.classed("dimmed", true);
        showToast(`Zone: ${d.label}`);
      });

      // Animate entrance
      metaNodeSel.style("opacity", 0).transition().duration(400).style("opacity", 1);
      metaLinkSel.style("opacity", 0).transition().duration(400).style("opacity", 0.5);

      showToast("Zones collapsed");
      fitToContent(300);
    }

    function expandZones() {
      // Remove meta layer
      zoomG.selectAll(".sd3n-meta-layer").remove();
      // Restore everything
      nodeSel.style("display", null);
      linkSel.style("display", null);
      linkLabelSel.style("display", null);
      hullLayer.style("display", null);
      zoneLabelLayer.style("display", null);
      showToast("Zones expanded");
      fitToContent(300);
    }

    // ── Simulation tuning panel (double-click reset button to open) ──
    const tuningPanel = document.createElement("div");
    tuningPanel.className = "sd3n-tuning";
    tuningPanel.innerHTML = `
      <div class="sd3n-tuning-title">Force Tuning</div>
      <label>Charge <input type="range" class="sd3n-tune-charge" min="-600" max="0" value="-200" step="10"><span class="sd3n-tune-val">-200</span></label>
      <label>Distance <input type="range" class="sd3n-tune-dist" min="20" max="300" value="80" step="5"><span class="sd3n-tune-val">80</span></label>
      <label>Collision <input type="range" class="sd3n-tune-coll" min="0" max="50" value="8" step="1"><span class="sd3n-tune-val">8</span></label>
      <label>X gravity <input type="range" class="sd3n-tune-gx" min="0" max="0.3" value="0.08" step="0.01"><span class="sd3n-tune-val">0.08</span></label>
      <label>Y gravity <input type="range" class="sd3n-tune-gy" min="0" max="0.3" value="0.08" step="0.01"><span class="sd3n-tune-val">0.08</span></label>
      <button class="sd3n-btn" style="margin-top:4px;width:100%;justify-content:center" data-tune-reset>Reset defaults</button>
    `;
    root.appendChild(tuningPanel);

    // Toggle tuning panel via dedicated toolbar button
    const tuningBtn = root.querySelector(".sd3n-tuning-btn");
    if (tuningBtn) {
      tuningBtn.addEventListener("click", () => {
        tuningPanel.classList.toggle("visible");
        tuningBtn.classList.toggle("active", tuningPanel.classList.contains("visible"));
      });
    }

    // Wire sliders
    function wireTuningSlider(sel, fn) {
      const slider = tuningPanel.querySelector(sel);
      if (!slider) return;
      const valSpan = slider.nextElementSibling;
      slider.addEventListener("input", function () {
        const v = parseFloat(this.value);
        if (valSpan) valSpan.textContent = v;
        fn(v);
        simulation.alpha(0.3).restart();
      });
    }

    wireTuningSlider(".sd3n-tune-charge", (v) => {
      simulation.force("charge").strength(v);
    });
    wireTuningSlider(".sd3n-tune-dist", (v) => {
      simulation.force("link").distance(v);
    });
    wireTuningSlider(".sd3n-tune-coll", (v) => {
      simulation.force("collision").radius((d) => (d.radius || 20) + v);
    });
    wireTuningSlider(".sd3n-tune-gx", (v) => {
      simulation.force("x").strength(v);
    });
    wireTuningSlider(".sd3n-tune-gy", (v) => {
      simulation.force("y").strength(v);
    });

    const tuneResetBtn = tuningPanel.querySelector("[data-tune-reset]");
    if (tuneResetBtn) {
      tuneResetBtn.addEventListener("click", () => {
        const defaults = { charge: -200, dist: 80, coll: 8, gx: 0.08, gy: 0.08 };
        tuningPanel.querySelector(".sd3n-tune-charge").value = defaults.charge;
        tuningPanel.querySelector(".sd3n-tune-dist").value = defaults.dist;
        tuningPanel.querySelector(".sd3n-tune-coll").value = defaults.coll;
        tuningPanel.querySelector(".sd3n-tune-gx").value = defaults.gx;
        tuningPanel.querySelector(".sd3n-tune-gy").value = defaults.gy;
        tuningPanel.querySelectorAll(".sd3n-tune-val").forEach((s, i) => {
          s.textContent = [defaults.charge, defaults.dist, defaults.coll, defaults.gx, defaults.gy][i];
        });
        simulation.force("charge").strength(defaults.charge);
        simulation.force("link").distance(defaults.dist);
        simulation.force("collision").radius((d) => (d.radius || 20) + defaults.coll);
        simulation.force("x").strength(defaults.gx);
        simulation.force("y").strength(defaults.gy);
        simulation.alpha(0.5).restart();
        showToast("Forces reset to defaults");
      });
    }

    // ── Snap to grid ──
    const snapBtn = root.querySelector(".sd3n-snap-btn");
    let _snapEnabled = false;
    const SNAP_GRID = 40;

    function snapToGrid() {
      simulation.stop();
      nodes.forEach((n) => {
        n.x = Math.round(n.x / SNAP_GRID) * SNAP_GRID;
        n.y = Math.round(n.y / SNAP_GRID) * SNAP_GRID;
        n.fx = n.x;
        n.fy = n.y;
        n._pinned = true;
      });
      nodeSel.transition().duration(400)
        .attr("transform", (d) => `translate(${d.x},${d.y})`);
      linkSel.transition().duration(400).attr("d", linkPath);
      linkLabelSel.transition().duration(400)
        .attr("x", (l) => linkMidpoint(l).x)
        .attr("y", (l) => linkMidpoint(l).y - 4);
      if (showHulls) setTimeout(() => updateHulls(), 420);
      showToast("Snapped to grid");
    }

    function drawGridOverlay() {
      let gridG = zoomG.select(".sd3n-grid-overlay");
      if (gridG.empty()) {
        gridG = zoomG.insert("g", ":first-child").attr("class", "sd3n-grid-overlay");
      }
      gridG.selectAll("*").remove();
      const extent = 2000;
      for (let x = -extent; x <= W + extent; x += SNAP_GRID) {
        gridG.append("line")
          .attr("x1", x).attr("y1", -extent).attr("x2", x).attr("y2", H + extent)
          .attr("stroke", "var(--sd3n-border)").attr("stroke-width", 0.5).attr("opacity", 0.5);
      }
      for (let y = -extent; y <= H + extent; y += SNAP_GRID) {
        gridG.append("line")
          .attr("x1", -extent).attr("y1", y).attr("x2", W + extent).attr("y2", y)
          .attr("stroke", "var(--sd3n-border)").attr("stroke-width", 0.5).attr("opacity", 0.5);
      }
    }

    function removeGridOverlay() {
      zoomG.select(".sd3n-grid-overlay").remove();
    }

    if (snapBtn) {
      snapBtn.addEventListener("click", () => {
        _snapEnabled = !_snapEnabled;
        snapBtn.classList.toggle("active", _snapEnabled);
        if (_snapEnabled) {
          drawGridOverlay();
          snapToGrid();
        } else {
          removeGridOverlay();
          // Unpin all so simulation can take over
          nodes.forEach((n) => { n.fx = null; n.fy = null; n._pinned = false; });
          nodeSel.each(function () { d3.select(this).selectAll(".sd3n-pin-icon").remove(); });
          simulation.alpha(0.3).restart();
          showToast("Grid snap off");
        }
      });
    }

    // ── Heatmap modes (cycle: off → degree → betweenness → off) ──
    const heatmapBtn = root.querySelector(".sd3n-heatmap-btn");
    let _heatmapMode = 0; // 0=off, 1=degree, 2=betweenness
    const _heatmapModes = ["off", "degree", "betweenness"];
    const _originalColors = new Map();
    if (heatmapBtn) {
      heatmapBtn.addEventListener("click", () => {
        _heatmapMode = (_heatmapMode + 1) % _heatmapModes.length;
        heatmapBtn.classList.toggle("active", _heatmapMode !== 0);
        if (_heatmapMode === 0) {
          removeHeatmap();
        } else {
          applyHeatmap(_heatmapModes[_heatmapMode]);
        }
      });
    }

    // Color scale: blue (low) → yellow (mid) → red (high)
    function heatColor(t) {
      if (t < 0.5) {
        const r = Math.round(65 + t * 2 * 190);
        const g = Math.round(105 + t * 2 * 150);
        const b = Math.round(225 - t * 2 * 175);
        return `rgb(${r},${g},${b})`;
      } else {
        const r = Math.round(255);
        const g = Math.round(255 - (t - 0.5) * 2 * 205);
        const b = Math.round(50 - (t - 0.5) * 2 * 50);
        return `rgb(${r},${g},${b})`;
      }
    }

    function applyHeatmap(mode) {
      let values = {};

      if (mode === "degree") {
        nodes.forEach((n) => { values[n.id] = (adj[n.id] || new Set()).size; });
      } else if (mode === "betweenness") {
        values = approxBetweenness(nodes, adj, Math.min(nodes.length, 15));
      }

      const maxVal = Math.max(0.001, ...Object.values(values));

      nodeSel.each(function (d) {
        const g = d3.select(this);
        const shapeEl = g.select("circle, rect, path");
        if (!shapeEl.empty()) {
          if (!_originalColors.has(d.id)) {
            _originalColors.set(d.id, shapeEl.attr("fill"));
          }
          const t = (values[d.id] || 0) / maxVal;
          shapeEl.transition().duration(400).attr("fill", heatColor(t));
        }
      });

      showToast(`Heatmap: ${mode} centrality`);
    }

    function removeHeatmap() {
      nodeSel.each(function (d) {
        const g = d3.select(this);
        const shapeEl = g.select("circle, rect, path");
        if (!shapeEl.empty() && _originalColors.has(d.id)) {
          shapeEl.transition().duration(400).attr("fill", _originalColors.get(d.id));
        }
      });
      _originalColors.clear();
      showToast("Heatmap off");
    }

    // ── Status filter (cycle: all → issues → ok → all) ──
    const statusFilterBtn = root.querySelector(".sd3n-status-filter-btn");
    let _statusFilter = 0; // 0=all, 1=issues (warn/error), 2=ok only
    const _statusModes = ["all", "issues", "ok"];
    const _issueStatuses = ["warn", "warning", "error", "bad", "critical", "red", "yellow", "orange"];
    const _okStatuses = ["ok", "good", "green"];

    if (statusFilterBtn) {
      // Add issue count badge
      const issueCount = nodes.filter((n) => _issueStatuses.includes(n.status)).length;
      if (issueCount > 0) {
        const badge = document.createElement("span");
        badge.className = "sd3n-issue-badge";
        badge.textContent = issueCount;
        statusFilterBtn.style.position = "relative";
        statusFilterBtn.appendChild(badge);
      }
      statusFilterBtn.addEventListener("click", () => {
        _statusFilter = (_statusFilter + 1) % _statusModes.length;
        statusFilterBtn.classList.toggle("active", _statusFilter !== 0);

        if (_statusFilter === 0) {
          clearHighlight();
          showToast("Status filter: all");
        } else if (_statusFilter === 1) {
          const matchIds = new Set();
          nodes.forEach((n) => {
            if (_issueStatuses.includes(n.status)) matchIds.add(n.id);
          });
          nodeSel.classed("dimmed", (n) => !matchIds.has(n.id));
          linkSel.classed("dimmed", (l) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            return !matchIds.has(s) && !matchIds.has(t);
          });
          linkLabelSel.classed("dimmed", true);
          showToast(`Status filter: issues (${matchIds.size} nodes)`);
        } else if (_statusFilter === 2) {
          const matchIds = new Set();
          nodes.forEach((n) => {
            if (_okStatuses.includes(n.status)) matchIds.add(n.id);
          });
          nodeSel.classed("dimmed", (n) => !matchIds.has(n.id));
          linkSel.classed("dimmed", (l) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            return !matchIds.has(s) && !matchIds.has(t);
          });
          linkLabelSel.classed("dimmed", true);
          showToast(`Status filter: ok (${matchIds.size} nodes)`);
        }
      });
    }

    const savedLayout = data._state?._layout_mode;
    const initialLayout = savedLayout || opts.layout || "force";
    _currentLayout = initialLayout;
    const layoutSelect = root.querySelector(".sd3n-layout-select");
    if (layoutSelect) {
      layoutSelect.value = initialLayout;
      layoutSelect.addEventListener("change", function () {
        const mode = this.value;
        applyLayout(mode);
      });
    }

    function applyLayout(mode) {
      _currentLayout = mode;
      simulation.stop();
      // Clean up community rings from previous layout
      zoomG.selectAll(".sd3n-community-ring").remove();

      if (mode === "radial") {
        // Radial layout: group by zone, nodes arranged in concentric rings
        const zoneList = zoneKeys.length > 0 ? zoneKeys : [""];
        const cx = W / 2;
        const cy = H / 2;
        const maxR = Math.min(W, H) * 0.4;
        const ringGap = maxR / Math.max(zoneList.length, 1);

        zoneList.forEach((z, zIdx) => {
          const zNodes = z ? nodes.filter((n) => n.zone === z) : nodes;
          const ringR = ringGap * (zIdx + 1);
          zNodes.forEach((n, i) => {
            const angle = (2 * Math.PI * i) / Math.max(zNodes.length, 1) - Math.PI / 2;
            n.x = cx + Math.cos(angle) * ringR;
            n.y = cy + Math.sin(angle) * ringR;
            n.fx = null;
            n.fy = null;
            n._pinned = false;
          });
        });
      } else if (mode === "hierarchical") {
        // Hierarchical: topological sort (BFS from root nodes = those with no incoming edges)
        const incoming = {};
        nodes.forEach((n) => (incoming[n.id] = 0));
        links.forEach((l) => {
          const t = typeof l.target === "object" ? l.target.id : l.target;
          incoming[t] = (incoming[t] || 0) + 1;
        });
        const roots = nodes.filter((n) => (incoming[n.id] || 0) === 0);
        if (roots.length === 0) roots.push(nodes[0]);

        const levels = {};
        const visited = new Set();
        let queue = roots.map((n) => ({ id: n.id, level: 0 }));
        roots.forEach((n) => visited.add(n.id));
        while (queue.length > 0) {
          const { id, level } = queue.shift();
          levels[id] = level;
          const nbrs = adj[id] || new Set();
          for (const nid of nbrs) {
            if (!visited.has(nid)) {
              visited.add(nid);
              queue.push({ id: nid, level: level + 1 });
            }
          }
        }
        // Assign unvisited nodes
        nodes.forEach((n) => {
          if (levels[n.id] === undefined) levels[n.id] = 0;
        });

        const maxLevel = Math.max(0, ...Object.values(levels));
        const levelNodes = {};
        nodes.forEach((n) => {
          const lv = levels[n.id];
          if (!levelNodes[lv]) levelNodes[lv] = [];
          levelNodes[lv].push(n);
        });

        const padX = 80, padY = 60;
        const levelH = (H - padY * 2) / Math.max(maxLevel + 1, 1);
        for (let lv = 0; lv <= maxLevel; lv++) {
          const lnodes = levelNodes[lv] || [];
          const gap = (W - padX * 2) / Math.max(lnodes.length + 1, 2);
          lnodes.forEach((n, i) => {
            n.x = padX + gap * (i + 1);
            n.y = padY + levelH * lv + levelH / 2;
            n.fx = null;
            n.fy = null;
            n._pinned = false;
          });
        }
      } else if (mode === "grid") {
        // Grid layout: nodes arranged in a clean grid
        const cols = Math.max(2, Math.ceil(Math.sqrt(nodes.length)));
        const rows = Math.ceil(nodes.length / cols);
        const padX = 80, padY = 60;
        const cellW = (W - padX * 2) / Math.max(cols + 1, 2);
        const cellH = (H - padY * 2) / Math.max(rows + 1, 2);
        nodes.forEach((n, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          n.x = padX + cellW * (col + 1);
          n.y = padY + cellH * (row + 1);
          n.fx = null;
          n.fy = null;
          n._pinned = false;
        });
      } else if (mode === "community") {
        // Community detection + cluster layout
        const { communities, count: numComm } = detectCommunities(nodes, adj);
        // Group nodes by community
        const commGroups = {};
        nodes.forEach((n) => {
          const c = communities[n.id] || 0;
          if (!commGroups[c]) commGroups[c] = [];
          commGroups[c].push(n);
        });
        // Arrange communities in a circle, nodes within each community in a sub-circle
        const commKeys = Object.keys(commGroups).sort((a, b) => commGroups[b].length - commGroups[a].length);
        const cx = W / 2, cy = H / 2;
        const outerR = Math.min(W, H) * 0.35;

        commKeys.forEach((ck, ci) => {
          const group = commGroups[ck];
          const commAngle = (2 * Math.PI * ci) / Math.max(commKeys.length, 1) - Math.PI / 2;
          const commCx = cx + Math.cos(commAngle) * outerR;
          const commCy = cy + Math.sin(commAngle) * outerR;
          const innerR = Math.min(outerR * 0.3, 20 + group.length * 12);

          group.forEach((n, ni) => {
            if (group.length === 1) {
              n.x = commCx;
              n.y = commCy;
            } else {
              const angle = (2 * Math.PI * ni) / group.length - Math.PI / 2;
              n.x = commCx + Math.cos(angle) * innerR;
              n.y = commCy + Math.sin(angle) * innerR;
            }
            n.fx = null;
            n.fy = null;
            n._pinned = false;
          });
        });

        // Store community info for coloring
        nodes.forEach((n) => { n._community = communities[n.id]; });

        // Draw community boundary rings (in hull layer, behind nodes)
        zoomG.selectAll(".sd3n-community-ring").remove();
        const commColors = ["#339af0", "#2f9e44", "#f08c00", "#c2255c", "#7048e8", "#0ca678", "#e8590c", "#845ef7"];
        commKeys.forEach((ck, ci) => {
          const group = commGroups[ck];
          if (group.length < 2) return;
          const commAngle = (2 * Math.PI * ci) / Math.max(commKeys.length, 1) - Math.PI / 2;
          const commCx = cx + Math.cos(commAngle) * outerR;
          const commCy = cy + Math.sin(commAngle) * outerR;
          const innerR = Math.min(outerR * 0.3, 20 + group.length * 12);
          const ringColor = commColors[ci % commColors.length];

          hullLayer.append("circle")
            .attr("class", "sd3n-community-ring")
            .attr("cx", commCx)
            .attr("cy", commCy)
            .attr("r", innerR + 25)
            .attr("fill", ringColor)
            .attr("fill-opacity", 0.06)
            .attr("stroke", ringColor)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "6,4")
            .attr("stroke-opacity", 0.4)
            .style("pointer-events", "none");

          // Community label
          hullLayer.append("text")
            .attr("class", "sd3n-community-ring")
            .attr("x", commCx)
            .attr("y", commCy - innerR - 30)
            .attr("text-anchor", "middle")
            .attr("fill", ringColor)
            .attr("font-size", "0.6875rem")
            .attr("font-weight", 600)
            .attr("opacity", 0.7)
            .text(`Community ${Number(ck) + 1} (${group.length})`);
        });

        showToast(`Detected ${numComm} communit${numComm !== 1 ? "ies" : "y"}`);
      } else {
        // Force layout: just restart simulation
        nodes.forEach((n) => {
          n.fx = null;
          n.fy = null;
          n._pinned = false;
        });
      }

      // Remove pin indicators
      nodeSel.each(function () {
        d3.select(this).selectAll(".sd3n-pin-icon").remove();
      });

      // Animated transition to new positions
      const LAYOUT_DUR = 600;
      nodeSel.transition().duration(LAYOUT_DUR).ease(d3.easeCubicInOut)
        .attr("transform", (d) => `translate(${d.x},${d.y})`);

      linkSel.transition().duration(LAYOUT_DUR).ease(d3.easeCubicInOut)
        .attr("d", linkPath);

      linkLabelSel.transition().duration(LAYOUT_DUR).ease(d3.easeCubicInOut)
        .attr("x", (l) => linkMidpoint(l).x)
        .attr("y", (l) => linkMidpoint(l).y - 4);

      if (showHulls) setTimeout(() => updateHulls(), LAYOUT_DUR + 20);
      setTimeout(() => {
        updateMinimap();
        fitToContent(300);
        if (mode === "force") {
          simulation.alpha(0.5).restart();
        }
      }, LAYOUT_DUR + 50);

      showToast(`Layout: ${mode}`);
      // Layout mode is JS-only — no setStateValue to avoid rerun
    }

    // ── Help overlay ──
    const helpOverlay = document.createElement("div");
    helpOverlay.className = "sd3n-help";
    helpOverlay.innerHTML = `
      <div class="sd3n-help-title">Keyboard shortcuts</div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">/</span><span class="sd3n-help-desc">Focus search</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">F</span><span class="sd3n-help-desc">Fit to content</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">C</span><span class="sd3n-help-desc">Center on selection</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">L</span><span class="sd3n-help-desc">Toggle legend</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Tab</span><span class="sd3n-help-desc">Next node</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Shift+Tab</span><span class="sd3n-help-desc">Previous node</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Esc</span><span class="sd3n-help-desc">Deselect</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Shift+Click</span><span class="sd3n-help-desc">Multi-select</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Shift+Drag</span><span class="sd3n-help-desc">Lasso select</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Right-click</span><span class="sd3n-help-desc">Context menu</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Double-click</span><span class="sd3n-help-desc">Unpin node</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">+ / -</span><span class="sd3n-help-desc">Zoom in/out</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Ctrl+A</span><span class="sd3n-help-desc">Select all nodes</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">N</span><span class="sd3n-help-desc">Cycle neighbor depth (1/2/3)</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">G</span><span class="sd3n-help-desc">Cycle layout mode</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">D</span><span class="sd3n-help-desc">Toggle dark/light mode</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">H</span><span class="sd3n-help-desc">Toggle degree heatmap</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Z</span><span class="sd3n-help-desc">Collapse/expand zones</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">B</span><span class="sd3n-help-desc">Save/restore view bookmark</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">T</span><span class="sd3n-help-desc">Toggle force tuning panel</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">S</span><span class="sd3n-help-desc">Snap to grid</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">P</span><span class="sd3n-help-desc">Toggle path mode (click 2 nodes)</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">I</span><span class="sd3n-help-desc">Cycle status filter (all/issues/ok)</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">X</span><span class="sd3n-help-desc">Critical path (highlight issues + neighbors)</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">K</span><span class="sd3n-help-desc">Toggle community coloring</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Q</span><span class="sd3n-help-desc">Toggle zone flow overlay</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">J</span><span class="sd3n-help-desc">Toggle Voronoi territory overlay</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">M</span><span class="sd3n-help-desc">Focus mode (hide UI chrome)</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">Ctrl+Z</span><span class="sd3n-help-desc">Undo node move</span></div>
      <div class="sd3n-help-row"><span class="sd3n-help-key">?</span><span class="sd3n-help-desc">Show/hide this help</span></div>
    `;
    root.appendChild(helpOverlay);
    helpOverlay.addEventListener("click", () => helpOverlay.classList.remove("visible"));

    // ── Toast notification ──
    const toastEl = document.createElement("div");
    toastEl.className = "sd3n-toast";
    root.appendChild(toastEl);
    let _toastTimer = null;

    function showToast(msg, duration = 2000) {
      toastEl.textContent = msg;
      toastEl.classList.add("visible");
      if (_toastTimer) clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => toastEl.classList.remove("visible"), duration);
    }

    // ── Keyboard shortcuts ──
    root.setAttribute("tabindex", "0");
    // Ensure root gets focus when SVG area is clicked
    svgEl.addEventListener("mousedown", () => { root.focus(); });
    // Listen on both root and document for keyboard events
    // (root gets focus-based events, document catches all)
    function handleKeyDown(e) {
      if (e.key === "?" && e.target.tagName !== "INPUT") {
        helpOverlay.classList.toggle("visible");
        return;
      } else if (e.key === "Escape") {
        if (helpOverlay.classList.contains("visible")) {
          helpOverlay.classList.remove("visible");
          return;
        }
        if (selectedId) {
          clearHighlight();
          infoPanel.classList.remove("visible");
          selectedIds.clear();
          /* setStateValue("selected_node", null); // disabled: avoid rerun */
        }
      } else if (e.key === "/" && e.target.tagName !== "INPUT") {
        e.preventDefault();
        if (searchInput) searchInput.focus();
      } else if (e.key === "f" || e.key === "F") {
        if (e.target.tagName === "INPUT") return;
        fitToContent(300);
      } else if (e.key === "l" || e.key === "L") {
        if (e.target.tagName === "INPUT") return;
        const legend = root.querySelector(".sd3n-legend");
        const toggle = root.querySelector(".sd3n-legend-toggle");
        if (legend && toggle) {
          if (legend.classList.contains("collapsed")) {
            legend.classList.remove("collapsed");
            toggle.style.display = "none";
          } else {
            legend.classList.add("collapsed");
            toggle.style.display = "";
          }
        }
      } else if (e.key === "c" || e.key === "C") {
        if (e.target.tagName === "INPUT") return;
        if (selectedId && nodeMap[selectedId]) {
          const n = nodeMap[selectedId];
          const t = d3.zoomTransform(svg.node());
          const scale = Math.max(t.k, 1.2);
          _programmaticZoom = true;
          svg.transition().duration(400).call(
            zoomBehavior.transform,
            d3.zoomIdentity.translate(W / 2 - n.x * scale, H / 2 - n.y * scale).scale(scale)
          );
        }
      } else if (e.key === "Tab") {
        if (e.target.tagName === "INPUT") return;
        e.preventDefault();
        // Cycle through nodes
        const curIdx = selectedId ? nodes.findIndex(n => n.id === selectedId) : -1;
        const nextIdx = e.shiftKey
          ? (curIdx <= 0 ? nodes.length - 1 : curIdx - 1)
          : (curIdx + 1) % nodes.length;
        const nextNode = nodes[nextIdx];
        if (nextNode) {
          selectNode(nextNode, true);
          // Pan to the node
          const t = d3.zoomTransform(svg.node());
          const scale = Math.max(t.k, 0.8);
          _programmaticZoom = true;
          svg.transition().duration(200).call(
            zoomBehavior.transform,
            d3.zoomIdentity.translate(W / 2 - nextNode.x * scale, H / 2 - nextNode.y * scale).scale(scale)
          );
        }
      } else if ((e.key === "+" || e.key === "=") && e.target.tagName !== "INPUT") {
        _programmaticZoom = true;
        svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.5);
      } else if (e.key === "-" && e.target.tagName !== "INPUT") {
        _programmaticZoom = true;
        svg.transition().duration(200).call(zoomBehavior.scaleBy, 1 / 1.5);
      } else if ((e.key === "n" || e.key === "N") && e.target.tagName !== "INPUT") {
        _neighborDepth = (_neighborDepth % 3) + 1;
        showToast(`Neighbor depth: ${_neighborDepth}`);
        if (selectedId && nodeMap[selectedId]) selectNode(nodeMap[selectedId], false);
      } else if ((e.key === "g" || e.key === "G") && e.target.tagName !== "INPUT") {
        // Cycle layout mode
        if (layoutSelect) {
          const modes = ["force", "radial", "hierarchical", "grid", "community"];
          const curIdx = modes.indexOf(layoutSelect.value);
          const nextIdx = (curIdx + 1) % modes.length;
          layoutSelect.value = modes[nextIdx];
          applyLayout(modes[nextIdx]);
        }
      } else if ((e.key === "b" || e.key === "B") && e.target.tagName !== "INPUT") {
        if (bookmarkBtn) bookmarkBtn.click();
      } else if ((e.key === "d" || e.key === "D") && e.target.tagName !== "INPUT") {
        if (themeBtn) themeBtn.click();
      } else if ((e.key === "h" || e.key === "H") && e.target.tagName !== "INPUT") {
        if (heatmapBtn) heatmapBtn.click();
      } else if (e.key === "z" && (e.metaKey || e.ctrlKey) && e.target.tagName !== "INPUT") {
        e.preventDefault();
        undo();
      } else if ((e.key === "z" || e.key === "Z") && e.target.tagName !== "INPUT" && !e.metaKey && !e.ctrlKey) {
        if (collapseBtn) collapseBtn.click();
      } else if ((e.key === "t" || e.key === "T") && e.target.tagName !== "INPUT") {
        if (tuningBtn) tuningBtn.click();
      } else if ((e.key === "p" || e.key === "P") && e.target.tagName !== "INPUT") {
        if (pathModeBtn) pathModeBtn.click();
      } else if ((e.key === "s" || e.key === "S") && e.target.tagName !== "INPUT" && !e.metaKey && !e.ctrlKey) {
        if (snapBtn) snapBtn.click();
      } else if ((e.key === "i" || e.key === "I") && e.target.tagName !== "INPUT") {
        if (statusFilterBtn) statusFilterBtn.click();
      } else if ((e.key === "k" || e.key === "K") && e.target.tagName !== "INPUT") {
        // Community coloring — label propagation to auto-detect communities
        _communityMode = !_communityMode;
        if (_communityMode) {
          // Simple label propagation
          const labels = {};
          nodes.forEach((n) => { labels[n.id] = n.id; });
          for (let iter = 0; iter < 10; iter++) {
            let changed = false;
            const shuffled = [...nodes].sort(() => Math.random() - 0.5);
            shuffled.forEach((n) => {
              const nbrs = [...(adj[n.id] || [])];
              if (nbrs.length === 0) return;
              const freq = {};
              nbrs.forEach((nb) => { freq[labels[nb]] = (freq[labels[nb]] || 0) + 1; });
              const best = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
              if (labels[n.id] !== best) { labels[n.id] = best; changed = true; }
            });
            if (!changed) break;
          }
          // Assign colors to communities
          const communities = {};
          Object.values(labels).forEach((l) => { communities[l] = (communities[l] || 0) + 1; });
          const sortedComm = Object.entries(communities).sort((a, b) => b[1] - a[1]);
          const palette = ["#4c6ef5", "#f03e3e", "#2f9e44", "#f59f00", "#7048e8", "#e64980", "#1098ad", "#d6336c", "#ae3ec9", "#f76707"];
          const commColor = {};
          sortedComm.forEach(([label], i) => { commColor[label] = palette[i % palette.length]; });
          // Apply colors — tag main shape with data attr, save original
          nodeSel.each(function (d) {
            const g = d3.select(this);
            const color = commColor[labels[d.id]];
            // Find first shape child (the main shape, not badges)
            const children = g.node().children;
            for (let i = 0; i < children.length; i++) {
              const el = children[i];
              const tag = el.tagName.toLowerCase();
              if ((tag === "circle" || tag === "rect" || tag === "path") &&
                  !el.getAttribute("class")?.includes("sd3n-")) {
                if (!el.dataset.origFill) el.dataset.origFill = el.getAttribute("fill") || "";
                el.setAttribute("fill", color);
                break;
              }
            }
          });
          showToast(`Communities: ${sortedComm.length} detected (K to reset)`);
        } else {
          // Restore original colors
          nodeSel.each(function (d) {
            const g = d3.select(this);
            const children = g.node().children;
            for (let i = 0; i < children.length; i++) {
              const el = children[i];
              if (el.dataset.origFill !== undefined) {
                el.setAttribute("fill", el.dataset.origFill);
                delete el.dataset.origFill;
                break;
              }
            }
          });
          showToast("Original colors restored");
        }
      } else if ((e.key === "q" || e.key === "Q") && e.target.tagName !== "INPUT") {
        // Zone flow overlay — show inter-zone connection counts
        _zoneFlowMode = !_zoneFlowMode;
        const flowLayer = zoomG.select(".sd3n-zone-flow-layer");
        if (_zoneFlowMode && zones.length > 1) {
          const layer = flowLayer.empty() ? zoomG.append("g").attr("class", "sd3n-zone-flow-layer") : flowLayer;
          layer.selectAll("*").remove();
          // Compute zone centers and inter-zone link counts
          const zoneCenters = {};
          zones.forEach((z) => {
            const zNodes = nodes.filter((n) => n.zone === z.name);
            if (zNodes.length === 0) return;
            zoneCenters[z.name] = {
              x: zNodes.reduce((s, n) => s + n.x, 0) / zNodes.length,
              y: zNodes.reduce((s, n) => s + n.y, 0) / zNodes.length,
              color: z.color,
              label: z.label || z.name,
            };
          });
          const flows = {};
          links.forEach((l) => {
            const s = typeof l.source === "object" ? l.source : nodeMap[l.source];
            const t = typeof l.target === "object" ? l.target : nodeMap[l.target];
            if (!s || !t || s.zone === t.zone || !s.zone || !t.zone) return;
            const key = [s.zone, t.zone].sort().join("→");
            flows[key] = (flows[key] || { count: 0, from: s.zone, to: t.zone });
            flows[key].count++;
          });
          // Draw flow arrows
          Object.values(flows).forEach((f) => {
            const from = zoneCenters[f.from];
            const to = zoneCenters[f.to];
            if (!from || !to) return;
            const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
            const w = Math.min(2 + f.count * 1.5, 8);
            layer.append("line")
              .attr("x1", from.x).attr("y1", from.y)
              .attr("x2", to.x).attr("y2", to.y)
              .attr("stroke", "#6741d9")
              .attr("stroke-width", w)
              .attr("stroke-opacity", 0.3)
              .attr("stroke-dasharray", "8,4");
            layer.append("circle")
              .attr("cx", mx).attr("cy", my)
              .attr("r", 12)
              .attr("fill", "#6741d9")
              .attr("fill-opacity", 0.85);
            layer.append("text")
              .attr("x", mx).attr("y", my)
              .attr("text-anchor", "middle")
              .attr("dominant-baseline", "central")
              .attr("font-size", "10px")
              .attr("font-weight", "700")
              .attr("fill", "#fff")
              .text(f.count);
          });
          showToast(`Zone flows: ${Object.keys(flows).length} inter-zone connections (Q to hide)`);
        } else {
          if (!flowLayer.empty()) flowLayer.remove();
          _zoneFlowMode = false;
          showToast("Zone flows hidden");
        }
      } else if ((e.key === "j" || e.key === "J") && e.target.tagName !== "INPUT") {
        // Voronoi overlay — show nearest-node regions
        _voronoiMode = !_voronoiMode;
        const voronoiG = zoomG.select(".sd3n-voronoi-layer");
        if (_voronoiMode) {
          const layer = voronoiG.empty() ? zoomG.insert("g", ":first-child").attr("class", "sd3n-voronoi-layer") : voronoiG;
          layer.selectAll("*").remove();
          const delaunay = d3.Delaunay.from(nodes, (n) => n.x, (n) => n.y);
          const voronoi = delaunay.voronoi([-200, -200, W + 400, H + 400]);
          nodes.forEach((n, i) => {
            const cell = voronoi.cellPolygon(i);
            if (!cell) return;
            const zoneColor = zoneColorMap[n.zone] || "#e9ecef";
            layer.append("path")
              .attr("d", "M" + cell.map((p) => p.join(",")).join("L") + "Z")
              .attr("fill", zoneColor)
              .attr("fill-opacity", 0.08)
              .attr("stroke", zoneColor)
              .attr("stroke-opacity", 0.2)
              .attr("stroke-width", 0.5);
          });
          showToast("Voronoi overlay (J to hide)");
        } else {
          if (!voronoiG.empty()) voronoiG.remove();
          showToast("Voronoi hidden");
        }
      } else if ((e.key === "m" || e.key === "M") && e.target.tagName !== "INPUT") {
        // Focus mode — hide all chrome
        _focusMode = !_focusMode;
        const elems = root.querySelectorAll(".sd3n-toolbar, .sd3n-legend, .sd3n-stats, .sd3n-minimap, .sd3n-search-box, .sd3n-legend-toggle");
        elems.forEach((el) => { el.style.display = _focusMode ? "none" : ""; });
        showToast(_focusMode ? "Focus mode — press M to exit" : "UI restored");
      } else if ((e.key === "x" || e.key === "X") && e.target.tagName !== "INPUT") {
        // Critical path — highlight all warn/error nodes and edges between them
        const criticalStatuses = ["warn", "warning", "error", "bad", "critical", "red", "yellow", "orange"];
        const criticalIds = new Set(nodes.filter((n) => criticalStatuses.includes(n.status)).map((n) => n.id));
        if (criticalIds.size === 0) {
          showToast("No issues found");
        } else {
          // Also include direct neighbors of critical nodes
          const expanded = new Set(criticalIds);
          criticalIds.forEach((id) => {
            (adj[id] || new Set()).forEach((nb) => expanded.add(nb));
          });
          nodeSel.classed("dimmed", (n) => !expanded.has(n.id));
          nodeSel.classed("highlighted", (n) => criticalIds.has(n.id));
          linkSel.classed("dimmed", (l) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            return !expanded.has(s) || !expanded.has(t);
          });
          linkLabelSel.classed("dimmed", true);
          // Apply glow filter to critical nodes
          nodeSel.filter((n) => criticalIds.has(n.id)).attr("filter", "url(#sd3n-glow)");
          showToast(`Critical path: ${criticalIds.size} issue${criticalIds.size > 1 ? "s" : ""} + ${expanded.size - criticalIds.size} neighbors`);
        }
      } else if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
        if (e.target.tagName === "INPUT") return;
        e.preventDefault();
        // Select all visible (non-dimmed) nodes
        selectedIds.clear();
        nodes.forEach((n) => selectedIds.add(n.id));
        nodeSel.classed("highlighted", true).classed("dimmed", false);
        linkSel.classed("dimmed", false);
        linkLabelSel.classed("dimmed", false);
      }
    }
    // Keyboard shortcuts only active when graph root has focus
    // (no document-level listener to avoid hijacking page keypresses)
    root.setAttribute("tabindex", "0");
    root.style.outline = "none";
    root.addEventListener("keydown", handleKeyDown);

    // ── Export ──
    if (showExport) {
      const pngBtn = root.querySelector(".sd3n-export-png");
      const svgBtn = root.querySelector(".sd3n-export-svg");

      function cloneSvgForExport() {
        const bounds = zoomG.node().getBBox();
        const pad = 40;
        const expW = Math.ceil(bounds.width + pad * 2);
        const expH = Math.ceil(bounds.height + pad * 2);
        const clone = svgEl.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("viewBox", `${bounds.x - pad} ${bounds.y - pad} ${expW} ${expH}`);
        clone.setAttribute("width", expW);
        clone.setAttribute("height", expH);
        const zg = clone.querySelector("#sd3n-zoom");
        if (zg) zg.removeAttribute("transform");
        return { clone, expW, expH };
      }

      if (svgBtn) {
        svgBtn.addEventListener("click", () => {
          const { clone } = cloneSvgForExport();
          const str = new XMLSerializer().serializeToString(clone);
          const blob = new Blob([str], { type: "image/svg+xml;charset=utf-8" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "network.svg";
          a.click();
          URL.revokeObjectURL(a.href);
        });
      }

      if (pngBtn) {
        pngBtn.addEventListener("click", () => {
          const { clone, expW, expH } = cloneSvgForExport();
          const str = new XMLSerializer().serializeToString(clone);
          const blob = new Blob([str], { type: "image/svg+xml;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = expW;
            canvas.height = expH;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = isDark ? "#0e1117" : "#ffffff";
            ctx.fillRect(0, 0, expW, expH);
            ctx.drawImage(img, 0, 0, expW, expH);
            URL.revokeObjectURL(url);
            canvas.toBlob((pngBlob) => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(pngBlob);
              a.download = "network.png";
              a.click();
              URL.revokeObjectURL(a.href);
            }, "image/png");
          };
          img.src = url;
        });
      }
    }

    // ── Minimap ──
    const minimapW = 160, minimapH = 100;
    const minimapDiv = document.createElement("div");
    minimapDiv.className = "sd3n-minimap";
    minimapDiv.style.width = minimapW + "px";
    minimapDiv.style.height = minimapH + "px";
    if (!showMinimap) minimapDiv.style.display = "none";
    root.appendChild(minimapDiv);

    const minimapSvg = d3.select(minimapDiv)
      .append("svg")
      .attr("width", minimapW)
      .attr("height", minimapH);

    const minimapLinkG = minimapSvg.append("g");
    const minimapNodeG = minimapSvg.append("g");
    const minimapViewport = minimapSvg.append("rect").attr("class", "sd3n-minimap-viewport");

    function updateMinimap() {
      const bounds = zoomG.node().getBBox();
      if (bounds.width === 0) return;

      const pad = 10;
      const scaleX = minimapW / (bounds.width + pad * 2);
      const scaleY = minimapH / (bounds.height + pad * 2);
      const mScale = Math.min(scaleX, scaleY);
      const offX = (minimapW - bounds.width * mScale) / 2 - bounds.x * mScale;
      const offY = (minimapH - bounds.height * mScale) / 2 - bounds.y * mScale;

      const mTransform = `translate(${offX},${offY}) scale(${mScale})`;
      minimapLinkG.attr("transform", mTransform);
      minimapNodeG.attr("transform", mTransform);

      // Draw simplified links
      minimapLinkG.selectAll("line")
        .data(links, (d, i) => i)
        .join("line")
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y)
        .attr("stroke", "#adb5bd")
        .attr("stroke-width", 0.5)
        .attr("stroke-opacity", 0.3);

      // Draw simplified nodes
      minimapNodeG.selectAll("circle")
        .data(nodes, (d) => d.id)
        .join("circle")
        .attr("cx", (d) => d.x)
        .attr("cy", (d) => d.y)
        .attr("r", 3)
        .attr("fill", (d) => {
          const tc = nodeTypes[d.type];
          return d.color || (tc && tc.color) || "#adb5bd";
        })
        .attr("stroke", "none");

      // Update viewport rectangle
      const t = d3.zoomTransform(svg.node());
      const vx = -t.x / t.k;
      const vy = -t.y / t.k;
      const vw = W / t.k;
      const vh = H / t.k;
      minimapViewport
        .attr("x", vx * mScale + offX)
        .attr("y", vy * mScale + offY)
        .attr("width", vw * mScale)
        .attr("height", vh * mScale);

      // Store scale info for click navigation
      minimapDiv._mScale = mScale;
      minimapDiv._offX = offX;
      minimapDiv._offY = offY;
    }

    // Click on minimap to pan
    minimapDiv.addEventListener("click", (e) => {
      if (minimapDiv._wasDragging) { minimapDiv._wasDragging = false; return; }
      const rect = minimapDiv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const mScale = minimapDiv._mScale || 1;
      const offX = minimapDiv._offX || 0;
      const offY = minimapDiv._offY || 0;
      const graphX = (mx - offX) / mScale;
      const graphY = (my - offY) / mScale;
      const t = d3.zoomTransform(svg.node());
      _programmaticZoom = true;
      svg.transition().duration(300).call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(W / 2 - graphX * t.k, H / 2 - graphY * t.k).scale(t.k)
      );
    });

    // Drag on minimap to pan continuously
    let _minimapDragging = false;
    minimapDiv.addEventListener("mousedown", (e) => {
      _minimapDragging = true;
      minimapDiv._wasDragging = false;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!_minimapDragging) return;
      minimapDiv._wasDragging = true;
      const rect = minimapDiv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const mScale = minimapDiv._mScale || 1;
      const offX = minimapDiv._offX || 0;
      const offY = minimapDiv._offY || 0;
      const graphX = (mx - offX) / mScale;
      const graphY = (my - offY) / mScale;
      const t = d3.zoomTransform(svg.node());
      _programmaticZoom = true;
      svg.call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(W / 2 - graphX * t.k, H / 2 - graphY * t.k).scale(t.k)
      );
    });
    window.addEventListener("mouseup", () => { _minimapDragging = false; });

    // Hook minimap + zoom level + label visibility into zoom handler
    zoomBehavior.on("zoom", (e) => {
      zoomG.attr("transform", e.transform);
      updateMinimap();
      if (zoomLevelSpan) zoomLevelSpan.textContent = Math.round(e.transform.k * 100) + "%";
      // Auto-hide node labels when zoomed out too far
      const k = e.transform.k;
      nodeLayer.selectAll(".sd3n-node text:last-of-type").style("opacity", k < 0.35 ? 0 : k < 0.5 ? (k - 0.35) / 0.15 : 1);
      // Also hide link labels when zoomed out
      linkLabelLayer.style("opacity", k < 0.4 ? 0 : k < 0.6 ? (k - 0.4) / 0.2 : 1);
      // Show degree badges when zoomed in
      nodeLayer.selectAll(".sd3n-degree-badge").style("opacity", k > 1.2 ? 0.8 : null);
    });

    // ── Stats bar ──
    const statsBar = document.createElement("div");
    statsBar.className = "sd3n-stats";
    if (!showStats) statsBar.style.display = "none";
    const nZonesUsed = new Set(nodes.map(n => n.zone).filter(Boolean)).size;
    const nTypes = new Set(nodes.map(n => n.type).filter(Boolean)).size;
    statsBar.innerHTML = `<span>${nodes.length} nodes</span><span>${links.length} edges</span>${nZonesUsed ? `<span>${nZonesUsed} zones</span>` : ""}${nTypes ? `<span>${nTypes} types</span>` : ""}<span class="sd3n-sel-count" style="display:none"></span><span class="sd3n-zoom-level">100%</span>`;
    statsBar.style.pointerEvents = "auto";
    statsBar.style.cursor = "pointer";
    root.appendChild(statsBar);
    const zoomLevelSpan = statsBar.querySelector(".sd3n-zoom-level");
    const selCountSpan = statsBar.querySelector(".sd3n-sel-count");

    function updateSelectionCount() {
      if (!selCountSpan) return;
      const count = selectedIds.size + (selectedId && !selectedIds.has(selectedId) ? 1 : 0);
      if (count > 0) {
        selCountSpan.textContent = `${count} selected`;
        selCountSpan.style.display = "";
        selCountSpan.style.color = "var(--sd3n-accent)";
        selCountSpan.style.fontWeight = "600";
      } else {
        selCountSpan.style.display = "none";
      }
    }

    // Periodically update selection count (covers all mutation cases)
    setInterval(updateSelectionCount, 500);

    // Click stats bar to show graph summary
    statsBar.addEventListener("click", (e) => {
      e.stopPropagation();
      // Compute graph metrics
      const degrees = nodes.map((n) => (adj[n.id] || new Set()).size);
      const avgDegree = degrees.length > 0 ? (degrees.reduce((a, b) => a + b, 0) / degrees.length).toFixed(1) : 0;
      const maxDegree = Math.max(0, ...degrees);
      const maxDegreeNode = nodes[degrees.indexOf(maxDegree)];
      const density = nodes.length > 1 ? (2 * links.length / (nodes.length * (nodes.length - 1))).toFixed(3) : 0;
      const isolatedCount = degrees.filter((d) => d === 0).length;

      // Connected components
      const compVisited = new Set();
      let numComponents = 0;
      nodes.forEach((n) => {
        if (compVisited.has(n.id)) return;
        numComponents++;
        const stack = [n.id];
        while (stack.length > 0) {
          const cur = stack.pop();
          if (compVisited.has(cur)) continue;
          compVisited.add(cur);
          (adj[cur] || new Set()).forEach((nb) => {
            if (!compVisited.has(nb)) stack.push(nb);
          });
        }
      });

      // Diameter estimation (longest shortest path from max-degree node)
      let diameter = 0;
      if (maxDegreeNode) {
        const bfsFrom = (startId) => {
          const dist = { [startId]: 0 };
          const q = [startId];
          let maxD = 0, farthest = startId;
          while (q.length > 0) {
            const cur = q.shift();
            (adj[cur] || new Set()).forEach((nb) => {
              if (dist[nb] === undefined) {
                dist[nb] = dist[cur] + 1;
                if (dist[nb] > maxD) { maxD = dist[nb]; farthest = nb; }
                q.push(nb);
              }
            });
          }
          return { maxD, farthest };
        };
        const pass1 = bfsFrom(maxDegreeNode.id);
        const pass2 = bfsFrom(pass1.farthest);
        diameter = pass2.maxD;
      }

      let panelHtml = `<button class="sd3n-info-close">&times;</button>`;
      panelHtml += `<div class="sd3n-info-title">Graph Summary</div>`;
      panelHtml += `<div class="sd3n-info-subtitle">Network statistics</div>`;
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Nodes</span><span class="sd3n-info-value">${nodes.length}</span></div>`;
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Edges</span><span class="sd3n-info-value">${links.length}</span></div>`;
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Zones</span><span class="sd3n-info-value">${nZonesUsed}</span></div>`;
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Types</span><span class="sd3n-info-value">${nTypes}</span></div>`;
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Components</span><span class="sd3n-info-value">${numComponents}</span></div>`;
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Avg degree</span><span class="sd3n-info-value">${avgDegree}</span></div>`;
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Max degree</span><span class="sd3n-info-value">${maxDegree}${maxDegreeNode ? " (" + shortLabel(maxDegreeNode.label, 12) + ")" : ""}</span></div>`;
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Density</span><span class="sd3n-info-value">${density}</span></div>`;
      if (diameter > 0) {
        panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Diameter</span><span class="sd3n-info-value">${diameter}</span></div>`;
      }
      if (isolatedCount > 0) {
        panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Isolated</span><span class="sd3n-info-value">${isolatedCount}</span></div>`;
      }

      // Average clustering coefficient
      let totalCC = 0;
      let ccCount = 0;
      nodes.forEach((n) => {
        const nbrs = [...(adj[n.id] || [])];
        if (nbrs.length < 2) return;
        let triangles = 0;
        for (let i = 0; i < nbrs.length; i++) {
          for (let j = i + 1; j < nbrs.length; j++) {
            if (adj[nbrs[i]] && adj[nbrs[i]].has(nbrs[j])) triangles++;
          }
        }
        totalCC += (2 * triangles) / (nbrs.length * (nbrs.length - 1));
        ccCount++;
      });
      const avgCC = ccCount > 0 ? (totalCC / ccCount).toFixed(3) : "N/A";
      panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label">Avg clustering</span><span class="sd3n-info-value">${avgCC}</span></div>`;

      // Degree distribution mini histogram
      const degreeFreq = {};
      degrees.forEach((d) => { degreeFreq[d] = (degreeFreq[d] || 0) + 1; });
      const maxFreq = Math.max(1, ...Object.values(degreeFreq));
      const sortedDegrees = Object.keys(degreeFreq).map(Number).sort((a, b) => a - b);
      if (sortedDegrees.length > 1) {
        panelHtml += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--sd3n-border)">`;
        panelHtml += `<div style="font-size:0.6875rem;font-weight:600;color:var(--sd3n-text-muted);text-transform:uppercase;letter-spacing:0.03em;margin-bottom:4px">Degree distribution</div>`;
        panelHtml += `<div style="display:flex;gap:1px;align-items:end;height:32px">`;
        sortedDegrees.forEach((deg) => {
          const h = Math.max(2, (degreeFreq[deg] / maxFreq) * 28);
          const w = Math.max(8, 100 / sortedDegrees.length);
          panelHtml += `<div title="Degree ${deg}: ${degreeFreq[deg]} nodes" style="width:${w}px;height:${h}px;background:var(--sd3n-accent);opacity:0.6;border-radius:1px 1px 0 0"></div>`;
        });
        panelHtml += `</div>`;
        panelHtml += `<div style="display:flex;justify-content:space-between;font-size:0.5625rem;color:var(--sd3n-text-muted);margin-top:1px"><span>${sortedDegrees[0]}</span><span>${sortedDegrees[sortedDegrees.length - 1]}</span></div>`;
        panelHtml += `</div>`;
      }

      // Zone breakdown mini pie chart
      if (zones.length > 1) {
        const zoneCounts = {};
        zones.forEach((z) => { zoneCounts[z.name] = 0; });
        nodes.forEach((n) => { if (zoneCounts[n.zone] !== undefined) zoneCounts[n.zone]++; });
        const total = nodes.length || 1;
        const pieR = 28, pieCx = 36, pieCy = 36;
        let pieAngle = -Math.PI / 2;
        let piePaths = "";
        let pieLegend = "";
        zones.forEach((z) => {
          const count = zoneCounts[z.name] || 0;
          if (count === 0) return;
          const sweep = (count / total) * 2 * Math.PI;
          const x1 = pieCx + pieR * Math.cos(pieAngle);
          const y1 = pieCy + pieR * Math.sin(pieAngle);
          const x2 = pieCx + pieR * Math.cos(pieAngle + sweep);
          const y2 = pieCy + pieR * Math.sin(pieAngle + sweep);
          const large = sweep > Math.PI ? 1 : 0;
          if (zones.filter(zz => (zoneCounts[zz.name] || 0) > 0).length === 1) {
            piePaths += `<circle cx="${pieCx}" cy="${pieCy}" r="${pieR}" fill="${z.color}" opacity="0.7"/>`;
          } else {
            piePaths += `<path d="M${pieCx},${pieCy} L${x1},${y1} A${pieR},${pieR} 0 ${large},1 ${x2},${y2} Z" fill="${z.color}" opacity="0.7"><title>${z.label}: ${count} (${Math.round(count / total * 100)}%)</title></path>`;
          }
          pieAngle += sweep;
          pieLegend += `<div style="display:flex;align-items:center;gap:4px;font-size:0.625rem"><span style="width:8px;height:8px;border-radius:50%;background:${z.color};flex-shrink:0"></span>${z.label || z.name}: ${count}</div>`;
        });
        panelHtml += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--sd3n-border)">`;
        panelHtml += `<div style="font-size:0.6875rem;font-weight:600;color:var(--sd3n-text-muted);text-transform:uppercase;letter-spacing:0.03em;margin-bottom:4px">Zone breakdown</div>`;
        panelHtml += `<div style="display:flex;gap:12px;align-items:center">`;
        panelHtml += `<svg width="72" height="72" viewBox="0 0 72 72">${piePaths}</svg>`;
        panelHtml += `<div style="display:flex;flex-direction:column;gap:2px">${pieLegend}</div>`;
        panelHtml += `</div></div>`;
      }

      infoPanel.innerHTML = panelHtml;
      infoPanel.classList.add("visible");
      infoPanel.querySelector(".sd3n-info-close").addEventListener("click", () => {
        infoPanel.classList.remove("visible");
      });
    });

    // ── Path animation ──
    let _pathParticleTimer = null;
    function animatePathParticle(pathIds) {
      // Remove previous path particle
      zoomG.selectAll(".sd3n-path-particle").remove();
      if (_pathParticleTimer) { cancelAnimationFrame(_pathParticleTimer); _pathParticleTimer = null; }

      if (pathIds.length < 2) return;
      const pathNodes = pathIds.map((id) => nodeMap[id]).filter(Boolean);
      if (pathNodes.length < 2) return;

      // Calculate total path length
      let totalLen = 0;
      const segments = [];
      for (let i = 0; i < pathNodes.length - 1; i++) {
        const dx = pathNodes[i + 1].x - pathNodes[i].x;
        const dy = pathNodes[i + 1].y - pathNodes[i].y;
        const len = Math.sqrt(dx * dx + dy * dy);
        segments.push({ from: pathNodes[i], to: pathNodes[i + 1], len, cumLen: totalLen });
        totalLen += len;
      }

      const particle = zoomG.append("circle")
        .attr("class", "sd3n-path-particle")
        .attr("r", 5)
        .attr("fill", "var(--sd3n-accent)")
        .attr("opacity", 0.9)
        .style("filter", "drop-shadow(0 0 4px rgba(255, 75, 75, 0.8))");

      // Trail circles for glow effect
      const trail = [];
      for (let i = 0; i < 4; i++) {
        trail.push(zoomG.append("circle")
          .attr("class", "sd3n-path-particle")
          .attr("r", 4 - i)
          .attr("fill", "var(--sd3n-accent)")
          .attr("opacity", 0.4 - i * 0.1));
      }

      let t = 0;
      const speed = 0.005;
      let loops = 0;
      const maxLoops = 3;

      function tick() {
        t += speed;
        if (t > 1) {
          t -= 1;
          loops++;
          if (loops >= maxLoops) {
            // Clean up after animation
            zoomG.selectAll(".sd3n-path-particle").remove();
            _pathParticleTimer = null;
            return;
          }
        }

        const dist = t * totalLen;
        // Find current segment
        let seg = segments[segments.length - 1];
        for (let i = 0; i < segments.length; i++) {
          if (dist <= segments[i].cumLen + segments[i].len) {
            seg = segments[i];
            break;
          }
        }

        const segT = (dist - seg.cumLen) / (seg.len || 1);
        const px = seg.from.x + (seg.to.x - seg.from.x) * segT;
        const py = seg.from.y + (seg.to.y - seg.from.y) * segT;

        particle.attr("cx", px).attr("cy", py);
        // Update trail with delay
        trail.forEach((tr, i) => {
          const trailT = Math.max(0, t - (i + 1) * 0.01);
          const trailDist = trailT * totalLen;
          let trSeg = segments[segments.length - 1];
          for (let j = 0; j < segments.length; j++) {
            if (trailDist <= segments[j].cumLen + segments[j].len) {
              trSeg = segments[j];
              break;
            }
          }
          const trSegT = (trailDist - trSeg.cumLen) / (trSeg.len || 1);
          tr.attr("cx", trSeg.from.x + (trSeg.to.x - trSeg.from.x) * trSegT);
          tr.attr("cy", trSeg.from.y + (trSeg.to.y - trSeg.from.y) * trSegT);
        });

        _pathParticleTimer = requestAnimationFrame(tick);
      }
      _pathParticleTimer = requestAnimationFrame(tick);
    }

    // ── Right-click context menu ──
    const contextMenu = document.createElement("div");
    contextMenu.className = "sd3n-context-menu";
    root.appendChild(contextMenu);

    function hideContextMenu() {
      contextMenu.classList.remove("visible");
    }

    root.addEventListener("click", hideContextMenu);

    nodeSel.on("contextmenu", (e, d) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      let menuHtml = `<button class="sd3n-context-menu-item" data-ctx="select">Select "${shortLabel(d.label, 20)}"</button>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-ctx="neighbors">Show neighbors (${(adj[d.id] || new Set()).size})</button>`;
      if (selectedId && selectedId !== d.id) {
        menuHtml += `<button class="sd3n-context-menu-item" data-ctx="path">Find path from ${shortLabel(nodeMap[selectedId]?.label || selectedId, 15)}</button>`;
      }
      menuHtml += `<button class="sd3n-context-menu-item" data-ctx="pin">${d._pinned ? "Unpin" : "Pin"} node</button>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-ctx="isolate">Isolate neighborhood</button>`;
      menuHtml += `<div class="sd3n-context-menu-sep"></div>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-ctx="center">Center on node</button>`;
      if (d.zone) {
        menuHtml += `<button class="sd3n-context-menu-item" data-ctx="filter-zone">Filter zone: ${zoneLabelMap[d.zone] || d.zone}</button>`;
      }
      menuHtml += `<button class="sd3n-context-menu-item" data-ctx="copy-id">Copy ID: ${d.id}</button>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-ctx="copy-json">Copy as JSON</button>`;

      // Add action buttons
      const typeActions = actions[d.type] || [];
      const wildcardActions = (actions["*"] || []).filter(
        (wa) => !typeActions.some((ta) => ta.key === wa.key)
      );
      const nodeActions = [...typeActions, ...wildcardActions];
      if (nodeActions.length > 0) {
        menuHtml += `<div class="sd3n-context-menu-sep"></div>`;
        nodeActions.forEach((a) => {
          menuHtml += `<button class="sd3n-context-menu-item" data-ctx="action" data-action-key="${a.key}">${a.label}</button>`;
        });
      }

      contextMenu.innerHTML = menuHtml;
      contextMenu.style.left = x + "px";
      contextMenu.style.top = y + "px";
      contextMenu.classList.add("visible");

      // Ensure menu doesn't go off-screen
      requestAnimationFrame(() => {
        const menuRect = contextMenu.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        if (menuRect.right > rootRect.right) {
          contextMenu.style.left = (x - menuRect.width) + "px";
        }
        if (menuRect.bottom > rootRect.bottom) {
          contextMenu.style.top = (y - menuRect.height) + "px";
        }
      });

      // Wire context menu items
      contextMenu.querySelectorAll("[data-ctx]").forEach((item) => {
        item.addEventListener("click", function (evt) {
          evt.stopPropagation();
          hideContextMenu();
          const action = this.dataset.ctx;
          if (action === "select") {
            selectNode(d, true);
          } else if (action === "neighbors") {
            selectNode(d, true);
          } else if (action === "path") {
            if (selectedId && selectedId !== d.id) {
              const path = findShortestPath(adj, selectedId, d.id);
              if (path) {
                const pathIds = new Set(path);
                nodeSel.classed("dimmed", (n) => !pathIds.has(n.id));
                nodeSel.classed("highlighted", (n) => pathIds.has(n.id));
                linkSel.classed("dimmed", (l) => {
                  const s = typeof l.source === "object" ? l.source.id : l.source;
                  const t = typeof l.target === "object" ? l.target.id : l.target;
                  // Check if this link is part of the path
                  for (let i = 0; i < path.length - 1; i++) {
                    if ((path[i] === s && path[i + 1] === t) || (path[i] === t && path[i + 1] === s)) return false;
                  }
                  return true;
                });
                linkLabelSel.classed("dimmed", true);
                showToast(`Shortest path: ${path.length - 1} hop${path.length > 2 ? "s" : ""}`);
                // Animate a glowing particle along the path
                animatePathParticle(path);
                // Show path in info panel
                let panelHtml = `<button class="sd3n-info-close">&times;</button>`;
                panelHtml += `<div class="sd3n-info-title">Shortest path</div>`;
                panelHtml += `<div class="sd3n-info-subtitle">${path.length - 1} hop${path.length > 2 ? "s" : ""}</div>`;
                path.forEach((id, i) => {
                  const n = nodeMap[id];
                  if (!n) return;
                  const arrow = i < path.length - 1 ? " \u2192" : "";
                  panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label" style="cursor:pointer" data-goto="${id}">${i + 1}. ${n.label}${arrow}</span></div>`;
                });
                infoPanel.innerHTML = panelHtml;
                infoPanel.classList.add("visible");
                infoPanel.querySelector(".sd3n-info-close").addEventListener("click", () => {
                  infoPanel.classList.remove("visible");
                  clearHighlight();
                });
                infoPanel.querySelectorAll("[data-goto]").forEach((el) => {
                  el.addEventListener("click", function (evt) {
                    evt.stopPropagation();
                    const targetId = this.dataset.goto;
                    if (targetId && nodeMap[targetId]) selectNode(nodeMap[targetId], true);
                  });
                });
              } else {
                showToast("No path found");
              }
            }
          } else if (action === "pin") {
            if (d._pinned) {
              d.fx = null; d.fy = null; d._pinned = false;
              simulation.alpha(0.3).restart();
            } else {
              d.fx = d.x; d.fy = d.y; d._pinned = true;
            }
            if (_settled) persistPositions();
          } else if (action === "isolate") {
            // Show only this node + direct neighbors + 2nd-degree neighbors
            const n1 = adj[d.id] || new Set();
            const visible = new Set([d.id, ...n1]);
            n1.forEach((id) => {
              (adj[id] || new Set()).forEach((id2) => visible.add(id2));
            });
            nodeSel.classed("dimmed", (n) => !visible.has(n.id));
            nodeSel.classed("highlighted", (n) => n.id === d.id);
            linkSel.classed("dimmed", (l) => {
              const s = typeof l.source === "object" ? l.source.id : l.source;
              const t = typeof l.target === "object" ? l.target.id : l.target;
              return !visible.has(s) || !visible.has(t);
            });
            linkLabelSel.classed("dimmed", (l) => {
              const s = typeof l.source === "object" ? l.source.id : l.source;
              const t = typeof l.target === "object" ? l.target.id : l.target;
              return !visible.has(s) || !visible.has(t);
            });
            showToast(`Isolated: ${visible.size} nodes`);
          } else if (action === "center") {
            const t = d3.zoomTransform(svg.node());
            const scale = Math.max(t.k, 1.2);
            _programmaticZoom = true;
            svg.transition().duration(400).call(
              zoomBehavior.transform,
              d3.zoomIdentity.translate(W / 2 - d.x * scale, H / 2 - d.y * scale).scale(scale)
            );
          } else if (action === "filter-zone") {
            const matchIds = new Set();
            nodes.forEach((n) => { if (n.zone === d.zone) matchIds.add(n.id); });
            nodeSel.classed("dimmed", (n) => !matchIds.has(n.id));
            linkSel.classed("dimmed", (l) => {
              const s = typeof l.source === "object" ? l.source.id : l.source;
              const t = typeof l.target === "object" ? l.target.id : l.target;
              return !matchIds.has(s) && !matchIds.has(t);
            });
            linkLabelSel.classed("dimmed", true);
          } else if (action === "copy-id") {
            navigator.clipboard?.writeText(d.id).then(() => showToast("Copied: " + d.id));
          } else if (action === "copy-json") {
            const jsonObj = {
              id: d.id, label: d.label, type: d.type, zone: d.zone,
              status: d.status || null,
              connections: [...(adj[d.id] || [])],
              data: d.data || {},
            };
            navigator.clipboard?.writeText(JSON.stringify(jsonObj, null, 2)).then(() => showToast("JSON copied"));
          } else if (action === "action") {
            const actionKey = this.dataset.actionKey;
            setTriggerValue("action", {
              key: actionKey,
              node_id: d.id,
              node_label: d.label,
              node_type: d.type,
              node_zone: d.zone,
              node_data: d.data || {},
              connected: [...(adj[d.id] || [])],
            });
          }
        });
      });
    });

    // Background context menu (right-click on empty space)
    svgEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      hideContextMenu();
      const rect = root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      let menuHtml = `<button class="sd3n-context-menu-item" data-bg-ctx="fit">Fit to content</button>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-bg-ctx="unpin-all">Unpin all nodes</button>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-bg-ctx="select-all">Select all nodes</button>`;
      menuHtml += `<div class="sd3n-context-menu-sep"></div>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-bg-ctx="add-note">Add note here</button>`;
      if (selectedIds.size > 0) {
        menuHtml += `<button class="sd3n-context-menu-item" data-bg-ctx="save-group">Save selection (${selectedIds.size} nodes)</button>`;
      }
      if (_savedGroups.length > 0) {
        menuHtml += `<div class="sd3n-context-menu-sep"></div>`;
        _savedGroups.forEach((grp, i) => {
          menuHtml += `<button class="sd3n-context-menu-item" data-bg-ctx="load-group" data-group-idx="${i}">Load: ${grp.name} (${grp.ids.length})</button>`;
        });
      }
      menuHtml += `<div class="sd3n-context-menu-sep"></div>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-bg-ctx="scale-degree">${_scaledByDegree ? "Reset" : "Scale"} nodes by degree</button>`;
      menuHtml += `<div class="sd3n-context-menu-sep"></div>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-bg-ctx="export-json">Export as JSON</button>`;
      menuHtml += `<button class="sd3n-context-menu-item" data-bg-ctx="stats">Graph statistics</button>`;

      contextMenu.innerHTML = menuHtml;
      contextMenu.style.left = x + "px";
      contextMenu.style.top = y + "px";
      contextMenu.classList.add("visible");

      contextMenu.querySelectorAll("[data-bg-ctx]").forEach((item) => {
        item.addEventListener("click", function (evt) {
          evt.stopPropagation();
          hideContextMenu();
          const action = this.dataset.bgCtx;
          if (action === "fit") {
            fitToContent(300);
          } else if (action === "unpin-all") {
            resetBtn?.click();
          } else if (action === "select-all") {
            selectedIds.clear();
            nodes.forEach((n) => selectedIds.add(n.id));
            nodeSel.classed("highlighted", true).classed("dimmed", false);
            showToast(`Selected ${nodes.length} nodes`);
          } else if (action === "export-json") {
            const exportData = {
              nodes: nodes.map((n) => ({
                id: n.id, label: n.label, type: n.type, zone: n.zone,
                x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10,
                status: n.status || undefined, data: n.data || undefined,
              })),
              links: links.map((l) => ({
                source: typeof l.source === "object" ? l.source.id : l.source,
                target: typeof l.target === "object" ? l.target.id : l.target,
                label: l.label || undefined, color: l.color || undefined,
              })),
              zones: zones,
              metadata: {
                nodeCount: nodes.length, edgeCount: links.length,
                exported: new Date().toISOString(),
              },
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "network-graph.json";
            a.click();
            URL.revokeObjectURL(a.href);
            showToast("JSON exported");
          } else if (action === "add-note") {
            const t = d3.zoomTransform(svg.node());
            const gx = (x - t.x) / t.k;
            const gy = (y - t.y) / t.k;
            addAnnotation(gx, gy);
          } else if (action === "save-group") {
            const name = `Group ${_savedGroups.length + 1}`;
            _savedGroups.push({ name, ids: [...selectedIds] });
            showToast(`Saved "${name}" (${selectedIds.size} nodes)`);
          } else if (action === "load-group") {
            const idx = parseInt(this.dataset.groupIdx);
            const grp = _savedGroups[idx];
            if (grp) {
              selectedIds.clear();
              grp.ids.forEach((id) => selectedIds.add(id));
              nodeSel.classed("highlighted", (n) => selectedIds.has(n.id));
              nodeSel.classed("dimmed", (n) => !selectedIds.has(n.id));
              linkSel.classed("dimmed", (l) => {
                const s = typeof l.source === "object" ? l.source.id : l.source;
                const t = typeof l.target === "object" ? l.target.id : l.target;
                return !selectedIds.has(s) && !selectedIds.has(t);
              });
              showToast(`Loaded "${grp.name}" (${grp.ids.length} nodes)`);
            }
          } else if (action === "scale-degree") {
            _scaledByDegree = !_scaledByDegree;
            if (_scaledByDegree) {
              const degrees = nodes.map((n) => (adj[n.id] || new Set()).size);
              const maxDeg = Math.max(1, ...degrees);
              nodeSel.each(function (d) {
                const g = d3.select(this);
                const deg = (adj[d.id] || new Set()).size;
                const scale = 0.6 + (deg / maxDeg) * 0.8;
                d._degreeScale = scale;
                const shape = g.select("circle, rect, path");
                if (!shape.empty()) {
                  shape.transition().duration(400).attr("transform", `scale(${scale})`);
                }
              });
              showToast("Nodes scaled by degree");
            } else {
              nodeSel.each(function (d) {
                const g = d3.select(this);
                d._degreeScale = 1;
                const shape = g.select("circle, rect, path");
                if (!shape.empty()) {
                  shape.transition().duration(400).attr("transform", null);
                }
              });
              showToast("Node scaling reset");
            }
          } else if (action === "stats") {
            statsBar.click();
          }
        });
      });
    });

    // ── Overlay mode flags ──
    let _focusMode = false;
    let _communityMode = false;
    let _voronoiMode = false;
    let _zoneFlowMode = false;

    // ── Annotations / Sticky notes ──
    const _annotations = [];
    let _annotationIdCounter = 0;

    function addAnnotation(gx, gy, text = "") {
      const id = _annotationIdCounter++;
      const annotation = { id, x: gx, y: gy, text: text || "Note" };
      _annotations.push(annotation);
      renderAnnotation(annotation);
    }

    function renderAnnotation(ann) {
      const g = zoomG.append("g")
        .attr("class", "sd3n-annotation")
        .attr("transform", `translate(${ann.x},${ann.y})`)
        .attr("data-ann-id", ann.id);

      // Note background
      const fo = g.append("foreignObject")
        .attr("width", 140).attr("height", 80)
        .attr("x", 0).attr("y", 0);

      const noteDiv = fo.append("xhtml:div")
        .attr("class", "sd3n-note")
        .html(`
          <div class="sd3n-note-close" data-ann-close="${ann.id}">&times;</div>
          <div class="sd3n-note-text" contenteditable="true" spellcheck="false">${ann.text}</div>
        `);

      // Make draggable
      const dragBehavior = d3.drag()
        .on("drag", (e) => {
          ann.x += e.dx;
          ann.y += e.dy;
          g.attr("transform", `translate(${ann.x},${ann.y})`);
        });
      g.call(dragBehavior);

      // Close button
      noteDiv.select(`[data-ann-close="${ann.id}"]`).on("click", () => {
        g.transition().duration(200).style("opacity", 0).remove();
        const idx = _annotations.findIndex(a => a.id === ann.id);
        if (idx >= 0) _annotations.splice(idx, 1);
      });

      // Animate in
      g.style("opacity", 0).transition().duration(300).style("opacity", 1);

      // Update text on edit
      noteDiv.select(".sd3n-note-text").on("blur", function () {
        ann.text = this.textContent;
      });
    }

    // ── Lasso / Box selection (Shift+drag on background) ──
    const lassoRect = zoomG.append("rect").attr("class", "sd3n-lasso").style("display", "none");
    let _lassoStart = null;

    svg.on("mousedown.lasso", (e) => {
      if (!e.shiftKey || e.target !== svgEl) return;
      const t = d3.zoomTransform(svg.node());
      const x = (e.offsetX - t.x) / t.k;
      const y = (e.offsetY - t.y) / t.k;
      _lassoStart = { x, y };
      lassoRect.attr("x", x).attr("y", y).attr("width", 0).attr("height", 0).style("display", null);
      // Temporarily disable zoom during lasso
      svg.on(".zoom", null);
    });

    svg.on("mousemove.lasso", (e) => {
      if (!_lassoStart) return;
      const t = d3.zoomTransform(svg.node());
      const x = (e.offsetX - t.x) / t.k;
      const y = (e.offsetY - t.y) / t.k;
      const lx = Math.min(_lassoStart.x, x);
      const ly = Math.min(_lassoStart.y, y);
      const lw = Math.abs(x - _lassoStart.x);
      const lh = Math.abs(y - _lassoStart.y);
      lassoRect.attr("x", lx).attr("y", ly).attr("width", lw).attr("height", lh);
    });

    svg.on("mouseup.lasso", (e) => {
      if (!_lassoStart) return;
      const t = d3.zoomTransform(svg.node());
      const x = (e.offsetX - t.x) / t.k;
      const y = (e.offsetY - t.y) / t.k;
      const lx = Math.min(_lassoStart.x, x);
      const ly = Math.min(_lassoStart.y, y);
      const lw = Math.abs(x - _lassoStart.x);
      const lh = Math.abs(y - _lassoStart.y);
      _lassoStart = null;
      lassoRect.style("display", "none");

      // Re-enable zoom
      svg.call(zoomBehavior);

      if (lw < 5 && lh < 5) return; // Too small, ignore

      // Find nodes inside the lasso rectangle
      selectedIds.clear();
      nodes.forEach((n) => {
        if (n.x >= lx && n.x <= lx + lw && n.y >= ly && n.y <= ly + lh) {
          selectedIds.add(n.id);
        }
      });

      if (selectedIds.size === 0) return;

      // Highlight selected nodes
      const visible = new Set(selectedIds);
      selectedIds.forEach((id) => {
        (adj[id] || new Set()).forEach((n) => visible.add(n));
      });
      nodeSel.classed("dimmed", (n) => !visible.has(n.id));
      nodeSel.classed("highlighted", (n) => selectedIds.has(n.id));
      linkSel.classed("dimmed", (l) => {
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        return !visible.has(s) || !visible.has(t);
      });

      // Show summary in info panel
      const selNodes = [...selectedIds].map((id) => nodeMap[id]).filter(Boolean);
      let panelHtml = `<button class="sd3n-info-close">&times;</button>`;
      panelHtml += `<div class="sd3n-info-title">${selNodes.length} nodes selected</div>`;
      panelHtml += `<div class="sd3n-info-subtitle">Lasso selection</div>`;
      selNodes.forEach((n) => {
        panelHtml += `<div class="sd3n-info-row"><span class="sd3n-info-label" style="cursor:pointer" data-goto="${n.id}">${n.label}</span><span class="sd3n-info-value" style="font-size:0.6875rem;opacity:0.5">${n.type}</span></div>`;
      });
      infoPanel.innerHTML = panelHtml;
      infoPanel.classList.add("visible");
      infoPanel.querySelector(".sd3n-info-close").addEventListener("click", () => {
        selectedIds.clear();
        infoPanel.classList.remove("visible");
        clearHighlight();
        /* setStateValue("selected_node", null); // disabled: avoid rerun */
      });
      infoPanel.querySelectorAll("[data-goto]").forEach((el) => {
        el.addEventListener("click", function (evt) {
          evt.stopPropagation();
          const targetId = this.dataset.goto;
          if (targetId && nodeMap[targetId]) {
            selectNode(nodeMap[targetId], true);
            selectedIds.clear();
          }
        });
      });
      showToast(`Selected ${selNodes.length} nodes`);
    });

    // (Breadcrumb updates handled by updateBreadcrumbs() defined earlier)

    // ── Animated flow particles ──
    if (showParticles) {
      const particleLayer = zoomG.insert("g", ":first-child");
      const PARTICLE_COUNT = Math.min(links.length * 2, 60);
      const particles = [];

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const linkIdx = i % links.length;
        particles.push({
          linkIdx,
          t: Math.random(),
          speed: 0.003 + Math.random() * 0.004,
        });
      }

      const particleSel = particleLayer
        .selectAll("circle")
        .data(particles)
        .join("circle")
        .attr("class", "sd3n-flow-particle")
        .attr("r", 1.5)
        .attr("fill", (p) => {
          const l = links[p.linkIdx];
          return l ? (l.color || "#adb5bd") : "#adb5bd";
        })
        .attr("opacity", 0.4);

      function animateParticles() {
        particles.forEach((p) => {
          p.t += p.speed;
          if (p.t > 1) p.t -= 1;
        });
        particleSel
          .attr("cx", (p) => {
            const l = links[p.linkIdx];
            if (!l || !l.source || !l.target) return 0;
            const { sx, cx, tx } = _linkControl(l);
            const u = 1 - p.t;
            return u * u * sx + 2 * u * p.t * cx + p.t * p.t * tx;
          })
          .attr("cy", (p) => {
            const l = links[p.linkIdx];
            if (!l || !l.source || !l.target) return 0;
            const { sy, cy, ty } = _linkControl(l);
            const u = 1 - p.t;
            return u * u * sy + 2 * u * p.t * cy + p.t * p.t * ty;
          });
        requestAnimationFrame(animateParticles);
      }
      requestAnimationFrame(animateParticles);
    }

    // ── Persist positions ──
    // No-op: positions/zoom are NOT persisted via setStateValue to avoid reruns.
    // They live only in JS memory. Lost on external rerun (slider change etc.)
    // but the graph re-simulates to a good layout anyway.
    function persistPositions() { /* no-op */ }

    // After synchronous simulation, explicitly position all elements
    // (The tick handler may have updated stale DOM from a previous render)
    // Skip node positioning if entrance animation is running (it handles its own transforms)
    if (hasRestoredLayout) {
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    }
    linkSel.attr("d", linkPath);
    linkLabelSel
      .attr("x", (l) => linkMidpoint(l).x)
      .attr("y", (l) => linkMidpoint(l).y - 4);
    if (showHulls) updateHulls();

    // Fit to viewport
    if (!savedTransform || zoomToId) {
      requestAnimationFrame(() => {
        if (!savedTransform) fitToContent(0);
        _settled = true;
        if (zoomToId) zoomToNode();
        if (savedSelectedNode) restoreSelection(savedSelectedNode.id);
        updateMinimap();
      });
    } else {
      _settled = true;
      if (savedSelectedNode) restoreSelection(savedSelectedNode.id);
      updateMinimap();
    }

    function restoreSelection(nodeId) {
      if (!nodeId || !nodeMap[nodeId]) return;
      selectNode(nodeMap[nodeId], false);
    }

    // ── Apply initial layout if not force ──
    if (initialLayout !== "force" && !hasRestoredLayout) {
      // Delay to ensure DOM is ready and initial render complete
      setTimeout(() => applyLayout(initialLayout), 100);
    }

    // ── Apply programmatic filter from Python ──
    if (filterType && filterValue) {
      const matchIds = new Set();
      nodes.forEach((n) => {
        if (filterType === "zone" && n.zone === filterValue) matchIds.add(n.id);
        else if (filterType === "type" && n.type === filterValue) matchIds.add(n.id);
      });
      if (matchIds.size > 0) {
        nodeSel.classed("dimmed", (n) => !matchIds.has(n.id));
        linkSel.classed("dimmed", (l) => {
          const s = typeof l.source === "object" ? l.source.id : l.source;
          const t = typeof l.target === "object" ? l.target.id : l.target;
          return !matchIds.has(s) && !matchIds.has(t);
        });
        linkLabelSel.classed("dimmed", true);
      }
    }

    // ── Allow interactive simulation restart (drag/unpin) ──
    // Re-enable async simulation for user interactions
    // The simulation is stopped; drag handlers call simulation.alphaTarget(0.1).restart()
    // which will re-enable the async timer and fire tick events normally.
  }
}
