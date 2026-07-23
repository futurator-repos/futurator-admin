// GraphEngine — canvas force-directed renderer for the Mycelium knowledge graph.
// Three layout modes (cloud / lanes / radial), X-ray + blast-radius + docs overlays,
// per-layer node shapes, per-kind icon glyphs, structured search dimming, pan/zoom/drag.
// Instantiated by the DC logic class. Pure vanilla; no framework.
(function () {
  const KIND_COLOR = {
    file: '#3b82f6', function: '#22d3ee', class: '#a855f7', dir: '#64748b',
    decision: '#f0abfc', system: '#f97316', requirement: '#22c55e',
    table: '#10b981', lambda: '#14b8a6', cron: '#0d9488', secret: '#ef4444',
    bucket: '#6366f1', bucketPath: '#818cf8', iamRole: '#fb7185', cloudfront: '#06b6d4', vpc: '#94a3b8',
    topic: '#8b5cf6', queue: '#7c3aed', bus: '#6d28d9', eventSource: '#a78bfa',
    endpoint: '#0ea5e9', externalService: '#f43f5e',
    capability: '#84cc16', service: '#64748b', contractRevision: '#a3a3a3',
    document: '#eab308', docSection: '#f59e0b',
  };
  const EDGE_COLOR = {
    DEPENDS_ON: '#94a3b8', DERIVED_FROM: '#60a5fa', REFINES: '#22d3ee', VALIDATES: '#34d399',
    SUPERSEDES: '#f87171', CONFLICTS_WITH: '#f43f5e', ENABLES: '#facc15', INFORMS: '#a3a3a3',
    DEFINES: '#0ea5e9', IMPORTS: '#ec4899', CALLS: '#f59e0b', CONTAINS: '#3a4659',
    HANDLED_BY: '#fcd34d', USES: '#fb923c', READS: '#f59e0b', WRITES: '#ea580c',
    ROUTES: '#fbbf24', CALLS_ENDPOINT: '#fdba74', REPRESENTS: '#fca5a5', CALLS_SERVICE: '#f87171',
    TRIGGERS: '#8b5cf6', SUBSCRIBES: '#a78bfa', EMITS: '#7c3aed',
    CONSUMES_CONTRACT: '#64748b', IMPLEMENTS: '#84cc16', REVISED: '#a3a3a3',
    REFERENCES: '#f59e0b', GOVERNS: '#d97706', DESCRIBES: '#fbbf24', SPECIFIES: '#fde68a',
  };
  const COMMUNITY = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#cab000', '#999999'];
  const LAYER_OF = {
    file: 'code', function: 'code', class: 'code', dir: 'code',
    decision: 'knowledge', system: 'knowledge', requirement: 'knowledge',
    table: 'infra', lambda: 'infra', cron: 'infra', secret: 'infra', bucket: 'infra',
    bucketPath: 'infra', iamRole: 'infra', cloudfront: 'infra', vpc: 'infra',
    topic: 'events', queue: 'events', bus: 'events', eventSource: 'events',
    endpoint: 'api', externalService: 'external',
    capability: 'contract', service: 'contract', contractRevision: 'contract',
    document: 'docs', docSection: 'docs',
  };
  const LANE_ORDER = ['docs', 'knowledge', 'code', 'api', 'events', 'infra', 'external', 'contract'];
  const LANE_LABEL = { docs: 'Docs', knowledge: 'Knowledge', code: 'Code', api: 'API', events: 'Events', infra: 'Infra', external: 'External', contract: 'Contracts' };
  const BLAST_TYPES = new Set(['READS', 'USES', 'CALLS', 'WRITES', 'ROUTES', 'CALLS_ENDPOINT', 'CALLS_SERVICE', 'TRIGGERS', 'SUBSCRIBES', 'EMITS', 'IMPORTS', 'HANDLED_BY']);
  const DOC_KINDS = new Set(['document', 'docSection']);
  const BASE_SIZE = { function: 4, class: 4, docSection: 6, dir: 6, externalService: 9, document: 9, table: 8, lambda: 8, endpoint: 8, service: 8, capability: 8 };

  function baseRadius(n) { return BASE_SIZE[n.kind] || 7; }

  // ---------- icon glyphs (white, centered at 0,0, scaled to radius r) ----------
  function drawIcon(ctx, kind, r) {
    const s = r * 0.92;
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const text = (g, f) => { ctx.font = `${(f || 1.5) * r}px ui-monospace, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(g, 0, r * 0.08); };
    switch (kind) {
      case 'function': text('\u0192', 1.6); break;
      case 'lambda': text('\u03bb', 1.4); break;
      case 'docSection': text('\u00a7', 1.5); break;
      case 'bucketPath': text('/', 1.6); break;
      case 'class': { ctx.strokeRect(-s * 0.55, -s * 0.55, s * 1.1, s * 1.1); ctx.beginPath(); ctx.moveTo(-s * 0.55, -s * 0.1); ctx.lineTo(s * 0.55, -s * 0.1); ctx.stroke(); break; }
      case 'file': case 'document': {
        ctx.beginPath(); ctx.moveTo(-s * 0.5, -s * 0.62); ctx.lineTo(s * 0.2, -s * 0.62); ctx.lineTo(s * 0.5, -s * 0.32); ctx.lineTo(s * 0.5, s * 0.62); ctx.lineTo(-s * 0.5, s * 0.62); ctx.closePath(); ctx.stroke();
        for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-s * 0.3, -s * 0.05 + i * s * 0.28); ctx.lineTo(s * 0.3, -s * 0.05 + i * s * 0.28); ctx.stroke(); } break;
      }
      case 'dir': { ctx.beginPath(); ctx.moveTo(-s * 0.6, -s * 0.35); ctx.lineTo(-s * 0.15, -s * 0.35); ctx.lineTo(-s * 0.02, -s * 0.55); ctx.lineTo(s * 0.6, -s * 0.55); ctx.lineTo(s * 0.6, s * 0.45); ctx.lineTo(-s * 0.6, s * 0.45); ctx.closePath(); ctx.stroke(); break; }
      case 'table': { for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(-s * 0.6, -s * 0.45 + i * s * 0.3); ctx.lineTo(s * 0.6, -s * 0.45 + i * s * 0.3); ctx.stroke(); } ctx.beginPath(); ctx.moveTo(0, -s * 0.45); ctx.lineTo(0, s * 0.45); ctx.stroke(); break; }
      case 'cron': { ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -s * 0.4); ctx.moveTo(0, 0); ctx.lineTo(s * 0.32, s * 0.12); ctx.stroke(); break; }
      case 'secret': case 'iamRole': { ctx.strokeRect(-s * 0.5, -s * 0.1, s, s * 0.62); ctx.beginPath(); ctx.arc(0, -s * 0.1, s * 0.32, Math.PI, 0); ctx.stroke(); break; }
      case 'bucket': { ctx.beginPath(); ctx.ellipse(0, -s * 0.5, s * 0.55, s * 0.2, 0, 0, Math.PI * 2); ctx.moveTo(-s * 0.55, -s * 0.5); ctx.lineTo(-s * 0.4, s * 0.55); ctx.lineTo(s * 0.4, s * 0.55); ctx.lineTo(s * 0.55, -s * 0.5); ctx.stroke(); break; }
      case 'endpoint': { ctx.beginPath(); ctx.moveTo(-s * 0.5, -s * 0.45); ctx.quadraticCurveTo(-s * 0.7, 0, -s * 0.5, s * 0.45); ctx.moveTo(s * 0.5, -s * 0.45); ctx.quadraticCurveTo(s * 0.7, 0, s * 0.5, s * 0.45); ctx.moveTo(s * 0.18, -s * 0.5); ctx.lineTo(-s * 0.18, s * 0.5); ctx.stroke(); break; }
      case 'externalService': { ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, Math.PI * 2); ctx.moveTo(-s * 0.62, 0); ctx.lineTo(s * 0.62, 0); ctx.ellipse(0, 0, s * 0.28, s * 0.62, 0, 0, Math.PI * 2); ctx.stroke(); break; }
      case 'topic': { ctx.beginPath(); ctx.arc(0, 0, s * 0.18, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(0, 0, s * 0.45, -0.7, 0.7); ctx.arc(0, 0, s * 0.68, -0.6, 0.6); ctx.stroke(); break; }
      case 'queue': { for (let i = 0; i < 3; i++) ctx.strokeRect(-s * 0.55 + i * s * 0.4, -s * 0.45, s * 0.26, s * 0.9); break; }
      case 'bus': { ctx.beginPath(); ctx.moveTo(-s * 0.6, 0); ctx.lineTo(s * 0.6, 0); ctx.moveTo(-s * 0.3, -s * 0.4); ctx.lineTo(-s * 0.3, s * 0.4); ctx.moveTo(s * 0.3, -s * 0.4); ctx.lineTo(s * 0.3, s * 0.4); ctx.stroke(); break; }
      case 'eventSource': { ctx.beginPath(); ctx.moveTo(s * 0.15, -s * 0.6); ctx.lineTo(-s * 0.35, s * 0.1); ctx.lineTo(s * 0.02, s * 0.1); ctx.lineTo(-s * 0.15, s * 0.6); ctx.lineTo(s * 0.35, -s * 0.1); ctx.lineTo(-s * 0.02, -s * 0.1); ctx.closePath(); ctx.fill(); break; }
      case 'cloudfront': { ctx.beginPath(); ctx.arc(-s * 0.2, s * 0.05, s * 0.32, Math.PI * 0.5, Math.PI * 1.5); ctx.arc(s * 0.05, -s * 0.2, s * 0.34, Math.PI, Math.PI * 2); ctx.arc(s * 0.3, s * 0.05, s * 0.3, Math.PI * 1.5, Math.PI * 0.5); ctx.lineTo(-s * 0.2, s * 0.37); ctx.stroke(); break; }
      case 'service': { for (let i = 0; i < 2; i++) { ctx.strokeRect(-s * 0.55, -s * 0.5 + i * s * 0.55, s * 1.1, s * 0.42); ctx.beginPath(); ctx.arc(-s * 0.35, -s * 0.29 + i * s * 0.55, s * 0.05, 0, 7); ctx.fill(); } break; }
      case 'capability': { ctx.beginPath(); for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * Math.PI * 2 / 5; const a2 = a + Math.PI / 5; ctx.lineTo(Math.cos(a) * s * 0.62, Math.sin(a) * s * 0.62); ctx.lineTo(Math.cos(a2) * s * 0.26, Math.sin(a2) * s * 0.26); } ctx.closePath(); ctx.stroke(); break; }
      case 'vpc': { ctx.beginPath(); ctx.moveTo(-s * 0.25, -s * 0.5); ctx.lineTo(-s * 0.5, -s * 0.5); ctx.lineTo(-s * 0.5, s * 0.5); ctx.lineTo(-s * 0.25, s * 0.5); ctx.moveTo(s * 0.25, -s * 0.5); ctx.lineTo(s * 0.5, -s * 0.5); ctx.lineTo(s * 0.5, s * 0.5); ctx.lineTo(s * 0.25, s * 0.5); ctx.stroke(); break; }
      default: { ctx.beginPath(); ctx.arc(0, 0, s * 0.32, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  // ---------- node body shape per layer ----------
  function pathShape(ctx, layer, r) {
    ctx.beginPath();
    if (layer === 'infra') { const rr = r * 0.4; const x = -r, y = -r, w = 2 * r, h = 2 * r; ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath(); }
    else if (layer === 'api') { ctx.moveTo(0, -r * 1.18); ctx.lineTo(r * 1.18, 0); ctx.lineTo(0, r * 1.18); ctx.lineTo(-r * 1.18, 0); ctx.closePath(); }
    else if (layer === 'events') { for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const fn = i === 0 ? 'moveTo' : 'lineTo'; ctx[fn](Math.cos(a) * r * 1.12, Math.sin(a) * r * 1.12); } ctx.closePath(); }
    else if (layer === 'docs') { const w = r * 1.5, h = r * 2; ctx.rect(-w / 2, -h / 2, w, h); }
    else if (layer === 'contract') { const rr = r; const x = -r * 1.25, w = r * 2.5; ctx.moveTo(x + rr, -r); ctx.lineTo(x + w - rr, -r); ctx.arc(x + w - rr, 0, r, -Math.PI / 2, Math.PI / 2); ctx.lineTo(x + rr, r); ctx.arc(x + rr, 0, r, Math.PI / 2, -Math.PI / 2); ctx.closePath(); }
    else { ctx.arc(0, 0, r, 0, Math.PI * 2); }
  }

  class GraphEngine {
    constructor(canvas, opts) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.opts = opts || {};
      this.nodes = []; this.edges = []; this.byId = {}; this.adj = {};
      this.mode = 'cloud'; this.theme = 'dark';
      this.hiddenKinds = new Set(); this.hiddenEdges = new Set();
      this.overlay = { xray: false, blast: false, includeDocs: false };
      this.search = ''; this.matchSet = null; this.litSet = null;
      this.selected = null; this.hovered = null; this.blastSet = null; this.focusNode = null;
      this.cam = { x: 0, y: 0, s: 1 }; this.alpha = 0; this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this._drag = null; this._pan = null; this._running = true;
      this._bind(); this.resize();
      const loop = () => { if (!this._running) return; this._tick(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    destroy() { this._running = false; this._unbind && this._unbind(); }

    setData(data) {
      const W = this.W || 900, H = this.H || 600;
      this.nodes = data.nodes.map((n) => Object.assign({}, n, { x: (rndOnce() - 0.5) * W * 0.6, y: (rndOnce() - 0.5) * H * 0.6, vx: 0, vy: 0 }));
      this.byId = {}; this.adj = {};
      this.nodes.forEach((n) => { this.byId[n.nodeId] = n; this.adj[n.nodeId] = []; });
      this.maxCent = Math.max(0.001, ...this.nodes.map((n) => n.centrality || 0));
      this.edges = data.edges.filter((e) => this.byId[e.source] && this.byId[e.target]);
      this.edges.forEach((e) => { this.adj[e.source].push({ o: e.target, e }); this.adj[e.target].push({ o: e.source, e }); });
      this.relayout();
    }

    setMode(m) { if (m === this.mode) return; this.mode = m; this.relayout(); }
    setTheme(t) { this.theme = t; }
    setHiddenKinds(set) { this.hiddenKinds = new Set(set); this.reheat(0.2); }
    setHiddenEdges(set) { this.hiddenEdges = new Set(set); }
    setOverlay(o) { const wasBlast = this.overlay.blast; Object.assign(this.overlay, o); if (o.blast !== undefined && o.blast !== wasBlast) this._recomputeBlast(); this.reheat(0.15); }
    setSelected(id) { this.selected = id ? this.byId[id] : null; if (this.mode === 'radial' && this.selected) { this.focusNode = this.selected; this.relayout(); } this._recomputeBlast(); }
    setSearch(q) { this.search = q || ''; this._recomputeSearch(); }

    reheat(a) { this.alpha = Math.max(this.alpha, a || 0.5); }
    relayout() {
      if (this.mode === 'radial') {
        this.focusNode = this.selected || this._topGod();
        this._computeRadialTargets();
      }
      this.reheat(this.mode === 'radial' ? 0.9 : 0.85);
    }
    _topGod() { return [...this.nodes].filter((n) => n.degree > 0).sort((a, b) => (b.centrality || 0) - (a.centrality || 0))[0]; }

    visible(n) {
      if (this.hiddenKinds.has(n.kind)) return false;
      if (DOC_KINDS.has(n.kind) && !this.overlay.includeDocs) return false;
      return true;
    }
    edgeVisible(e) {
      if (this.hiddenEdges.has(e.type)) return false;
      const s = this.byId[e.source], t = this.byId[e.target];
      return s && t && this.visible(s) && this.visible(t);
    }

    // ---------- blast radius ----------
    _recomputeBlast() {
      this.blastSet = null; this.blastInfo = null;
      if (!this.overlay.blast || !this.selected) { this.opts.onBlast && this.opts.onBlast(null); return; }
      const start = this.selected.nodeId;
      const reached = new Map(); reached.set(start, 0);
      let frontier = [start];
      for (let hop = 1; hop <= 2; hop++) {
        const next = [];
        frontier.forEach((id) => this.adj[id].forEach(({ o, e }) => {
          if (!BLAST_TYPES.has(e.type)) return;
          if (e.source !== id) return; // directed outward
          if (!reached.has(o)) { reached.set(o, hop); next.push(o); }
        }));
        frontier = next;
      }
      this.blastSet = reached;
      const byLayer = {}; let paid = [];
      reached.forEach((hop, id) => { if (id === start) return; const n = this.byId[id]; const L = LAYER_OF[n.kind]; (byLayer[L] = byLayer[L] || []).push(n); if (n.kind === 'externalService' && n.billable) paid.push(n); });
      this.blastInfo = { start: this.selected, count: reached.size - 1, byLayer, paid };
      this.opts.onBlast && this.opts.onBlast(this.blastInfo);
    }

    // ---------- search ----------
    _recomputeSearch() {
      const q = this.search.trim();
      if (!q) { this.matchSet = null; this.litSet = null; this.opts.onSearch && this.opts.onSearch(0); return; }
      const toks = q.split(/\s+/);
      const preds = toks.map((t) => {
        const m = t.match(/^(\w+):(.*)$/);
        if (m) { const k = m[1].toLowerCase(), v = m[2].toLowerCase(); return (n) => String(n[k] != null ? n[k] : (k === 'type' ? '' : '')).toLowerCase().includes(v) || (k === 'kind' && n.kind.toLowerCase() === v) || (k === 'status' && (n.status || 'active') === v) || (k === 'auth' && String(!!n.auth) === v) || (k === 'billable' && String(!!n.billable) === v) || (k === 'id' && n.nodeId.toLowerCase().includes(v)) || (k === 'title' && (n.title || '').toLowerCase().includes(v)); }
        const v = t.toLowerCase();
        return (n) => (n.nodeId + ' ' + (n.title || '') + ' ' + (n.label || '') + ' ' + (n.summary || '')).toLowerCase().includes(v);
      });
      const match = new Set();
      this.nodes.forEach((n) => { if (this.visible(n) && preds.every((p) => p(n))) match.add(n.nodeId); });
      const lit = new Set(match);
      match.forEach((id) => this.adj[id].forEach(({ o }) => lit.add(o)));
      this.matchSet = match; this.litSet = lit;
      this.opts.onSearch && this.opts.onSearch(match.size);
    }

    // ---------- layout targets ----------
    _laneX(layer) { const i = LANE_ORDER.indexOf(layer); return (i - (LANE_ORDER.length - 1) / 2) * 240; }
    _computeRadialTargets() {
      const f = this.focusNode; if (!f) return;
      const hop = new Map(); hop.set(f.nodeId, 0); let fr = [f.nodeId]; const maxHop = 4;
      for (let h = 1; h <= maxHop; h++) { const nx = []; fr.forEach((id) => this.adj[id].forEach(({ o }) => { if (!hop.has(o)) { hop.set(o, h); nx.push(o); } })); fr = nx; }
      const ring = {}; this.nodes.forEach((n) => { const h = hop.has(n.nodeId) ? hop.get(n.nodeId) : maxHop + 1; (ring[h] = ring[h] || []).push(n); });
      Object.keys(ring).forEach((h) => {
        const arr = ring[h].sort((a, b) => LANE_ORDER.indexOf(LAYER_OF[a.kind]) - LANE_ORDER.indexOf(LAYER_OF[b.kind]));
        const R = +h === 0 ? 0 : 130 * +h; const n = arr.length;
        arr.forEach((nd, i) => { const a = (i / Math.max(1, n)) * Math.PI * 2 + (+h * 0.6); nd.tx = Math.cos(a) * R; nd.ty = Math.sin(a) * R; nd.ring = +h; });
      });
    }

    // ---------- simulation ----------
    _tick() {
      const ctx = this.ctx; if (!ctx) return;
      if (this.alpha > 0.004) {
        this.alpha *= 0.97;
        const nodes = this.nodes, mode = this.mode;
        if (mode === 'radial') {
          for (const n of nodes) { if (n === this._dragNode) continue; n.x += (n.tx - n.x) * 0.12; n.y += (n.ty - n.y) * 0.12; }
        } else {
          // repulsion (O(n^2), fine for our size)
          for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i]; if (!this.visible(a)) continue;
            for (let j = i + 1; j < nodes.length; j++) {
              const b = nodes[j]; if (!this.visible(b)) continue;
              let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy; if (d2 < 1) { d2 = 1; dx = (rndOnce() - 0.5); dy = (rndOnce() - 0.5); }
              const f = 900 / d2; const d = Math.sqrt(d2); const fx = (dx / d) * f, fy = (dy / d) * f;
              a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
            }
          }
          // links
          for (const e of this.edges) {
            const a = this.byId[e.source], b = this.byId[e.target]; if (!this.visible(a) || !this.visible(b)) continue;
            const dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const target = e.type === 'CONTAINS' ? 46 : 78; const k = (d - target) * 0.012;
            const fx = (dx / d) * k, fy = (dy / d) * k; a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          }
          // gravity + lane
          for (const n of nodes) {
            if (n === this._dragNode) continue;
            if (mode === 'lanes') { n.vx += (this._laneX(LAYER_OF[n.kind]) - n.x) * 0.05; n.vy += (-n.y) * 0.002; }
            else { n.vx += (-n.x) * 0.004; n.vy += (-n.y) * 0.004; }
          }
          const damp = mode === 'lanes' ? 0.82 : 0.86;
          for (const n of nodes) { if (n === this._dragNode) continue; n.vx *= damp; n.vy *= damp; n.x += n.vx * this.alpha * 2.4; n.y += n.vy * this.alpha * 2.4; }
        }
      }
      this._draw();
    }

    // ---------- rendering ----------
    _draw() {
      const ctx = this.ctx, W = this.W, H = this.H, dark = this.theme === 'dark';
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = dark ? '#0c1118' : '#fbfcfe'; ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2, H / 2); ctx.scale(this.cam.s, this.cam.s); ctx.translate(-this.cam.x, -this.cam.y);

      if (this.mode === 'lanes') this._drawLanes(ctx, dark);
      if (this.mode === 'radial') this._drawRings(ctx, dark);
      if (this.mode === 'cloud' && this.overlay.xray) this._drawHulls(ctx);

      const dim = (id, idN) => {
        if (this.matchSet) return this.litSet.has(id) ? 1 : 0.07;
        if (this.blastSet) return this.blastSet.has(id) ? 1 : 0.06;
        if (this.selected) { return (idN === this.selected || this.adj[this.selected.nodeId].some((a) => a.o === id)) ? 1 : 0.16; }
        return 1;
      };

      // edges
      ctx.lineWidth = 1;
      for (const e of this.edges) {
        if (!this.edgeVisible(e)) continue;
        const a = this.byId[e.source], b = this.byId[e.target];
        let al = Math.min(dim(e.source), dim(e.target));
        if (this.blastSet && al >= 1 && !(this.blastSet.has(e.source) && this.blastSet.has(e.target) && BLAST_TYPES.has(e.type))) al = 0.5;
        let col = EDGE_COLOR[e.type] || '#94a3b8';
        if (e.type === 'DERIVED_FROM' && a.isDoc) col = '#eab308';
        const hot = this.blastSet && this.blastSet.has(e.source) && this.blastSet.has(e.target) && BLAST_TYPES.has(e.type);
        this._edge(ctx, a, b, col, al, e, hot);
      }

      // nodes
      for (const n of this.nodes) {
        if (!this.visible(n)) continue;
        this._node(ctx, n, dim(n.nodeId, n), dark);
      }
      ctx.restore();
    }

    _edge(ctx, a, b, col, al, e, hot) {
      ctx.globalAlpha = al; ctx.strokeStyle = col; ctx.lineWidth = hot ? 2.2 : (e.type === 'CONTAINS' ? 0.6 : 1);
      if (e.provenance === 'INFERRED') ctx.setLineDash([5, 4]); else if (e.provenance === 'AMBIGUOUS') ctx.setLineDash([1.5, 3]); else ctx.setLineDash([]);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1; const rb = this._r(b);
      const ex = b.x - (dx / d) * (rb + 2), ey = b.y - (dy / d) * (rb + 2);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey); ctx.stroke();
      if (al > 0.3 && e.type !== 'CONTAINS') { // arrowhead at 95%
        const ah = Math.max(3, 4.5 / this.cam.s * this.cam.s); const ang = Math.atan2(dy, dx);
        ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(ex, ey);
        ctx.lineTo(ex - ah * Math.cos(ang - 0.4), ey - ah * Math.sin(ang - 0.4));
        ctx.lineTo(ex - ah * Math.cos(ang + 0.4), ey - ah * Math.sin(ang + 0.4));
        ctx.closePath(); ctx.fillStyle = col; ctx.fill();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    _r(n) {
      let r = baseRadius(n);
      if (this.overlay.xray) r = baseRadius(n) + ((n.centrality || 0) / this.maxCent) * 14;
      if (this.matchSet && this.matchSet.has(n.nodeId)) r *= 2.0;
      if (n === this.selected) r *= 1.18;
      return r;
    }

    _node(ctx, n, al, dark) {
      const r = this._r(n); const layer = LAYER_OF[n.kind];
      const col = this.overlay.xray && n.community != null ? COMMUNITY[n.community % 8] : (KIND_COLOR[n.kind] || '#94a3b8');
      ctx.globalAlpha = al;
      // selection / hover / blast-root ring
      if (n === this.selected || n === this.hovered || (this.blastInfo && this.blastInfo.start === n)) {
        ctx.beginPath(); pathShape(ctx, layer, r + 4); ctx.strokeStyle = dark ? '#fff' : '#0b1220'; ctx.lineWidth = 2; ctx.stroke();
      }
      // billable ring
      if (n.kind === 'externalService' && n.billable) { ctx.beginPath(); ctx.arc(n.x !== undefined ? 0 : 0, 0, 0, 0, 0); }
      ctx.save(); ctx.translate(n.x, n.y);
      // body
      pathShape(ctx, layer, r); ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)'; ctx.stroke();
      // billable $ ring
      if (n.kind === 'externalService' && n.billable) {
        ctx.beginPath(); ctx.arc(0, 0, r + 3.5, 0, Math.PI * 2); ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.6; ctx.stroke();
        ctx.fillStyle = '#fbbf24'; ctx.font = `bold ${r * 0.9}px ui-monospace, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('$', r + 0.5, -r - 0.5);
      }
      // icon
      if (r >= 5) drawIcon(ctx, n.kind, r);
      ctx.restore();
      // label
      const showLabel = al > 0.5 && (this.cam.s > 1.25 || (n.centrality || 0) > 0.5 || n === this.selected || n === this.hovered || (this.matchSet && this.matchSet.has(n.nodeId)));
      if (showLabel) {
        ctx.font = `${Math.max(9, 10)}px ui-sans-serif, system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const tx = n.x, ty = n.y + r + 2; const t = n.label || n.title || '';
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.82)' : 'rgba(15,23,42,0.82)';
        ctx.fillText(t.length > 22 ? t.slice(0, 21) + '\u2026' : t, tx, ty);
      }
      ctx.globalAlpha = 1;
    }

    _drawLanes(ctx, dark) {
      const ys = this.nodes.filter((n) => this.visible(n)).map((n) => n.y);
      const top = Math.min(-300, ...ys) - 60, bot = Math.max(300, ...ys) + 80;
      LANE_ORDER.forEach((L, i) => {
        const x = this._laneX(L); const has = this.nodes.some((n) => this.visible(n) && LAYER_OF[n.kind] === L); if (!has) return;
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.018)' : 'rgba(15,23,42,0.025)';
        ctx.fillRect(x - 110, top, 220, bot - top);
        ctx.font = '600 13px ui-sans-serif, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.5)' : 'rgba(15,23,42,0.55)';
        ctx.fillText(LANE_LABEL[L].toUpperCase(), x, top + 8);
      });
    }
    _drawRings(ctx, dark) {
      if (!this.focusNode) return;
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.07)'; ctx.lineWidth = 1;
      for (let h = 1; h <= 4; h++) { ctx.beginPath(); ctx.arc(0, 0, 130 * h, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.3)'; ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText(h + ' hop', 0, -130 * h - 6);
      }
    }
    _drawHulls(ctx) {
      const groups = {}; this.nodes.forEach((n) => { if (this.visible(n) && n.community != null) (groups[n.community] = groups[n.community] || []).push(n); });
      Object.keys(groups).forEach((c) => {
        const g = groups[c]; if (g.length < 3) return; let cx = 0, cy = 0; g.forEach((n) => { cx += n.x; cy += n.y; }); cx /= g.length; cy /= g.length;
        let R = 0; g.forEach((n) => { R = Math.max(R, Math.hypot(n.x - cx, n.y - cy)); });
        ctx.beginPath(); ctx.arc(cx, cy, R + 26, 0, Math.PI * 2); ctx.fillStyle = COMMUNITY[c % 8] + '14'; ctx.fill();
      });
    }

    // ---------- interaction ----------
    resize() {
      const rect = this.canvas.getBoundingClientRect(); this.W = rect.width; this.H = rect.height;
      this.canvas.width = rect.width * this.dpr; this.canvas.height = rect.height * this.dpr;
    }
    _screen(px, py) { return { x: (px - this.W / 2) / this.cam.s + this.cam.x, y: (py - this.H / 2) / this.cam.s + this.cam.y }; }
    _hit(px, py) {
      const w = this._screen(px, py); let best = null, bd = 1e9;
      for (const n of this.nodes) { if (!this.visible(n)) continue; const r = this._r(n) + 4; const d = Math.hypot(n.x - w.x, n.y - w.y); if (d < r && d < bd) { bd = d; best = n; } }
      return best;
    }
    fit() {
      const vis = this.nodes.filter((n) => this.visible(n)); if (!vis.length) return;
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      vis.forEach((n) => { minx = Math.min(minx, n.x); miny = Math.min(miny, n.y); maxx = Math.max(maxx, n.x); maxy = Math.max(maxy, n.y); });
      const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2; const w = maxx - minx + 120, h = maxy - miny + 120;
      this.cam.x = cx; this.cam.y = cy; this.cam.s = Math.min(2, Math.max(0.25, Math.min(this.W / w, this.H / h)));
    }
    focus(id) { const n = this.byId[id]; if (!n) return; this.cam.x = n.x; this.cam.y = n.y; this.cam.s = Math.max(this.cam.s, 1.4); }

    _bind() {
      const c = this.canvas;
      const move = (ev) => {
        const rect = c.getBoundingClientRect(); const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
        if (this._dragNode) { const w = this._screen(px, py); this._dragNode.x = w.x; this._dragNode.y = w.y; this._dragNode.vx = 0; this._dragNode.vy = 0; this.reheat(0.3); return; }
        if (this._pan) { this.cam.x -= (px - this._pan.px) / this.cam.s; this.cam.y -= (py - this._pan.py) / this.cam.s; this._pan = { px, py }; return; }
        const h = this._hit(px, py); if (h !== this.hovered) { this.hovered = h; c.style.cursor = h ? 'pointer' : 'grab'; this.opts.onHover && this.opts.onHover(h, ev.clientX, ev.clientY); }
        else if (h) this.opts.onHover && this.opts.onHover(h, ev.clientX, ev.clientY);
      };
      const down = (ev) => {
        const rect = c.getBoundingClientRect(); const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
        const h = this._hit(px, py); if (h) { this._dragNode = h; this._dragMoved = false; this._downXY = { px, py }; } else { this._pan = { px, py }; c.style.cursor = 'grabbing'; }
      };
      const up = (ev) => {
        const rect = c.getBoundingClientRect(); const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
        if (this._dragNode && this._downXY && Math.hypot(px - this._downXY.px, py - this._downXY.py) < 4) { this.opts.onSelect && this.opts.onSelect(this._dragNode); }
        else if (!this._dragNode && this._pan && this._downXY === undefined) { }
        if (this._pan && !this._dragNode) { /* click empty */ }
        this._dragNode = null; this._pan = null; this._downXY = undefined; c.style.cursor = 'grab';
      };
      const wheel = (ev) => {
        ev.preventDefault(); const rect = c.getBoundingClientRect(); const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
        const w0 = this._screen(px, py); const f = Math.exp(-ev.deltaY * 0.0015); this.cam.s = Math.min(4, Math.max(0.15, this.cam.s * f));
        const w1 = this._screen(px, py); this.cam.x += w0.x - w1.x; this.cam.y += w0.y - w1.y;
      };
      const click = (ev) => { const rect = c.getBoundingClientRect(); const h = this._hit(ev.clientX - rect.left, ev.clientY - rect.top); if (!h && !this._panMoved) this.opts.onSelect && this.opts.onSelect(null); };
      c.addEventListener('mousemove', move); c.addEventListener('mousedown', down); window.addEventListener('mouseup', up); c.addEventListener('wheel', wheel, { passive: false }); c.addEventListener('click', click);
      const ro = new ResizeObserver(() => this.resize()); ro.observe(c);
      c.style.cursor = 'grab';
      this._unbind = () => { c.removeEventListener('mousemove', move); c.removeEventListener('mousedown', down); window.removeEventListener('mouseup', up); c.removeEventListener('wheel', wheel); c.removeEventListener('click', click); ro.disconnect(); };
    }
  }

  let _ro = 12345;
  function rndOnce() { _ro = (_ro * 1103515245 + 12345) & 0x7fffffff; return _ro / 0x7fffffff; }

  window.GraphEngine = GraphEngine;
  window.GRAPH_PALETTE = { KIND_COLOR, EDGE_COLOR, COMMUNITY, LAYER_OF, LANE_ORDER, LANE_LABEL, BASE_SIZE };
  window.GRAPH_DRAW = { drawIcon, pathShape, baseRadius };
})();
