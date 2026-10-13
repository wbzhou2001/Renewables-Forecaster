/*
 * Small dependency-free SVG chart kit for the portal.
 * Every chart: hairline grid, 2px lines, >=8px markers with a surface ring,
 * hover layer (crosshair or per-mark), tooltip built with textContent.
 * Colours come from CSS custom properties so light/dark themes just work.
 */
const Viz = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  function s(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceTicks(min, max, n = 5) {
    if (!(max > min)) max = min + 1;
    const raw = (max - min) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), err = raw / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const t = niceTicks(0, v, 5);
    return t[t.length - 1] < v ? t[t.length - 1] + (t[1] - t[0]) : t[t.length - 1];
  }

  function compact(v, digits) {
    if (v == null || !isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(0) + 'K';
    if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    if (digits != null) return v.toFixed(digits);
    if (a >= 100 || Number.isInteger(v)) return Math.round(v).toString();
    return v.toFixed(a >= 10 ? 1 : 2);
  }
  const fmtInt = v => (v == null || !isFinite(v)) ? '–' : Math.round(v).toLocaleString('en-US');
  const ym = x => { const m = Math.round(x * 12 - 1); const y = Math.floor(m / 12); return `${y}-${String(m - y * 12 + 1).padStart(2, '0')}`; };

  // container setup: clears, returns svg + tooltip
  function frame(el, height) {
    el.textContent = '';
    el.classList.add('viz');
    const W = Math.max(280, Math.floor(el.clientWidth || el.getBoundingClientRect().width || 600));
    const svg = s('svg', { width: W, height, viewBox: `0 0 ${W} ${height}`, role: 'img' }, el);
    const tip = h('div', 'viz-tip', el);
    tip.hidden = true;
    return { svg, tip, W, H: height };
  }

  function showTip(tip, el, px, py, title, rows) {
    tip.textContent = '';
    if (title) h('div', 'tip-title', tip, title);
    for (const r of rows) {
      const row = h('div', 'tip-row', tip);
      if (r.key) h('span', 'tip-key ' + r.key, row);
      h('span', 'tip-val', row, r.value);
      h('span', 'tip-lab', row, r.label);
    }
    tip.hidden = false;
    const bw = el.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = px + 14, y = py - th - 10;
    if (x + tw > bw - 4) x = px - tw - 14;
    if (x < 4) x = 4;
    if (y < 4) y = py + 16;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function yAxis(g, ticks, y, x0, x1, fmt) {
    for (const t of ticks) {
      s('line', { x1: x0, x2: x1, y1: y(t), y2: y(t), class: t === 0 ? 'axis-base' : 'grid' }, g);
      const tx = s('text', { x: x0 - 8, y: y(t), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, g);
      tx.textContent = fmt(t);
    }
  }

  function pathFrom(xs, ys, x, y) {
    let d = '';
    for (let i = 0; i < xs.length; i++) d += (i ? 'L' : 'M') + x(xs[i]).toFixed(1) + ',' + y(ys[i]).toFixed(1);
    return d;
  }

  /*
   * Fan chart: observed history + forecast median + central band.
   * spec: { height, x0, x1, hist:{x,y}, fc:{x,med,lo,hi}|null, cap, capLabel,
   *         tp, tpLabel, now, fmt, bandLabel, partial }
   */
  function fan(el, spec) {
    const { svg, tip, W, H } = frame(el, spec.height || 340);
    const m = { l: 56, r: 18, t: 18, b: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    let ymax = 0;
    for (const v of spec.hist.y) ymax = Math.max(ymax, v);
    if (spec.fc) for (const v of spec.fc.hi) ymax = Math.max(ymax, v);
    if (spec.cap != null && isFinite(spec.cap)) ymax = Math.max(ymax, spec.cap * 1.04);
    ymax = niceMax(ymax);
    const x = v => m.l + (v - spec.x0) / (spec.x1 - spec.x0) * iw;
    const y = v => m.t + ih - v / ymax * ih;
    const g = s('g', null, svg);
    yAxis(g, niceTicks(0, ymax, 5), y, m.l, m.l + iw, spec.fmt);
    for (let yr = Math.ceil(spec.x0 / 5) * 5; yr <= spec.x1; yr += 5) {
      const tx = s('text', { x: x(yr), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, g);
      tx.textContent = yr;
      s('line', { x1: x(yr), x2: x(yr), y1: m.t + ih, y2: m.t + ih + 4, class: 'axis-base' }, g);
    }
    // forecast region wash + "now" divider
    // reference labels sit along the bottom edge (data stays low there early
    // on); the cap label goes above its line, or below it when near the top
    if (spec.now != null) {
      s('rect', { x: x(spec.now), y: m.t, width: Math.max(0, m.l + iw - x(spec.now)), height: ih, class: 'fc-wash' }, g);
      s('line', { x1: x(spec.now), x2: x(spec.now), y1: m.t, y2: m.t + ih, class: 'ref-line' }, g);
      const t = s('text', { x: x(spec.now) + 10, y: m.t + ih - 6, class: 'ref-label' }, g);
      t.textContent = 'Forecast →';
    }
    if (spec.cap != null && isFinite(spec.cap)) {
      s('line', { x1: m.l, x2: m.l + iw, y1: y(spec.cap), y2: y(spec.cap), class: 'ref-line strong' }, g);
      const above = y(spec.cap) - m.t > 18;
      const t = s('text', { x: m.l + 6, y: y(spec.cap) + (above ? -6 : 14), class: 'ref-label' }, g);
      t.textContent = spec.capLabel || 'Cap';
    }
    if (spec.tp != null && spec.tp > spec.x0 && spec.tp < spec.x1) {
      s('line', { x1: x(spec.tp), x2: x(spec.tp), y1: m.t, y2: m.t + ih, class: 'ref-line strong' }, g);
      const right = x(spec.tp) < m.l + iw - 150;
      const crowded = spec.now != null && Math.abs(x(spec.tp) - x(spec.now)) < 90;
      const t = s('text', { x: x(spec.tp) + (right ? 6 : -6), y: m.t + ih - (crowded ? 24 : 8), class: 'ref-label', 'text-anchor': right ? 'start' : 'end' }, g);
      t.textContent = spec.tpLabel || 'Tipping point';
    }
    if (spec.fc && spec.fc.x.length) {
      const f = spec.fc;
      let d = pathFrom(f.x, f.hi, x, y);
      for (let i = f.x.length - 1; i >= 0; i--) d += 'L' + x(f.x[i]).toFixed(1) + ',' + y(f.lo[i]).toFixed(1);
      s('path', { d: d + 'Z', class: 'band' + (spec.partial ? ' partial' : '') }, g);
      s('path', { d: pathFrom(f.x, f.med, x, y), class: 'line s1' }, g);
    }
    s('path', { d: pathFrom(spec.hist.x, spec.hist.y, x, y), class: 'line hist' }, g);
    const n = spec.hist.x.length;
    if (n) s('circle', { cx: x(spec.hist.x[n - 1]), cy: y(spec.hist.y[n - 1]), r: 4, class: 'dot hist' }, g);
    if (spec.fc && spec.fc.x.length) {
      const L = spec.fc.x.length - 1;
      s('circle', { cx: x(spec.fc.x[L]), cy: y(spec.fc.med[L]), r: 4, class: 'dot s1' }, g);
      const lab = s('text', { x: x(spec.fc.x[L]) - 8, y: y(spec.fc.med[L]) - 10, class: 'end-label', 'text-anchor': 'end' }, g);
      lab.textContent = spec.fmt(spec.fc.med[L]);
    }

    // hover layer
    const cross = s('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' }, svg);
    const dA = s('circle', { r: 4, class: 'dot hist', visibility: 'hidden' }, svg);
    const dB = s('circle', { r: 4, class: 'dot s1', visibility: 'hidden' }, svg);
    const hit = s('rect', { x: m.l, y: m.t, width: iw, height: ih, class: 'hit', tabindex: 0 }, svg);
    const hx = spec.hist.x, fx = spec.fc ? spec.fc.x : [];
    const nearest = (arr, v) => {
      let lo = 0, hi = arr.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
      if (lo > 0 && Math.abs(arr[lo - 1] - v) < Math.abs(arr[lo] - v)) lo--;
      return lo;
    };
    const move = (px, py) => {
      const v = spec.x0 + (px - m.l) / iw * (spec.x1 - spec.x0);
      const rows = [];
      let xv;
      if (fx.length && v > (hx.length ? hx[hx.length - 1] : -Infinity)) {
        const i = nearest(fx, v); xv = fx[i];
        dB.setAttribute('cx', x(xv)); dB.setAttribute('cy', y(spec.fc.med[i])); dB.setAttribute('visibility', 'visible');
        dA.setAttribute('visibility', 'hidden');
        rows.push({ key: 'k-s1', value: spec.fmt(spec.fc.med[i]), label: 'median forecast' });
        rows.push({ key: 'k-band', value: spec.fmt(spec.fc.lo[i]) + ' – ' + spec.fmt(spec.fc.hi[i]), label: spec.bandLabel || 'band' });
      } else if (hx.length) {
        const i = nearest(hx, v); xv = hx[i];
        dA.setAttribute('cx', x(xv)); dA.setAttribute('cy', y(spec.hist.y[i])); dA.setAttribute('visibility', 'visible');
        dB.setAttribute('visibility', 'hidden');
        rows.push({ key: 'k-hist', value: spec.fmt(spec.hist.y[i]), label: 'observed' });
      } else return;
      cross.setAttribute('x1', x(xv)); cross.setAttribute('x2', x(xv)); cross.setAttribute('visibility', 'visible');
      showTip(tip, el, x(xv), py, ym(xv), rows);
    };
    hit.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(); move(e.clientX - r.left, e.clientY - r.top); });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dA.setAttribute('visibility', 'hidden'); dB.setAttribute('visibility', 'hidden'); });
    hit.addEventListener('focus', () => move(m.l + iw * 0.98, m.t + 20));
    hit.addEventListener('blur', () => { tip.hidden = true; });
  }

  /*
   * Annual columns: observed (neutral) then forecast median (accent) with a
   * whisker for the band.  spec: { height, years, obs:[]|null per year, med, lo, hi, fmt, bandLabel }
   */
  function columns(el, spec) {
    const { svg, tip, W, H } = frame(el, spec.height || 200);
    const m = { l: 56, r: 18, t: 14, b: 26 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const n = spec.years.length;
    let ymax = 0;
    for (let i = 0; i < n; i++) ymax = Math.max(ymax, spec.obs[i] || 0, spec.hi[i] || 0);
    ymax = niceMax(ymax);
    const band = iw / n, bw = Math.min(24, Math.max(3, band - 2));
    const x = i => m.l + i * band + (band - bw) / 2;
    const y = v => m.t + ih - v / ymax * ih;
    const g = s('g', null, svg);
    yAxis(g, niceTicks(0, ymax, 4), y, m.l, m.l + iw, spec.fmt);
    const r = Math.min(4, bw / 2);
    const colPath = (x0, w, y0, yb) => {
      const hgt = yb - y0;
      if (hgt <= 0.5) return '';
      const rr = Math.min(r, hgt);
      return `M${x0},${yb}V${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}H${x0 + w - rr}Q${x0 + w},${y0} ${x0 + w},${y0 + rr}V${yb}Z`;
    };
    for (let i = 0; i < n; i++) {
      const isObs = spec.obs[i] != null;
      const v = isObs ? spec.obs[i] : spec.med[i];
      if (v == null) continue;
      s('path', { d: colPath(x(i), bw, y(v), y(0)), class: isObs ? 'col hist' : 'col s1' }, g);
      if (!isObs && spec.lo[i] != null) {
        const cx = x(i) + bw / 2;
        s('line', { x1: cx, x2: cx, y1: y(spec.lo[i]), y2: y(spec.hi[i]), class: 'whisker' }, g);
        s('line', { x1: cx - Math.min(4, bw / 2), x2: cx + Math.min(4, bw / 2), y1: y(spec.hi[i]), y2: y(spec.hi[i]), class: 'whisker' }, g);
        s('line', { x1: cx - Math.min(4, bw / 2), x2: cx + Math.min(4, bw / 2), y1: y(spec.lo[i]), y2: y(spec.lo[i]), class: 'whisker' }, g);
      }
      if (spec.years[i] % 5 === 0) {
        const t = s('text', { x: x(i) + bw / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, g);
        t.textContent = spec.years[i];
      }
    }
    // per-column hover targets
    for (let i = 0; i < n; i++) {
      const hit = s('rect', { x: m.l + i * band, y: m.t, width: band, height: ih, class: 'hit', tabindex: -1 }, svg);
      const show = () => {
        const isObs = spec.obs[i] != null;
        const rows = isObs
          ? [{ key: 'k-hist', value: spec.fmt(spec.obs[i]), label: 'observed new installs' }]
          : [{ key: 'k-s1', value: spec.fmt(spec.med[i]), label: 'median new installs' },
             { key: 'k-band', value: spec.fmt(spec.lo[i]) + ' – ' + spec.fmt(spec.hi[i]), label: spec.bandLabel || 'band' }];
        hit.classList.add('on');
        showTip(tip, el, x(i) + bw / 2, y(isObs ? spec.obs[i] : spec.hi[i] || 0), String(spec.years[i]), rows);
      };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointerleave', () => { tip.hidden = true; hit.classList.remove('on'); });
    }
  }

  /*
   * Interval chart over categories (substations): whisker lo–hi, dot at the
   * point forecast, short tick at a reference value (last observed window).
   * spec: { height, items:[{id, lo, hi, pt, ref, meta}], fmt, refLabel }
   */
  function intervals(el, spec) {
    const { svg, tip, W, H } = frame(el, spec.height || 300);
    const m = { l: 48, r: 12, t: 14, b: spec.xLabel ? 30 : 10 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const items = spec.items, n = items.length;
    let ymax = 0;
    for (const it of items) ymax = Math.max(ymax, it.hi, it.ref || 0);
    ymax = niceMax(ymax);
    const band = iw / Math.max(1, n);
    const x = i => m.l + (i + 0.5) * band;
    const y = v => m.t + ih - v / ymax * ih;
    const g = s('g', null, svg);
    yAxis(g, niceTicks(0, ymax, 5), y, m.l, m.l + iw, spec.fmt);
    if (spec.xLabel) {
      const lab = s('text', { x: m.l + iw / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, g);
      lab.textContent = spec.xLabel;
    }
    const tw = Math.min(5, band * 0.35);
    items.forEach((it, i) => {
      s('line', { x1: x(i), x2: x(i), y1: y(it.lo), y2: y(it.hi), class: 'whisker s1' }, g);
      if (it.ref != null) s('line', { x1: x(i) - tw, x2: x(i) + tw, y1: y(it.ref), y2: y(it.ref), class: 'ref-tick' }, g);
      s('circle', { cx: x(i), cy: y(it.pt), r: Math.min(4, Math.max(2.5, band * 0.3)), class: 'dot s1' }, g);
    });
    const hl = s('rect', { y: m.t, height: ih, width: band, class: 'hover-col', visibility: 'hidden' }, svg);
    svg.insertBefore(hl, svg.firstChild);
    const hit = s('rect', { x: m.l, y: m.t, width: iw, height: ih, class: 'hit' }, svg);
    hit.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect();
      const i = clampI(Math.floor((e.clientX - r.left - m.l) / band), 0, n - 1);
      const it = items[i];
      hl.setAttribute('x', m.l + i * band); hl.setAttribute('visibility', 'visible');
      const rows = [
        { key: 'k-s1', value: spec.fmt(it.lo) + ' – ' + spec.fmt(it.hi), label: spec.intervalLabel || 'interval' },
        { key: 'k-dot', value: spec.fmt(it.pt), label: 'point forecast' },
      ];
      if (it.ref != null) rows.push({ key: 'k-ref', value: spec.fmt(it.ref), label: spec.refLabel || 'reference' });
      if (it.meta) rows.push({ value: it.meta, label: '' });
      showTip(tip, el, x(i), y(it.hi), it.id, rows);
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); });
  }
  const clampI = (v, a, b) => v < a ? a : v > b ? b : v;

  /*
   * Map: circuits coloured on a sequential ramp, hairlines to their
   * substation, substations as hollow triangles. Nearest-point hover.
   * spec: { height, circuits:[{x,y,v,sub,id,rows}], subs:[{x,y,id}], fmt, legend, ramp:[css colors] }
   */
  function map(el, spec) {
    const { svg, tip, W, H } = frame(el, spec.height || 360);
    const pad = 14, legendH = 34;
    const side = Math.min(W - 2 * pad, H - 2 * pad - legendH);
    const ox = (W - side) / 2, oy = pad;
    const X = v => ox + v * side, Y = v => oy + (1 - v) * side;
    s('rect', { x: ox, y: oy, width: side, height: side, rx: 10, class: 'map-bg' }, svg);
    const vals = spec.circuits.map(c => c.v).filter(v => isFinite(v));
    const vmin = spec.vmin != null ? spec.vmin : 0;
    const vmax = Math.max(vmin + 1e-9, spec.vmax != null ? spec.vmax : Math.max(...vals, vmin + 1e-9));
    const ramp = spec.ramp;
    const color = v => {
      const tt = clampI((v - vmin) / (vmax - vmin), 0, 1) * (ramp.length - 1);
      return ramp[Math.round(tt)];
    };
    const g = s('g', null, svg);
    for (const c of spec.circuits) {
      const sb = spec.subs[c.sub];
      s('line', { x1: X(c.x), y1: Y(c.y), x2: X(sb.x), y2: Y(sb.y), class: 'map-link' }, g);
    }
    const dots = spec.circuits.map(c => s('circle', { cx: X(c.x), cy: Y(c.y), r: 5, fill: color(c.v), class: 'map-dot' }, g));
    for (const sb of spec.subs) {
      const cx = X(sb.x), cy = Y(sb.y), r = 6;
      s('path', { d: `M${cx},${cy - r}L${cx + r * 0.87},${cy + r * 0.5}L${cx - r * 0.87},${cy + r * 0.5}Z`, class: 'map-sub' }, g);
    }
    // legend: gradient + ticks
    const lg = s('g', null, svg);
    const lw = Math.min(260, side * 0.7), lx = (W - lw) / 2, ly = oy + side + 12;
    const gid = 'grad' + Math.random().toString(36).slice(2, 8);
    const defs = s('defs', null, svg);
    const grad = s('linearGradient', { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
    ramp.forEach((c, i) => s('stop', { offset: (i / (ramp.length - 1) * 100) + '%', 'stop-color': c }, grad));
    s('rect', { x: lx, y: ly, width: lw, height: 8, rx: 4, fill: `url(#${gid})` }, lg);
    const t0 = s('text', { x: lx - 6, y: ly + 7, class: 'tick', 'text-anchor': 'end' }, lg); t0.textContent = spec.fmt(vmin);
    const t1 = s('text', { x: lx + lw + 6, y: ly + 7, class: 'tick' }, lg); t1.textContent = spec.fmt(vmax);
    const tl = s('text', { x: W / 2, y: ly + 24, class: 'tick', 'text-anchor': 'middle' }, lg); tl.textContent = spec.legend || '';

    const ring = s('circle', { r: 8, class: 'map-ring', visibility: 'hidden' }, svg);
    const hit = s('rect', { x: ox, y: oy, width: side, height: side, class: 'hit' }, svg);
    hit.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      let best = -1, bd = Infinity;
      spec.circuits.forEach((c, i) => { const d = (X(c.x) - px) ** 2 + (Y(c.y) - py) ** 2; if (d < bd) { bd = d; best = i; } });
      if (best < 0 || bd > 30 * 30) { tip.hidden = true; ring.setAttribute('visibility', 'hidden'); dots.forEach(d => d.classList.remove('dim')); return; }
      const c = spec.circuits[best];
      ring.setAttribute('cx', X(c.x)); ring.setAttribute('cy', Y(c.y)); ring.setAttribute('visibility', 'visible');
      dots.forEach((d, i) => d.classList.toggle('dim', spec.circuits[i].sub !== c.sub));
      showTip(tip, el, X(c.x), Y(c.y), c.id, c.rows);
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; ring.setAttribute('visibility', 'hidden'); dots.forEach(d => d.classList.remove('dim')); });
  }

  /*
   * Coverage vs width scatter (one panel). x = coverage %, y = mean width.
   * spec: { height, title, points:[{label, cov, width, cls}], target }
   */
  function coverage(el, spec) {
    const { svg, tip, W, H } = frame(el, spec.height || 230);
    const m = { l: 46, r: 16, t: 26, b: 34 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const lowest = Math.min(spec.target, ...spec.points.map(p => p.cov)) * 100;
    const xmin = Math.max(0, Math.min(Math.floor(lowest / 5) * 5 - 5, 80));
    const x = v => m.l + (v - xmin) / (100 - xmin) * iw;
    const ymax = niceMax(Math.max(...spec.points.map(p => p.width)) * 1.1);
    const y = v => m.t + ih - v / ymax * ih;
    const g = s('g', null, svg);
    const ttl = s('text', { x: m.l, y: 14, class: 'panel-title' }, g); ttl.textContent = spec.title;
    s('rect', { x: m.l, y: m.t, width: Math.max(0, x(spec.target * 100) - m.l), height: ih, class: 'fail-wash' }, g);
    yAxis(g, niceTicks(0, ymax, 4), y, m.l, m.l + iw, v => compact(v));
    for (const t of niceTicks(xmin, 100, 3)) {
      const tx = s('text', { x: x(t), y: H - 16, class: 'tick', 'text-anchor': 'middle' }, g); tx.textContent = t + '%';
    }
    const xl = s('text', { x: m.l + iw / 2, y: H - 2, class: 'tick', 'text-anchor': 'middle' }, g); xl.textContent = 'Empirical coverage on held-out windows →';
    s('line', { x1: x(spec.target * 100), x2: x(spec.target * 100), y1: m.t, y2: m.t + ih, class: 'ref-line strong' }, g);
    const tl = s('text', { x: x(spec.target * 100) - 4, y: m.t + 10, class: 'ref-label', 'text-anchor': 'end' }, g);
    tl.textContent = `target ${Math.round(spec.target * 100)}%`;
    // labels sit left of their dot (dots crowd the right edge); collisions are
    // resolved top-down with a 13px gap and a leader line when a label moves
    const pts = spec.points.map(p => ({ p, cx: x(p.cov * 100), cy: y(p.width) }));
    const lab = pts.slice().sort((a, b) => a.cy - b.cy);
    let prev = -Infinity;
    for (const q of lab) {
      q.anchor = q.cx - 10 > m.l + 72 ? 'end' : 'start';
      q.lx = q.anchor === 'end' ? q.cx - 10 : q.cx + 10;
      q.ly = Math.max(q.cy + 4, prev + 13);
      prev = q.ly;
    }
    const gl = s('g', null, g), gd = s('g', null, g); // dots above labels
    pts.forEach(({ p, cx, cy, lx, ly, anchor }) => {
      if (Math.abs(ly - 4 - cy) > 5) s('line', { x1: cx + (anchor === 'end' ? -5 : 5), y1: cy, x2: lx + (anchor === 'end' ? 2 : -2), y2: ly - 4, class: 'leader' }, gl);
      const dot = s('circle', { cx, cy, r: 5, class: 'dot ' + p.cls }, gd);
      const t = s('text', { x: lx, y: ly, class: 'dot-label', 'text-anchor': anchor }, gl); t.textContent = p.label;
      const hit = s('circle', { cx, cy, r: 12, class: 'hit' }, svg);
      hit.addEventListener('pointerenter', () => {
        dot.classList.add('lift');
        showTip(tip, el, cx, cy, p.label, [
          { key: 'k-' + p.cls, value: (p.cov * 100).toFixed(1) + '%', label: 'coverage' },
          { value: compact(p.width, 2), label: 'mean interval width' },
        ]);
      });
      hit.addEventListener('pointerleave', () => { tip.hidden = true; dot.classList.remove('lift'); });
    });
  }

  // tiny line chart for the EM log-likelihood trace
  function spark(el, values, height) {
    const { svg, W, H } = frame(el, height || 48);
    if (!values || values.length < 2) return;
    const lo = Math.min(...values), hi = Math.max(...values);
    const x = i => 2 + i / (values.length - 1) * (W - 4), y = v => H - 4 - (v - lo) / ((hi - lo) || 1) * (H - 8);
    s('path', { d: values.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(''), class: 'line s1 thin' }, svg);
  }

  return { fan, columns, intervals, map, coverage, spark, compact, fmtInt, ym, niceTicks };
})();
