/* HPCP Portal — UI, controls, worker wiring and rendering. */
(() => {
  'use strict';

  const SECTORS = ['residential', 'commercial'];
  const LABEL = { residential: 'Residential', commercial: 'Commercial' };
  const CF = 0.155; // Indiana rooftop PV capacity factor
  const BOX = { lon0: -86.33, lon1: -85.94, lat0: 39.63, lat1: 39.93 }; // Indianapolis (Marion County)

  const DEFAULTS = {
    data: {
      source: 'synthetic',
      gen: {
        seed: 2024, K: 245, R: 51, totalCustomers: 568894, resShare: 0.9, startYear: 2010, endYear: 2025,
        sectors: {
          residential: { target: 1600, rho: 0.25, aS: 0.25, aB: 0.04, lagMonths: 6, sigma: 0.8 },
          commercial: { target: 142, rho: 0.18, aS: 0.15, aB: 0.02, lagMonths: 9, sigma: 0.6 },
        },
      },
      upload: null,
    },
    model: { tau: 2019, L: 12, M: 5, hl: 24, horizon: 2051, simSeed: 7 },
    sectors: {
      residential: { conf: 0.9, capPct: 7.56, tp: 2032, paths: 100, kw: 7 },
      commercial: { conf: 0.1, capPct: 3.87, tp: 2031, paths: 100, kw: 60 },
    },
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  const $ = id => document.getElementById(id);
  const fmtInt = Viz.fmtInt, compact = Viz.compact, ym = Viz.ym;
  const pct = (v, d = 0) => (v * 100).toFixed(d) + '%';

  // ------------------------------------------------------------ math typesetting
  // KaTeX (from cdnjs) renders TeX in the browser; if it is unavailable the TeX
  // is turned into plain HTML set in a Times/Computer Modern style face.
  const TEX_SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', lambda: 'λ', mu: 'μ', rho: 'ρ', sigma: 'σ', tau: 'τ', eta: 'η', Delta: 'Δ',
    odot: '⊙', infty: '∞', top: '⊤', times: '×', div: '÷', cdot: '·', le: '≤', ge: '≥', approx: '≈', in: '∈',
    sum: 'Σ', min: 'min', max: 'max', lVert: '‖', rVert: '‖', ldots: '…', qquad: '  ', quad: ' ',
  };
  function texFallback(src) {
    let s = src.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    s = s.replace(/\\(?:text|mathrm|mathbf|operatorname|mathcal)\{([^{}]*)\}/g, '$1')
      .replace(/\\hat\{?([A-Za-z])\}?/g, '$1̂').replace(/\\tilde\{?\s*([A-Za-z])\}?/g, '$1̃')
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '')
      .replace(/\\([A-Za-z]+)/g, (m, w) => TEX_SYMBOLS[w] != null ? TEX_SYMBOLS[w] : w)
      .replace(/\\([%,;:!{} ])/g, (m, c) => (c === '%' ? '%' : c === '{' || c === '}' ? c : ' '))
      .replace(/_\{([^{}]*)\}|_(\S)/g, (m, a, b) => `<sub>${a != null ? a : b}</sub>`)
      .replace(/\^\{([^{}]*)\}|\^(\S)/g, (m, a, b) => `<sup>${a != null ? a : b}</sup>`)
      .replace(/[{}]/g, '');
    return s;
  }
  function tex(el, src, display) {
    if (window.katex) {
      try { katex.render(src, el, { displayMode: !!display, throwOnError: false, output: 'html' }); return el; } catch (e) { /* fall through */ }
    }
    el.classList.add('tex-fallback');
    el.innerHTML = texFallback(src); // src is the page's own TeX, never user data
    return el;
  }
  // text with $...$ math segments, e.g. 'Training cutoff $\tau$'
  function renderRich(el, text) {
    el.textContent = '';
    String(text).split(/(\$[^$]+\$)/).forEach(part => {
      if (/^\$[^$]+\$$/.test(part)) el.append(tex(document.createElement('span'), part.slice(1, -1)));
      else if (part) el.append(document.createTextNode(part));
    });
    return el;
  }
  const stripTex = s => String(s).replace(/\$([^$]+)\$/g, (m, t) => texFallback(t).replace(/<[^>]+>/g, ''));
  // a plain readout such as "2019-01", "12 months", "25.0%/yr" or "1,600" as TeX
  function toTeX(s) {
    // words first, so later substitutions never land inside a \text{}
    return String(s)
      .replace(/(\s*)([A-Za-z][A-Za-z-]*)/g, (m, sp, w) => `\\text{${sp}${w}}`)
      .replace(/%/g, '\\%')
      .replace(/(\d),(\d)/g, '$1{,}$2')
      .replace(/(\d)-(\d)/g, '$1\\text{-}$2')
      .replace(/ (?=[\d.])/g, '\\ ');
  }
  const texNum = (el, s) => tex(el, toTeX(s));
  // typeset every \( \) and \[ \] in a subtree (the README is written that way)
  function renderMathIn(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (/\\[([]/.test(n.nodeValue) && !n.parentElement.closest('.katex, code, script, style')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      n.nodeValue.split(/(\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/).forEach(part => {
        const m = part.match(/^\\([([])([\s\S]+)\\[)\]]$/);
        if (m) frag.append(tex(document.createElement(m[1] === '[' ? 'div' : 'span'), m[2], m[1] === '['));
        else if (part) frag.append(document.createTextNode(part));
      });
      n.replaceWith(frag);
    }
  }

  const cfg = clone(DEFAULTS);
  const S = {
    active: 'residential', data: null, hist: null,
    sec: { residential: {}, commercial: {} },
    metric: 'units', mapMetric: 'upper',
    runId: 0, busy: false, lastRunMs: null,
  };

  // ------------------------------------------------------------ controls
  const ym2 = v => ym(v + 1 / 12 - 1e-9); // slider value is a month start (year + m/12)
  // `help` is shown by the "?" button next to each control
  const MODEL_CTL = [
    { key: 'tau', label: 'Training cutoff $\\tau$', min: 2013, max: 2023, step: 1 / 12, fmt: ym2,
      help: 'The model behind the conformal intervals is fitted only on records before $\\tau$. Every rolling window after $\\tau$ becomes a calibration pair (Algorithm $1$). An earlier cutoff gives more calibration windows but less training data.' },
    { key: 'L', label: 'Prediction window $\\Delta t$', min: 3, max: 12, step: 3, fmt: v => `${v} months`,
      help: 'Length $\\Delta t$ of the future window the conformal intervals cover: new installations per circuit and substation over the next $\\Delta t$. Calibration windows have the same length and start every month.' },
    { key: 'M', label: 'Simulated samples $M$', min: 1, max: 30, step: 1, fmt: v => String(v),
      help: 'Number of futures $\\tilde y^{(1)},\\dots,\\tilde y^{(M)}$ simulated per window by Ogata thinning. The score uses the closest sample, and intervals span the samples’ $\\min$ to $\\max$ plus the conformal margin $\\hat Q_k$ (Eq. $7$–$8$). The paper finds intervals are tightest near $M = 5$.' },
    { key: 'hl', label: 'Recency weighting', min: 0, max: 60, step: 6, fmt: v => v ? `half-life ${v} mo` : 'off',
      help: 'Weighted conformal quantile: a calibration window’s weight is $w_j = 2^{-\\Delta_j / h}$, where $\\Delta_j$ is how many months it lies in the past and $h$ is the half-life. Recent behaviour then counts more when adoption dynamics drift. Off sets every $w_j = 1$.' },
  ];
  const SCEN_CTL = [
    { key: 'conf', label: 'Confidence level $1-\\alpha$', min: 0.05, max: 0.99, step: 0.01, fmt: v => pct(v),
      help: 'Target coverage $1-\\alpha$ of the next-window conformal intervals. It also sets the width of the long-range scenario band. Defaults follow the original dashboard: $90\\%$ residential, and $10\\%$ commercial because very few commercial installations exist so far.' },
    { key: 'capPct', label: 'Penetration cap', min: 0.5, max: 25, step: 0.01, fmt: v => v.toFixed(2) + '%',
      help: 'Theoretical limit of adoptions per customer in the network, $N_{\\text{cap}}$. After the tipping point, the adoption rate shrinks with the remaining headroom $1 - N_t/N_{\\text{cap}}$. Defaults: $7.56\\%$ residential, $3.87\\%$ commercial.' },
    { key: 'tp', label: 'Tipping point $t_{\\text{tp}}$', min: 2025, max: 2045, step: 1 / 12, fmt: ym2,
      help: 'The date the saturating (decaying) effect kicks in. Before it, $\\gamma(t) = 1$ and adoption follows the fitted dynamics; after it, $\\gamma(t)$ slows adoption as it approaches the cap. Defaults: $2032$-$01$ residential, $2031$-$01$ commercial.' },
    { key: 'kw', label: 'Average system size', min: 2, max: 250, step: 1, fmt: v => v + ' kW',
      help: 'Converts installations into capacity ($\\text{MW}$) and annual generation, at a $15.5\\%$ capacity factor. Affects only the Capacity and Generation views.' },
    { key: 'paths', label: 'Monte Carlo paths', min: 20, max: 300, step: 10, fmt: v => String(v),
      help: 'Number of long-range trajectories simulated to $2050$. More paths give a smoother median and band but take longer to compute.' },
  ];
  const GEN_CTL = [
    { key: 'target', label: 'Expected records $2010$–$2024$', min: 20, max: 6000, step: 10, fmt: v => fmtInt(v),
      help: 'Expected number of installation records generated in this sector for $2010$–$2024$. Sets the overall level of the background rates $\\mu_k$.' },
    { key: 'rho', label: 'Background growth $\\rho$', min: 0, max: 0.5, step: 0.01, fmt: v => pct(v) + '/yr',
      help: 'Yearly growth rate $\\rho$ of background adoption $\\mu_k e^{\\rho t}$, standing in for falling costs and policy support.' },
    { key: 'aS', label: 'Self-excitation $\\alpha_{\\text{self}}$', min: 0, max: 0.8, step: 0.01, fmt: v => v.toFixed(2),
      help: 'Peer effect within a circuit: $\\alpha_{\\text{self}}$ is the expected number of follow-on installations on the same circuit triggered by each installation.' },
    { key: 'aB', label: 'Sibling excitation $\\alpha_{\\text{sib}}$', min: 0, max: 0.2, step: 0.005, fmt: v => v.toFixed(3),
      help: 'Peer effect across circuits: $\\alpha_{\\text{sib}}$ is the expected number of follow-on installations each installation triggers on every sibling circuit under the same substation.' },
    { key: 'lagMonths', label: 'Peer-effect lag $1/\\beta$', min: 1, max: 36, step: 1, fmt: v => v + ' mo',
      help: 'Average delay $1/\\beta$ between an installation and the installations it triggers, through the exponential kernel $\\beta e^{-\\beta (t - t\')}$.' },
    { key: 'sigma', label: 'Spatial disparity $\\sigma$', min: 0, max: 1.5, step: 0.05, fmt: v => v.toFixed(2),
      help: 'How strongly background adoption varies across neighbourhoods: $\\mu_k \\propto \\text{customers}_k \\cdot e^{\\sigma z_k}$, where $z_k$ is a smooth spatial propensity field (stronger north and south-west).' },
  ];
  const GEN_GLOBAL = [
    { key: 'K', label: 'Circuits $K$', min: 20, max: 400, step: 1, fmt: v => String(v),
      help: 'Number of distribution circuits $K$ in the synthetic grid. The real Indianapolis network has $K = 245$.' },
    { key: 'R', label: 'Substations $R$', min: 5, max: 100, step: 1, fmt: v => String(v),
      help: 'Number of substations $R$. Each circuit belongs to exactly one, and circuits sharing a substation are siblings. The real network has $R = 51$.' },
  ];

  function qButton(text, label) {
    const q = document.createElement('button');
    q.type = 'button';
    q.className = 'q';
    q.textContent = '?';
    q.dataset.help = text;
    q.setAttribute('aria-label', 'About ' + label);
    return q;
  }

  const bound = []; // {input, output, get, set, def}
  function buildRange(parent, def, get, set) {
    const row = document.createElement('div');
    row.className = 'ctl-row';
    const id = 'c_' + Math.random().toString(36).slice(2, 9);
    const head = document.createElement('div');
    head.className = 'ctl-head';
    const lab = document.createElement('label');
    lab.htmlFor = id;
    renderRich(lab, def.label);
    const out = document.createElement('output');
    out.htmlFor = id;
    head.append(lab);
    if (def.help) head.append(qButton(def.help, stripTex(def.label)));
    head.append(out);
    const inp = document.createElement('input');
    Object.assign(inp, { type: 'range', id, min: def.min, max: def.max, step: def.step });
    row.append(head, inp);
    parent.append(row);
    const b = { inp, out, get, set, def };
    inp.addEventListener('input', () => {
      const v = +inp.value;
      set(v);
      texNum(out, def.fmt(v));
      onChange(def.key);
    });
    bound.push(b);
    return b;
  }

  // One floating explanation shared by every "?": hover or focus shows it,
  // a click or tap pins it until the next click elsewhere or Escape.
  function initHelp() {
    const tip = $('qtip');
    let pinned = null;
    const show = q => {
      renderRich(tip, q.dataset.help);
      tip.hidden = false;
      const r = q.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = r.right + 10, y = r.top - 6;
      if (x + tw > innerWidth - 8) { x = Math.max(8, Math.min(innerWidth - tw - 8, r.left - tw / 2)); y = r.bottom + 8; }
      if (y + th > innerHeight - 8) y = Math.max(8, innerHeight - th - 8);
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    };
    const hide = () => { tip.hidden = true; if (pinned) pinned.setAttribute('aria-expanded', 'false'); pinned = null; };
    document.addEventListener('pointerover', e => { const q = e.target.closest('.q'); if (q && !pinned) show(q); });
    document.addEventListener('pointerout', e => { if (e.target.closest('.q') && !pinned) tip.hidden = true; });
    document.addEventListener('focusin', e => { const q = e.target.closest('.q'); if (q) show(q); });
    document.addEventListener('focusout', e => { if (e.target.closest('.q') && !pinned) tip.hidden = true; });
    document.addEventListener('click', e => {
      const q = e.target.closest('.q');
      if (!q) { if (pinned) hide(); return; }
      e.preventDefault();
      if (pinned === q) { hide(); return; }
      if (pinned) pinned.setAttribute('aria-expanded', 'false');
      pinned = q;
      q.setAttribute('aria-expanded', 'true');
      show(q);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
    $('side').querySelector('.side-inner').addEventListener('scroll', hide, { passive: true });
  }

  // Drag the controls panel's edge to resize it. Released near the left edge,
  // it snaps shut and the dashboard takes the full width; dragging from the
  // left edge brings it back. Arrow keys resize, Enter toggles.
  const SIDE_MIN = 240, SIDE_MAX = 560, SIDE_SNAP = 150;
  function setSideWidth(w) {
    S.sideW = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)));
    $('app').style.setProperty('--side-open', S.sideW + 'px');
  }
  function initResizer() {
    const rz = $('sideResizer'), app = $('app');
    let drag = null;
    rz.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      drag = { moved: false };
      rz.setPointerCapture(e.pointerId);
      app.classList.add('dragging');
    });
    rz.addEventListener('pointermove', e => {
      if (!drag) return;
      drag.moved = true;
      const x = e.clientX;
      const snap = x < SIDE_SNAP;
      app.classList.toggle('snap', snap);
      app.classList.toggle('side-hidden', snap);
      if (!snap) setSideWidth(x);
    });
    const end = () => {
      if (!drag) return;
      const snapped = app.classList.contains('snap');
      app.classList.remove('dragging', 'snap');
      if (!drag.moved && snapped === false && app.classList.contains('side-hidden')) setSide(true); // click on the edge tab reopens
      else if (drag.moved) {
        setSide(!snapped);
        try { localStorage.setItem('hpcp-side-w', String(S.sideW)); } catch (e) { /* storage unavailable */ }
      }
      drag = null;
    };
    rz.addEventListener('pointerup', end);
    rz.addEventListener('pointercancel', end);
    rz.addEventListener('keydown', e => {
      const hidden = app.classList.contains('side-hidden');
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (hidden) { if (e.key === 'ArrowRight') setSide(true); return; }
        const w = S.sideW + (e.key === 'ArrowRight' ? 20 : -20);
        if (w < SIDE_MIN) setSide(false); else setSideWidth(w);
      } else if (e.key === 'Enter') setSide(hidden);
    });
  }
  function syncControls() {
    for (const b of bound) { const v = b.get(); b.inp.value = v; texNum(b.out, b.def.fmt(v)); }
    $('seed').value = cfg.data.gen.seed;
    document.querySelectorAll('[data-sector-name]').forEach(e => { e.textContent = '· ' + LABEL[S.active]; });
  }

  function buildControls() {
    for (const d of MODEL_CTL) buildRange($('modelCtl'), d, () => cfg.model[d.key], v => { cfg.model[d.key] = v; });
    for (const d of SCEN_CTL) buildRange($('scenarioCtl'), d, () => cfg.sectors[S.active][d.key], v => { cfg.sectors[S.active][d.key] = v; });
    for (const d of GEN_GLOBAL) buildRange($('genCtl'), d, () => cfg.data.gen[d.key], v => { cfg.data.gen[d.key] = v; });
    const sep = document.createElement('div');
    sep.className = 'sep';
    sep.textContent = 'Sector parameters';
    $('genCtl').append(sep);
    for (const d of GEN_CTL) buildRange($('genCtl'), d, () => cfg.data.gen.sectors[S.active][d.key], v => { cfg.data.gen.sectors[S.active][d.key] = v; });

    $('seed').addEventListener('change', () => { cfg.data.gen.seed = Math.max(1, +$('seed').value | 0); onChange('seed'); });
    $('reseed').addEventListener('click', () => { cfg.data.gen.seed = 1 + Math.floor(Math.random() * 99999); syncControls(); onChange('seed'); });
    $('reset').addEventListener('click', () => {
      const up = cfg.data.upload, src = cfg.data.source;
      Object.assign(cfg, clone(DEFAULTS));
      cfg.data.upload = up; cfg.data.source = up ? src : 'synthetic';
      syncControls(); onChange('reset');
    });
    document.querySelectorAll('[data-source]').forEach(b => b.addEventListener('click', () => setSource(b.dataset.source)));
    document.querySelectorAll('[data-sector]').forEach(b => b.addEventListener('click', () => setSector(b.dataset.sector)));
    document.querySelectorAll('[data-metric]').forEach(b => b.addEventListener('click', () => {
      S.metric = b.dataset.metric;
      document.querySelectorAll('[data-metric]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      renderOutlook();
    }));
    $('mapMetric').addEventListener('change', () => { S.mapMetric = $('mapMetric').value; renderMap(); });
    document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => exportCSV(b.dataset.export)));
    $('fileRecords').addEventListener('change', loadUpload);
    $('fileTopo').addEventListener('change', loadUpload);
    $('custTotal').addEventListener('change', loadUpload);
    $('themeBtn').addEventListener('click', toggleTheme);
    $('readmeBtn').addEventListener('click', () => setReadme(!$('app').classList.contains('readme-open')));
    $('readmeClose').addEventListener('click', () => setReadme(false));
    document.querySelectorAll('[data-readme]').forEach(b => b.addEventListener('click', () => setReadme(true, b.dataset.readme)));
    $('readme').querySelectorAll('.readme-toc a').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      $(a.getAttribute('href').slice(1)).scrollIntoView({ block: 'start' });
    }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('app').classList.contains('readme-open')) setReadme(false); });
    // arrow keys on the tab list
    document.querySelector('.tabs').addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = SECTORS[(SECTORS.indexOf(S.active) + 1) % 2];
      setSector(next);
      document.querySelector(`[data-sector="${next}"]`).focus();
    });
  }

  // left controls panel: collapses to the left, state remembered per browser
  function setSide(show, persist = true) {
    $('app').classList.toggle('side-hidden', !show);
    $('side').inert = !show;
    $('sideResizer').setAttribute('aria-expanded', String(show));
    if (persist) try { localStorage.setItem('hpcp-side', show ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  }
  // README panel: hidden on every page load
  function setReadme(open, anchor) {
    $('app').classList.toggle('readme-open', open);
    $('readme').inert = !open;
    $('readmeBtn').setAttribute('aria-expanded', String(open));
    if (open) {
      // charts inside need the panel's final width
      setTimeout(() => {
        renderCal();
        if (anchor) $(anchor).scrollIntoView({ block: 'start' });
      }, 280);
    }
  }
  const readmeOpen = () => $('app').classList.contains('readme-open');

  function setSector(name) {
    if (name === S.active) return;
    S.active = name;
    document.querySelectorAll('[data-sector]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.sector === name)));
    syncControls();
    renderAll();
    scheduleRun(0);
  }
  function setSource(src) {
    if (src === 'upload' && !cfg.data.upload) {
      $('synthCtl').hidden = true; $('uploadCtl').hidden = false;
      document.querySelectorAll('[data-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === src)));
      return; // wait for a file
    }
    cfg.data.source = src;
    $('synthCtl').hidden = src !== 'synthetic';
    $('uploadCtl').hidden = src !== 'upload';
    document.querySelectorAll('[data-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === src)));
    onChange('source');
  }

  // Confidence changes are applied instantly to the long-range band, then
  // the worker re-runs the (cheap, cached) conformal step.
  function onChange(key) {
    if (key === 'conf' || key === 'kw') renderOutlook();
    if (key === 'kw') return;
    scheduleRun(key === 'conf' ? 60 : 220);
  }

  // ------------------------------------------------------------ worker
  let engine;
  function makeEngine() {
    try {
      const src = HPCPEngine.toString() + '\nconst __E = HPCPEngine();\nself.onmessage = e => __E.handle(e.data, m => self.postMessage(m));';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = e => onMessage(e.data);
      w.onerror = e => { console.warn('Worker failed, falling back to main thread', e); engine = inline(); scheduleRun(0); };
      return { post: m => w.postMessage(m) };
    } catch (e) {
      console.warn('Workers unavailable, running on the main thread', e);
      return inline();
    }
  }
  function inline() {
    const E = HPCPEngine();
    return { post: m => setTimeout(() => E.handle(m, onMessage), 0) };
  }

  let runTimer = null;
  function scheduleRun(delay) {
    clearTimeout(runTimer);
    runTimer = setTimeout(postRun, delay);
  }
  function postRun() {
    S.runId++;
    setBusy(true, 'Updating…');
    const c = clone(Object.assign({}, cfg, { data: Object.assign({}, cfg.data, { upload: null }) }));
    c.data.upload = cfg.data.upload; // structured-clone the (large) upload directly
    c.active = S.active;
    engine.post({ type: 'run', id: S.runId, config: c });
  }

  function onMessage(msg) {
    if (msg.id !== S.runId) return;
    switch (msg.type) {
      case 'status':
        setBusy(true, msg.text, msg.frac);
        break;
      case 'data':
        S.data = msg.data;
        S.hist = deriveHistory(msg.data);
        break;
      case 'fit':
        S.sec[msg.sector].fit = { train: msg.train, full: msg.full };
        break;
      case 'hpcp':
        S.sec[msg.sector].hpcp = Object.assign({ L: msg.L, M: msg.M }, msg.result);
        if (msg.sector === S.active) { renderSubs(); renderMap(); renderCal(); }
        break;
      case 'long':
        S.sec[msg.sector].long = Object.assign({ final: msg.final, P: msg.P }, msg.result);
        if (msg.sector === S.active) {
          if (!msg.final) setBusy(true, `Simulating scenarios · ${msg.result.done}/${msg.P} paths`, msg.result.done / msg.P);
          renderOutlook();
          if (msg.final) renderMap();
        }
        break;
      case 'done':
        S.lastRunMs = msg.ms;
        setBusy(false, `Up to date · ${(msg.ms / 1000).toFixed(1)} s`);
        break;
      case 'error':
        setBusy(false, 'Error');
        showError(msg.message);
        console.error(msg.stack);
        break;
    }
  }

  function setBusy(busy, text, frac) {
    S.busy = busy;
    $('status').classList.toggle('busy', busy);
    $('statusText').textContent = text || '';
    const pr = $('progress');
    pr.hidden = !(busy && frac != null);
    if (frac != null) pr.firstElementChild.style.width = Math.round(frac * 100) + '%';
    document.querySelector('main').classList.toggle('updating', busy && !S.sec[S.active].long);
    if (!busy) showError(null);
  }
  function showError(m) { $('error').hidden = !m; $('error').textContent = m || ''; }

  // ------------------------------------------------------------ derived data
  function deriveHistory(D) {
    const nM = Math.round(D.Tend * 12), out = {};
    for (const name of SECTORS) {
      const { t, k } = D.sectors[name];
      const monthly = new Float64Array(nM), perCircuit = new Float64Array(D.topo.K);
      for (let i = 0; i < t.length; i++) {
        const m = Math.min(nM - 1, Math.floor(t[i] * 12));
        monthly[m]++; perCircuit[k[i]]++;
      }
      const cum = new Float64Array(nM);
      let a = 0;
      for (let m = 0; m < nM; m++) { a += monthly[m]; cum[m] = a; }
      const years = Math.ceil(D.Tend), annual = new Float64Array(years);
      for (let m = 0; m < nM; m++) annual[Math.floor(m / 12)] += monthly[m];
      let cust = 0;
      for (const c of D.topo.cust[name]) cust += c;
      out[name] = { monthly, cum, annual, perCircuit, total: t.length, cust };
    }
    return out;
  }

  function q(sorted, p) {
    const n = sorted.length;
    if (!n) return NaN;
    const h = (n - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
  }
  function bandP(conf) { return [(1 - conf) / 2, 0.5, (1 + conf) / 2]; }

  // quantiles over paths for each month (cumulative) and each year (new)
  function longSummary(name) {
    const L = S.sec[name].long, D = S.data, H = S.hist[name];
    if (!L || !L.done) return null;
    const conf = cfg.sectors[name].conf, [pl, pm, ph] = bandP(conf);
    const key = [L.done, L.final, conf, L.months].join('|');
    if (L._sum && L._sum.key === key) return L._sum;
    const P = L.done, months = L.months, col = new Float32Array(P);
    const med = new Float64Array(months), lo = new Float64Array(months), hi = new Float64Array(months);
    for (let i = 0; i < months; i++) {
      for (let p = 0; p < P; p++) col[p] = L.paths[p * months + i];
      col.sort();
      med[i] = q(col, pm); lo[i] = q(col, pl); hi[i] = q(col, ph);
    }
    // per forecast year: new installs = cum(year end) - cum(previous year end)
    const nY = Math.floor(months / 12), aMed = [], aLo = [], aHi = [];
    for (let y = 0; y < nY; y++) {
      for (let p = 0; p < P; p++) {
        const end = L.paths[p * months + (y + 1) * 12 - 1];
        const start = y === 0 ? H.total : L.paths[p * months + y * 12 - 1];
        col[p] = end - start;
      }
      col.sort();
      aMed.push(q(col, pm)); aLo.push(q(col, pl)); aHi.push(q(col, ph));
    }
    // per-circuit median at each checkpoint
    const K = D.topo.K, nC = L.checkpoints.length, cpMed = [];
    const cc = new Float32Array(P);
    for (let c = 0; c < nC; c++) {
      const arr = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        for (let p = 0; p < P; p++) cc[p] = L.cpCounts[(p * nC + c) * K + k];
        cc.sort();
        arr[k] = q(cc, 0.5);
      }
      cpMed.push(arr);
    }
    L._sum = { key, med, lo, hi, aMed, aLo, aHi, cpMed, P };
    return L._sum;
  }

  function metricFor(name) {
    const H = S.hist[name], kw = cfg.sectors[name].kw;
    switch (S.metric) {
      case 'pen': return { f: v => v / H.cust * 100, fmt: v => v.toFixed(v >= 10 ? 0 : v >= 1 ? 1 : 2) + '%', label: 'penetration (installs per customer)', unit: '%', annual: 'Penetration added per year (percentage points)' };
      case 'mw': return { f: v => v * kw / 1000, fmt: v => compact(v) + ' MW', label: 'installed capacity', unit: 'MW', annual: 'Capacity added per year' };
      case 'gwh': return { f: v => v * kw * CF * 8.76 / 1000, fmt: v => compact(v) + ' GWh', label: 'annual generation (GWh/yr)', unit: 'GWh', annual: 'Annual generation added per year' };
      default: return { f: v => v, fmt: v => compact(v), label: 'cumulative installations', unit: '', annual: 'New installations per year' };
    }
  }

  // ------------------------------------------------------------ rendering
  function renderAll() {
    if (!S.data) return;
    renderOutlook(); renderSubs(); renderMap(); renderCal();
  }


  function legend(el, items) {
    el.textContent = '';
    for (const it of items) {
      const s = document.createElement('span');
      const k = document.createElement('i');
      k.className = 'lk ' + it.cls;
      s.append(k, document.createTextNode(it.label));
      el.append(s);
    }
  }

  function renderOutlook() {
    if (!S.data) return;
    const name = S.active, D = S.data, H = S.hist[name], sc = cfg.sectors[name];
    const mt = metricFor(name), sum = longSummary(name), L = S.sec[name].long;
    const nM = H.cum.length;
    const hx = [D.T0], hy = [0];
    for (let m = 0; m < nM; m++) { hx.push(D.T0 + (m + 1) / 12); hy.push(mt.f(H.cum[m])); }
    let fc = null;
    if (sum) {
      const x = [D.T0 + D.Tend], med = [mt.f(H.total)], lo = [mt.f(H.total)], hi = [mt.f(H.total)];
      for (let i = 0; i < sum.med.length; i++) {
        x.push(D.T0 + D.Tend + (i + 1) / 12);
        med.push(mt.f(sum.med[i])); lo.push(mt.f(sum.lo[i])); hi.push(mt.f(sum.hi[i]));
      }
      fc = { x, med, lo, hi };
    }
    const capN = H.cust * sc.capPct / 100;
    Viz.fan($('fan'), {
      height: 340, x0: D.T0, x1: cfg.model.horizon, hist: { x: hx, y: hy }, fc,
      cap: mt.f(capN), capLabel: `Penetration cap ${sc.capPct.toFixed(2)}% · ${mt.fmt(mt.f(capN))}`,
      tp: sc.tp, tpLabel: `Tipping point ${ym2(sc.tp)}`, now: D.T0 + D.Tend,
      fmt: mt.fmt, bandLabel: `${pct(sc.conf)} band`, partial: L && !L.final,
    });
    legend($('fanLegend'), [
      { cls: 'line hist', label: 'Observed' },
      { cls: 'line s1', label: 'Median forecast' },
      { cls: 'box band', label: `${pct(sc.conf)} scenario band` },
    ]);

    // annual columns
    const years = [], obs = [], med = [], lo = [], hi = [];
    const firstFc = D.T0 + Math.ceil(D.Tend);
    for (let y = D.T0; y < cfg.model.horizon; y++) {
      years.push(y);
      if (y < firstFc) { obs.push(mt.f(H.annual[y - D.T0] || 0)); med.push(null); lo.push(null); hi.push(null); }
      else {
        const i = y - firstFc;
        obs.push(null);
        med.push(sum && i < sum.aMed.length ? mt.f(sum.aMed[i]) : null);
        lo.push(sum && i < sum.aLo.length ? mt.f(sum.aLo[i]) : null);
        hi.push(sum && i < sum.aHi.length ? mt.f(sum.aHi[i]) : null);
      }
    }
    $('annualTitle').textContent = mt.annual;
    Viz.columns($('annual'), { height: 180, years, obs, med, lo, hi, fmt: mt.fmt, bandLabel: `${pct(sc.conf)} band` });
  }

  function renderSubs() {
    if (!S.data) return;
    const hp = S.sec[S.active].hpcp, D = S.data;
    if (!hp || !hp.pred) { $('subs').textContent = ''; return; }
    $('subsTitle').textContent = `Next ${hp.L} months by substation`;
    const items = [];
    for (let r = 0; r < D.topo.R; r++) {
      items.push({
        id: `Substation ${D.topo.substationIds[r]}`,
        lo: hp.pred.subLo[r], hi: hp.pred.subHi[r], pt: hp.pred.subPt[r], ref: hp.lastWindowObserved[r],
        meta: `${D.topo.nr[r]} circuits`,
      });
    }
    items.sort((a, b) => b.hi - a.hi || b.pt - a.pt);
    Viz.intervals($('subs'), {
      height: 300, items, fmt: v => compact(v),
      intervalLabel: `${pct(hp.conf)} HPCP interval`, refLabel: `observed, last ${hp.L} months`,
    });
    legend($('subsLegend'), [
      { cls: 'vline s1', label: `${pct(hp.conf)} HPCP interval` },
      { cls: 'dot s1', label: `Point forecast (mean of M = ${hp.M})` },
      { cls: 'line ref', label: `Observed, last ${hp.L} months` },
    ]);
    renderRich($('subsNote'), hp.saturated
      ? 'Too few calibration windows for this confidence level, so the conformal quantile is clamped to the largest score. Move $\\tau$ earlier or lower the confidence.'
      : `Calibrated on $${hp.nWindows}$ rolling $${hp.L}$-month windows after $\\tau$. Each substation interval is the sum of its circuits' intervals.`);
  }

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function renderMap() {
    if (!S.data) return;
    const D = S.data, name = S.active, H = S.hist[name], hp = S.sec[name].hpcp, sum = longSummary(name);
    const cust = D.topo.cust[name];
    const ramp = Array.from({ length: 9 }, (_, i) => cssVar('--seq-' + i));
    let val, fmt, legendText, vmax = null;
    const mm = S.mapMetric;
    if ((mm === 'upper' || mm === 'width') && !(hp && hp.pred)) return;
    if (mm === 'pen2050' && !(sum && S.sec[name].long.final)) return;
    switch (mm) {
      case 'upper': val = k => hp.pred.hi[k]; fmt = v => compact(v); legendText = `Upper bound of next-${hp.L}-month installs per circuit`; break;
      case 'width': val = k => hp.pred.hi[k] - hp.pred.lo[k]; fmt = v => compact(v); legendText = 'Interval width (uncertainty) per circuit'; break;
      case 'pen': val = k => cust[k] > 0 ? H.perCircuit[k] / cust[k] * 100 : 0; fmt = v => v.toFixed(2) + '%'; legendText = 'Installs per customer today'; break;
      default: {
        const last = sum.cpMed[sum.cpMed.length - 1];
        val = k => cust[k] > 0 ? last[k] / cust[k] * 100 : 0; fmt = v => v.toFixed(1) + '%'; legendText = 'Median penetration by end of 2050';
      }
    }
    const circuits = [];
    let vmin = Infinity, vmx = -Infinity;
    for (let k = 0; k < D.topo.K; k++) {
      const v = val(k);
      if (v < vmin) vmin = v;
      if (v > vmx) vmx = v;
      const rows = [
        { value: fmt(v), label: $('mapMetric').selectedOptions[0].textContent.toLowerCase() },
        { value: D.topo.substationIds[D.topo.sub[k]], label: 'substation' },
        { value: fmtInt(cust[k]), label: `${name} customers` },
        { value: fmtInt(H.perCircuit[k]), label: 'installs to date' },
      ];
      if (hp && hp.pred) rows.push({ value: `${fmtInt(hp.pred.lo[k])}–${fmtInt(hp.pred.hi[k])}`, label: `next ${hp.L} months` });
      circuits.push({ x: D.topo.x[k], y: D.topo.y[k], lon: D.topo.lon[k], lat: D.topo.lat[k], v, sub: D.topo.sub[k], id: `Circuit ${D.topo.circuitIds[k]}`, rows });
    }
    if (!window.L) {
      // offline / no Leaflet: schematic SVG map with its own legend
      const subs = [];
      for (let r = 0; r < D.topo.R; r++) subs.push({ x: D.topo.sx[r], y: D.topo.sy[r], id: D.topo.substationIds[r] });
      $('map').classList.add('viz');
      Viz.map($('map'), { height: 400, circuits, subs, ramp, fmt, legend: legendText, vmax });
      $('mapLegend').textContent = '';
      return;
    }
    leafletMap(D, circuits, ramp, Math.min(0, vmin), Math.max(vmx, 1e-9));
    // legend below the map
    const lg = $('mapLegend');
    lg.textContent = '';
    const lo = document.createElement('span'); lo.textContent = fmt(Math.min(0, vmin));
    const bar = document.createElement('span'); bar.className = 'ramp';
    bar.style.background = `linear-gradient(90deg, ${ramp.join(', ')})`;
    const hi = document.createElement('span'); hi.textContent = fmt(vmx);
    const cap = document.createElement('span'); cap.className = 'cap'; cap.textContent = legendText;
    lg.append(lo, bar, hi, cap);
  }

  // Leaflet map over OpenStreetMap tiles. The map and the static layers
  // (links, substations) persist; circuit dots are redrawn on each update.
  let LM = null;
  function tipNode(title, rows) {
    const d = document.createElement('div');
    const t = document.createElement('div'); t.className = 'tip-title'; t.textContent = title; d.append(t);
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'tip-row';
      const v = document.createElement('span'); v.className = 'tip-val'; v.textContent = r.value;
      const l = document.createElement('span'); l.className = 'tip-lab'; l.textContent = r.label;
      row.append(v, l); d.append(row);
    }
    return d;
  }
  function leafletMap(D, circuits, ramp, vmin, vmax) {
    if (!LM) {
      const host = $('map');
      host.textContent = '';
      const map = L.map(host, { scrollWheelZoom: false, zoomSnap: 0.25, attributionControl: true });
      // The main OSM tile server rejects requests without a Referer, which is
      // what a page opened from disk (file://) sends; use OpenStreetMap
      // France's Humanitarian tiles there, the standard tiles over http(s).
      // A refused probe tile triggers the same switch on a served page.
      const OSM = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' };
      const HOT = { url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · tiles: <a href="https://www.hotosm.org/" target="_blank" rel="noopener">HOT</a> via <a href="https://openstreetmap.fr/" target="_blank" rel="noopener">OSM France</a>' };
      const served = /^https?:$/.test(location.protocol);
      const base = served ? OSM : HOT;
      const layer = L.tileLayer(base.url, { maxZoom: 18, subdomains: 'abc', attribution: base.attribution }).addTo(map);
      if (served) {
        fetch('https://tile.openstreetmap.org/10/267/387.png', { cache: 'no-store' }).then(r => {
          if (r.ok) return;
          map.attributionControl.removeAttribution(OSM.attribution).addAttribution(HOT.attribution);
          layer.options.attribution = HOT.attribution;
          layer.setUrl(HOT.url);
        }).catch(() => {});
      }
      map.attributionControl.setPrefix(false);
      LM = { map, links: L.layerGroup().addTo(map), dots: L.layerGroup().addTo(map), subs: L.layerGroup().addTo(map), key: null, markers: [] };
    }
    const T = D.topo;
    const key = [T.K, T.R, T.lon[0], T.lat[T.K - 1]].join('|');
    if (LM.key !== key) {
      LM.key = key;
      LM.links.clearLayers(); LM.subs.clearLayers();
      for (let k = 0; k < T.K; k++) {
        const r = T.sub[k];
        L.polyline([[T.lat[k], T.lon[k]], [T.slat[r], T.slon[r]]], { color: cssVar('--ink'), weight: 1.1, opacity: 0.55, interactive: false }).addTo(LM.links);
      }
      const tri = '<svg width="16" height="15" viewBox="-8 -9 16 15"><path d="M0,-7L6.5,4.5L-6.5,4.5Z"/></svg>';
      for (let r = 0; r < T.R; r++) {
        L.marker([T.slat[r], T.slon[r]], { icon: L.divIcon({ className: 'sub-icon', html: tri, iconSize: [16, 15], iconAnchor: [8, 9] }), keyboard: false })
          .bindTooltip(tipNode(`Substation ${T.substationIds[r]}`, [{ value: String(T.nr[r]), label: 'circuits' }]), { className: 'map-tip', direction: 'top', offset: [0, -8] })
          .addTo(LM.subs);
      }
      const pts = [];
      for (let k = 0; k < T.K; k++) pts.push([T.lat[k], T.lon[k]]);
      LM.map.fitBounds(L.latLngBounds(pts).pad(0.04));
    }
    const color = v => ramp[Math.round(Math.min(1, Math.max(0, (v - vmin) / (vmax - vmin || 1))) * (ramp.length - 1))];
    const ring = cssVar('--surface');
    LM.dots.clearLayers();
    LM.markers = circuits.map(c => {
      const mk = L.circleMarker([c.lat, c.lon], { radius: 6, color: ring, weight: 1.5, fillColor: color(c.v), fillOpacity: 0.95 });
      mk.bindTooltip(tipNode(c.id, c.rows), { className: 'map-tip', direction: 'top', offset: [0, -6] });
      mk.on('mouseover', () => LM.markers.forEach((m, i) => m.setStyle({ fillOpacity: circuits[i].sub === c.sub ? 0.95 : 0.18, opacity: circuits[i].sub === c.sub ? 1 : 0.3 })));
      mk.on('mouseout', () => LM.markers.forEach(m => m.setStyle({ fillOpacity: 0.95, opacity: 1 })));
      return mk.addTo(LM.dots);
    });
    LM.map.invalidateSize();
  }

  // HPCP in Carnegie Red; the ablations stay neutral and are identified by direct labels
  const METHOD_CLS = { HPCP: 'c1', Marginal: 'cn', Joint: 'cn', Bonferroni: 'cn' };
  function renderCal() {
    const hp = S.sec[S.active].hpcp;
    if (!hp || !readmeOpen()) return;
    if (hp.error) { $('calSub').textContent = hp.error; $('covC').textContent = ''; $('covS').textContent = ''; $('calTable').textContent = ''; return; }
    renderRich($('calSub'), `Intervals built from $${hp.nCal}$ calibration windows, then checked on the next $${hp.nTest}$ held-out windows.`);
    const pts = key => hp.metrics.map(m => ({ label: m.method, cov: m[key + 'Coverage'], width: m[key + 'Width'], cls: METHOD_CLS[m.method] }));
    Viz.coverage($('covC'), { height: 230, title: 'Circuit level', points: pts('circuit'), target: hp.conf });
    Viz.coverage($('covS'), { height: 230, title: 'Substation level', points: pts('substation'), target: hp.conf });
    const t = $('calTable');
    t.textContent = '';
    const head = t.createTHead().insertRow();
    for (const h of ['Method', 'Circuit coverage', 'Substation coverage', 'Circuit width', 'Substation width']) {
      const th = document.createElement('th'); th.textContent = h; head.append(th);
    }
    const body = t.createTBody();
    for (const m of hp.metrics) {
      const r = body.insertRow();
      const c0 = r.insertCell();
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = m.method === 'HPCP' ? 'var(--s1)' : 'var(--neutral)';
      c0.append(sw, document.createTextNode(m.method));
      for (const [v, ok] of [[m.circuitCoverage, m.circuitCoverage >= hp.conf], [m.substationCoverage, m.substationCoverage >= hp.conf]]) {
        const c = r.insertCell(); texNum(c.appendChild(document.createElement('span')), pct(v, 1));
        if (!ok) { const f = document.createElement('span'); f.className = 'flag'; f.textContent = '▼ below target'; c.append(f); }
      }
      texNum(r.insertCell(), m.circuitWidth.toFixed(2));
      texNum(r.insertCell(), m.substationWidth.toFixed(2));
    }
    const yrs = (hp.nTest + hp.L - 1) / 12;
    renderRich($('calNote'), 'HPCP targets valid coverage at both levels with narrower intervals than Joint or Bonferroni. Marginal is narrowest but can under-cover substations. ' +
      `The $${hp.nTest}$ held-out windows overlap and span only about $${yrs.toFixed(1)}$ years, so these checks are noisy. ` +
      `The network-total interval covered $${pct(hp.sysCov).replace('%', '\\%')}$ of them.` +
      (hp.hl ? ` Recency weighting leaves an effective $${hp.ess.toFixed(0)}$ of $${hp.nWindows}$ calibration windows.` : ''));
  }


  // ------------------------------------------------------------ upload
  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function findCol(header, names) {
    const h = header.map(x => x.trim().toLowerCase());
    for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; }
    return -1;
  }
  const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); });

  async function loadUpload() {
    const fRec = $('fileRecords').files[0];
    const msg = $('uploadMsg');
    if (!fRec) return;
    try {
      const rec = parseCSV(await readFile(fRec));
      const hd = rec.shift();
      const ci = { date: findCol(hd, ['date', 'install_date', 'installation_date', 'application_date', 'time', 'timestamp']),
        circuit: findCol(hd, ['circuit_id', 'circuit', 'feeder', 'feeder_id']),
        sub: findCol(hd, ['substation_id', 'substation']),
        sector: findCol(hd, ['sector', 'customer_class', 'class', 'type']) };
      if (ci.date < 0 || ci.circuit < 0) throw new Error('Records need at least a date column and a circuit_id column.');
      const fTopo = $('fileTopo').files[0];
      const circ = new Map(), subs = new Map(), circSub = [], custR = [], custC = [], lon = [], lat = [];
      const addSub = id => { if (!subs.has(id)) subs.set(id, subs.size); return subs.get(id); };
      const addCirc = (id, sid) => {
        if (!circ.has(id)) { circ.set(id, circ.size); circSub.push(addSub(sid || 'S-' + id)); custR.push(NaN); custC.push(NaN); lon.push(NaN); lat.push(NaN); }
        return circ.get(id);
      };
      if (fTopo) {
        const tp = parseCSV(await readFile(fTopo));
        const th = tp.shift();
        const ti = { c: findCol(th, ['circuit_id', 'circuit', 'feeder']), s: findCol(th, ['substation_id', 'substation']),
          r: findCol(th, ['residential_customers', 'residential', 'res_customers']), m: findCol(th, ['commercial_customers', 'commercial', 'com_customers']),
          x: findCol(th, ['lon', 'longitude', 'x']), y: findCol(th, ['lat', 'latitude', 'y']) };
        if (ti.c < 0 || ti.s < 0) throw new Error('Topology needs circuit_id and substation_id columns.');
        for (const row of tp) {
          const k = addCirc(row[ti.c].trim(), row[ti.s].trim());
          if (ti.r >= 0) custR[k] = +row[ti.r];
          if (ti.m >= 0) custC[k] = +row[ti.m];
          if (ti.x >= 0) lon[k] = +row[ti.x];
          if (ti.y >= 0) lat[k] = +row[ti.y];
        }
      }
      const evs = [];
      let minY = Infinity, maxT = -Infinity;
      for (const row of rec) {
        const d = new Date(row[ci.date].trim());
        if (isNaN(d)) continue;
        const k = addCirc(row[ci.circuit].trim(), ci.sub >= 0 ? row[ci.sub].trim() : null);
        const sec = ci.sector >= 0 && /com|bus|non/i.test(row[ci.sector]) ? 'commercial' : 'residential';
        const y = d.getUTCFullYear(), mo = d.getUTCMonth(), dd = d.getUTCDate(), dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        evs.push({ y, mo, frac: (dd - 1) / dim, k, sec });
        minY = Math.min(minY, y);
      }
      if (!evs.length) throw new Error('No parsable dates found.');
      const T0 = minY;
      for (const e of evs) { e.t = (e.y - T0) + (e.mo + e.frac) / 12; maxT = Math.max(maxT, e.t); }
      evs.sort((a, b) => a.t - b.t);
      const Tend = Math.floor(maxT * 12 + 1) / 12;
      const K = circ.size, R = subs.size, total = Math.max(1, +$('custTotal').value || 568894);
      for (let k = 0; k < K; k++) {
        if (!(custR[k] >= 0)) custR[k] = Math.round(total * 0.9 / K);
        if (!(custC[k] >= 0)) custC[k] = Math.round(total * 0.1 / K);
      }
      // coordinates: normalise given lon/lat, else a deterministic layout
      const x = new Array(K), y = new Array(K), sx = new Array(R).fill(0), sy = new Array(R).fill(0), sn = new Array(R).fill(0);
      const have = lon.every(v => isFinite(v)) && lat.every(v => isFinite(v));
      if (have) {
        const x0 = Math.min(...lon), x1 = Math.max(...lon), y0 = Math.min(...lat), y1 = Math.max(...lat);
        const span = Math.max(x1 - x0, y1 - y0) || 1;
        for (let k = 0; k < K; k++) { x[k] = 0.04 + 0.92 * (lon[k] - x0) / span; y[k] = 0.04 + 0.92 * (lat[k] - y0) / span; }
      } else {
        const cols = Math.ceil(Math.sqrt(R * 1.25)), rows = Math.ceil(R / cols);
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        const gx = r => (r % cols + 0.5) / cols, gy = r => (Math.floor(r / cols) + 0.5) / rows;
        for (let k = 0; k < K; k++) { const r = circSub[k], a = rnd() * 6.283, d = (0.15 + 0.3 * rnd()) / cols; x[k] = gx(r) + d * Math.cos(a); y[k] = gy(r) + d * Math.sin(a); }
      }
      for (let k = 0; k < K; k++) { sx[circSub[k]] += x[k]; sy[circSub[k]] += y[k]; sn[circSub[k]]++; }
      for (let r = 0; r < R; r++) { sx[r] /= sn[r] || 1; sy[r] /= sn[r] || 1; }
      // geographic coordinates: real lon/lat when given, else the schematic layout over Indianapolis
      const glon = have ? lon.slice() : x.map(v => BOX.lon0 + v * (BOX.lon1 - BOX.lon0));
      const glat = have ? lat.slice() : y.map(v => BOX.lat0 + v * (BOX.lat1 - BOX.lat0));
      const slon = new Array(R).fill(0), slat = new Array(R).fill(0);
      for (let k = 0; k < K; k++) { slon[circSub[k]] += glon[k] / (sn[circSub[k]] || 1); slat[circSub[k]] += glat[k] / (sn[circSub[k]] || 1); }
      const sectors = { residential: { t: [], k: [] }, commercial: { t: [], k: [] } };
      for (const e of evs) { sectors[e.sec].t.push(e.t); sectors[e.sec].k.push(e.k); }
      cfg.data.upload = {
        key: [fRec.name, fRec.size, fRec.lastModified, fTopo ? fTopo.name + fTopo.size : '', total].join('|'),
        T0, Tend,
        topo: { sub: circSub, circuitIds: [...circ.keys()], substationIds: [...subs.keys()], x, y, sx, sy, lon: glon, lat: glat, slon, slat, cust: { residential: custR, commercial: custC } },
        sectors,
      };
      msg.textContent = `Loaded ${fmtInt(evs.length)} records on ${K} circuits / ${R} substations (${T0}–${T0 + Math.ceil(Tend) - 1}).`;
      if (cfg.model.tau <= T0 + 1 || cfg.model.tau >= T0 + Tend - 1) cfg.model.tau = T0 + Math.max(1, Math.round(Tend * 0.6));
      syncControls();
      setSource('upload');
    } catch (e) {
      msg.textContent = 'Could not read file: ' + e.message;
    }
  }

  // ------------------------------------------------------------ export
  function download(name, rows) {
    const esc = v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const blob = new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function dateOf(t, T0) {
    const m = Math.floor(t * 12), y = T0 + Math.floor(m / 12), mo = m % 12;
    const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const d = Math.min(dim, 1 + Math.floor((t * 12 - m) * dim));
    return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function exportCSV(kind) {
    const D = S.data;
    if (!D) return;
    const name = S.active, tag = `${name}_${D.synthetic ? 'synthetic_seed' + cfg.data.gen.seed : 'upload'}`;
    if (kind === 'records') {
      const rows = [['date', 'circuit_id', 'substation_id', 'sector']];
      const all = [];
      for (const sname of SECTORS) { const s = D.sectors[sname]; for (let i = 0; i < s.t.length; i++) all.push([s.t[i], s.k[i], sname]); }
      all.sort((a, b) => a[0] - b[0]);
      for (const [t, k, sname] of all) rows.push([dateOf(t, D.T0), D.topo.circuitIds[k], D.topo.substationIds[D.topo.sub[k]], sname]);
      download(`records_${D.synthetic ? 'synthetic_seed' + cfg.data.gen.seed : 'upload'}.csv`, rows);
      const topo = [['circuit_id', 'substation_id', 'residential_customers', 'commercial_customers', 'x', 'y']];
      for (let k = 0; k < D.topo.K; k++) topo.push([D.topo.circuitIds[k], D.topo.substationIds[D.topo.sub[k]], D.topo.cust.residential[k], D.topo.cust.commercial[k], D.topo.x[k].toFixed(4), D.topo.y[k].toFixed(4)]);
      setTimeout(() => download(`topology_${D.synthetic ? 'synthetic_seed' + cfg.data.gen.seed : 'upload'}.csv`, topo), 300);
    } else if (kind === 'forecast') {
      const sum = longSummary(name), H = S.hist[name], sc = cfg.sectors[name];
      if (!sum) return;
      const [pl, , ph] = bandP(sc.conf);
      const rows = [['month', 'kind', 'cumulative_installs_median', `p${Math.round(pl * 1000) / 10}`, `p${Math.round(ph * 1000) / 10}`, 'penetration_median_pct', 'capacity_median_mw']];
      for (let m = 0; m < H.cum.length; m++) rows.push([ym(D.T0 + (m + 1) / 12), 'observed', H.cum[m], '', '', (H.cum[m] / H.cust * 100).toFixed(4), (H.cum[m] * sc.kw / 1000).toFixed(3)]);
      for (let i = 0; i < sum.med.length; i++) rows.push([ym(D.T0 + D.Tend + (i + 1) / 12), 'forecast', sum.med[i], sum.lo[i], sum.hi[i], (sum.med[i] / H.cust * 100).toFixed(4), (sum.med[i] * sc.kw / 1000).toFixed(3)]);
      download(`forecast_${tag}_cap${sc.capPct}_tp${ym2(sc.tp)}_conf${Math.round(sc.conf * 100)}.csv`, rows);
    } else {
      const hp = S.sec[name].hpcp;
      if (!hp || !hp.pred) return;
      const rows = [['circuit_id', 'substation_id', 'lower', 'point', 'upper', 'level']];
      for (let k = 0; k < D.topo.K; k++) rows.push([D.topo.circuitIds[k], D.topo.substationIds[D.topo.sub[k]], hp.pred.lo[k], hp.pred.pt[k].toFixed(2), hp.pred.hi[k], 'circuit']);
      for (let r = 0; r < D.topo.R; r++) rows.push(['', D.topo.substationIds[r], hp.pred.subLo[r], hp.pred.subPt[r].toFixed(2), hp.pred.subHi[r], 'substation']);
      download(`hpcp_next${hp.L}m_${tag}_conf${Math.round(hp.conf * 100)}.csv`, rows);
    }
  }

  // ------------------------------------------------------------ theme
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }
  function toggleTheme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('hpcp-theme', next); } catch (e) { /* storage unavailable */ }
    if (LM) LM.key = null; // rebuild links in the new theme colours
    renderMap();
  }

  // ------------------------------------------------------------ boot
  try { applyTheme(localStorage.getItem('hpcp-theme')); } catch (e) { /* storage unavailable */ }
  buildControls();
  initHelp();
  initResizer();
  let sidePref = '1', sideW = 300;
  try { sidePref = localStorage.getItem('hpcp-side') || '1'; sideW = +localStorage.getItem('hpcp-side-w') || 300; } catch (e) { /* storage unavailable */ }
  setSideWidth(sideW);
  // on narrow screens the panel stacks above the dashboard and is always shown
  const narrow = matchMedia('(max-width: 900px)');
  setSide(sidePref !== '0' || narrow.matches, false);
  narrow.addEventListener('change', () => { if (narrow.matches) setSide(true, false); });
  setReadme(false);
  renderMathIn($('readme'));
  // citation buttons: APA text (whitespace collapsed) or the BibTeX block verbatim
  document.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
    const src = $(btn.dataset.copy);
    const text = src.tagName === 'PRE' ? src.textContent.trim() : src.textContent.replace(/\s+/g, ' ').trim();
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = btn.dataset.label; }, 1600);
  }));
  syncControls();
  engine = makeEngine();
  let rz = null, lastW = 0;
  new ResizeObserver(entries => {
    const w = Math.round(entries[0].contentRect.width);
    if (w === lastW) return;
    lastW = w;
    clearTimeout(rz);
    rz = setTimeout(renderAll, 120);
  }).observe(document.querySelector('main'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (LM) LM.key = null; renderMap(); });
  postRun();
})();
