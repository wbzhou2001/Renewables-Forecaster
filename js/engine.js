/*
 * HPCP engine — everything that turns installation records into forecasts.
 *
 *   1. Synthetic grid topology + installation records drawn from a multivariate
 *      Hawkes process (Zhou & Zhu, "Hierarchical Probabilistic Conformal
 *      Prediction for DER Adoption", Eq. 5).
 *   2. Maximum-likelihood fit of that process by EM (branching-structure
 *      responsibilities, closed-form M-steps).
 *   3. Ogata thinning simulation, optionally with the saturation term gamma(t)
 *      driven by a penetration cap and a tipping point.
 *   4. Hierarchical probabilistic conformal prediction (Algorithm 1): sibling-
 *      circuit non-conformity scores, conformal quantiles, circuit- and
 *      substation-level intervals, plus Marginal / Joint / Bonferroni ablations.
 *   5. Long-range Monte Carlo scenarios to 2050.
 *
 * The whole module is one self-contained factory so the app can stringify it
 * into a Web Worker (works from file:// and static hosting alike).
 *
 * Time unit: years since Jan 1 of data.T0.  Rates are per year.
 */
function HPCPEngine() {
  'use strict';

  const SECTORS = ['residential', 'commercial'];
  const BOX = { lon0: -86.33, lon1: -85.94, lat0: 39.63, lat1: 39.93 };

  // ---------------------------------------------------------------- random
  function rngFrom(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randn(rng) {
    const u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function shuffle(a, rng) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const tick = () => new Promise(r => setTimeout(r, 0));

  // ---------------------------------------------------------------- topology
  function indexMembers(sub, R) {
    const nr = new Int32Array(R);
    for (let k = 0; k < sub.length; k++) nr[sub[k]]++;
    const members = [];
    for (let r = 0; r < R; r++) members.push(new Int32Array(nr[r]));
    const fill = new Int32Array(R);
    for (let k = 0; k < sub.length; k++) members[sub[k]][fill[sub[k]]++] = k;
    return { nr, members };
  }

  // Smooth "adoption propensity" field: strong north and south-west, weaker
  // centre-east (mirrors the spatial disparity in the paper's Figure 9).
  function propensity(x, y) {
    const bump = (cx, cy, s, a) => a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
    return bump(0.5, 0.88, 0.18, 1.0) + bump(0.18, 0.2, 0.16, 0.85) + bump(0.75, 0.45, 0.17, -0.7);
  }

  function makeTopology(g, rng) {
    const K = Math.max(2, g.K | 0), R = clamp(g.R | 0, 1, K);
    const cols = Math.ceil(Math.sqrt(R * 1.25)), rows = Math.ceil(R / cols);
    const cells = shuffle(Array.from({ length: cols * rows }, (_, i) => i), rng);
    const sx = new Float64Array(R), sy = new Float64Array(R);
    for (let r = 0; r < R; r++) {
      const c = cells[r];
      sx[r] = clamp((c % cols + 0.5 + 0.7 * (rng() - 0.5)) / cols, 0.03, 0.97);
      sy[r] = clamp((Math.floor(c / cols) + 0.5 + 0.7 * (rng() - 0.5)) / rows, 0.03, 0.97);
    }
    // every substation gets one circuit; the rest go to substations with
    // log-normal "size" weights
    const w = Array.from({ length: R }, () => Math.exp(0.6 * randn(rng)));
    const wsum = w.reduce((a, b) => a + b, 0);
    const sub = new Int32Array(K);
    for (let k = 0; k < K; k++) {
      if (k < R) { sub[k] = k; continue; }
      let u = rng() * wsum, r = 0;
      for (; r < R - 1; r++) { u -= w[r]; if (u < 0) break; }
      sub[k] = r;
    }
    shuffle(sub, rng);
    const { nr, members } = indexMembers(sub, R);

    const x = new Float64Array(K), y = new Float64Array(K), z = new Float64Array(K);
    const spread = 0.55 / cols;
    for (let k = 0; k < K; k++) {
      const r = sub[k], ang = rng() * 2 * Math.PI, rad = spread * (0.3 + 0.7 * Math.sqrt(rng()));
      x[k] = clamp(sx[r] + rad * Math.cos(ang), 0.01, 0.99);
      y[k] = clamp(sy[r] + rad * Math.sin(ang), 0.01, 0.99);
      z[k] = propensity(x[k], y[k]) + 0.35 * randn(rng);
    }
    let m = 0, v = 0;
    for (let k = 0; k < K; k++) m += z[k];
    m /= K;
    for (let k = 0; k < K; k++) v += (z[k] - m) ** 2;
    const sd = Math.sqrt(v / K) || 1;
    for (let k = 0; k < K; k++) z[k] = (z[k] - m) / sd;

    // customers per circuit, split by sector
    const raw = new Float64Array(K);
    let rs = 0;
    for (let k = 0; k < K; k++) { raw[k] = Math.exp(0.35 * randn(rng)); rs += raw[k]; }
    const res = new Float64Array(K), com = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const tot = Math.round(raw[k] / rs * g.totalCustomers);
      const cshare = clamp((1 - g.resShare) * Math.exp(0.5 * randn(rng)), 0.01, 0.6);
      com[k] = Math.round(tot * cshare);
      res[k] = tot - com[k];
    }
    const pad = (n, w) => String(n).padStart(w, '0');
    // place the unit square over Indianapolis (Marion County) for the base map
    const lonOf = v => BOX.lon0 + v * (BOX.lon1 - BOX.lon0), latOf = v => BOX.lat0 + v * (BOX.lat1 - BOX.lat0);
    return {
      K, R, sub, nr, members, x, y, sx, sy, z,
      lon: x.map(lonOf), lat: y.map(latOf), slon: sx.map(lonOf), slat: sy.map(latOf),
      cust: { residential: res, commercial: com },
      circuitIds: Array.from({ length: K }, (_, k) => 'C' + pad(k + 1, 3)),
      substationIds: Array.from({ length: R }, (_, r) => 'S' + pad(r + 1, 2)),
    };
  }

  // ---------------------------------------------------------------- model
  // integral of exp(rho t) over [0, T]
  function integ(rho, T) {
    return Math.abs(rho * T) < 1e-9 ? T : Math.expm1(rho * T) / rho;
  }
  // mean of t under density ∝ exp(rho t) on [0, T]
  function meanT(rho, T) {
    const x = rho * T;
    if (Math.abs(x) < 1e-6) return T / 2 + rho * T * T / 12;
    return T / -Math.expm1(-x) - 1 / rho;
  }

  function finalizeModel(m, topo) {
    let muTot = 0;
    for (let k = 0; k < m.mu.length; k++) muTot += m.mu[k];
    const muCum = new Float64Array(m.mu.length);
    let acc = 0;
    for (let k = 0; k < m.mu.length; k++) { acc += m.mu[k]; muCum[k] = muTot > 0 ? acc / muTot : (k + 1) / m.mu.length; }
    // branching ratio: expected direct offspring of an immigrant event
    let eta = 0;
    for (let k = 0; k < m.mu.length; k++) {
      const share = muTot > 0 ? m.mu[k] / muTot : 1 / m.mu.length;
      eta += share * (m.aS + m.aB * (topo.nr[topo.sub[k]] - 1));
    }
    m.muTot = muTot; m.muCum = muCum; m.eta = eta;
    return m;
  }

  function truthModel(topo, cust, p, Tdata) {
    const K = topo.K, w = new Float64Array(K);
    let s = 0;
    for (let k = 0; k < K; k++) { w[k] = (cust[k] + 1) * Math.exp(p.sigma * topo.z[k]); s += w[k]; }
    let eta = 0;
    for (let k = 0; k < K; k++) { w[k] /= s; eta += w[k] * (p.aS + p.aB * (topo.nr[topo.sub[k]] - 1)); }
    const muTot = p.target * Math.max(0.05, 1 - eta) / integ(p.rho, Tdata);
    const mu = new Float64Array(K);
    for (let k = 0; k < K; k++) mu[k] = muTot * w[k];
    return finalizeModel({ mu, rho: p.rho, aS: p.aS, aB: p.aB, beta: 12 / p.lagMonths }, topo);
  }

  // ---------------------------------------------------------------- state
  // Excitation sums are stored scaled to a reference time:
  //   E(t) = Ehat * exp(-beta (t - tref)),  Ehat = sum beta exp(beta (t_i - tref)).
  function newState(topo) {
    return { Ek: new Float64Array(topo.K), Er: new Float64Array(topo.R), Etot: 0, V: 0, tref: 0, N: 0 };
  }
  function cloneState(s) {
    return { Ek: s.Ek.slice(), Er: s.Er.slice(), Etot: s.Etot, V: s.V, tref: s.tref, N: s.N };
  }
  function renorm(s, t, beta) {
    const f = Math.exp(-beta * (t - s.tref));
    for (let i = 0; i < s.Ek.length; i++) s.Ek[i] *= f;
    for (let i = 0; i < s.Er.length; i++) s.Er[i] *= f;
    s.Etot *= f; s.V *= f; s.tref = t;
  }
  function addEvent(s, topo, k, t, beta) {
    if (beta * (t - s.tref) > 30) renorm(s, t, beta);
    const d = beta * Math.exp(beta * (t - s.tref)), r = topo.sub[k];
    s.Ek[k] += d; s.Er[r] += d; s.Etot += d; s.V += (topo.nr[r] - 1) * d; s.N++;
  }

  function pickCum(cum, u) {
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function pickIn(Ek, mem, rng, exclude) {
    let tot = 0, last = -1;
    for (let i = 0; i < mem.length; i++) { const k = mem[i]; if (k !== exclude) { tot += Ek[k]; last = k; } }
    let u = rng() * tot;
    for (let i = 0; i < mem.length; i++) {
      const k = mem[i];
      if (k === exclude) continue;
      u -= Ek[k];
      if (u < 0) return k;
    }
    return last;
  }
  // circuit with probability ∝ its own excitation (self-excitation)
  function pickSelf(s, topo, rng) {
    let u = rng() * s.Etot, r = 0;
    for (; r < topo.R - 1; r++) { u -= s.Er[r]; if (u < 0) break; }
    return pickIn(s.Ek, topo.members[r], rng, -1);
  }
  // circuit with probability ∝ excitation of its siblings (same substation)
  function pickSib(s, topo, rng) {
    let u = rng() * s.V, r = 0;
    for (; r < topo.R - 1; r++) { u -= (topo.nr[r] - 1) * s.Er[r]; if (u < 0) break; }
    const mem = topo.members[r];
    const src = pickIn(s.Ek, mem, rng, -1);
    if (mem.length < 2) return src;
    const idx = Math.floor(rng() * (mem.length - 1));
    for (let i = 0, j = 0; i < mem.length; i++) {
      if (mem[i] === src) continue;
      if (j++ === idx) return mem[i];
    }
    return src;
  }

  /*
   * Ogata thinning for
   *   lambda_k(t) = gamma(t) [ mu_k e^{rho t} + aS E_k(t) + aB (E_{r(k)}(t) - E_k(t)) ],
   * E_k(t) = sum_{t_i<t, k_i=k} beta e^{-beta (t - t_i)}.
   * gamma(t) = 1 before the tipping point tp; afterwards it decays linearly in
   * the remaining headroom to the cap, normalised to be continuous at tp.
   * Mutates state s; options: rng, cap, tp, Ntp (count at tp, written back),
   * monthly (cumulative N at each month end), counts (per-circuit), record.
   */
  function simulate(topo, m, s, t0, t1, o) {
    const rng = o.rng, beta = m.beta, aS = m.aS, aB = m.aB, rho = m.rho, muTot = m.muTot;
    const cap = o.cap > 0 ? o.cap : Infinity;
    const tp = o.tp != null ? o.tp : Infinity;
    const monthly = o.monthly || null, counts = o.counts || null, rec = o.record || null;
    const m0 = Math.round(t0 * 12);
    let mi = 0, nextB = monthly ? (m0 + 1) / 12 : Infinity;
    let t = t0;
    if (t >= tp && o.Ntp == null) o.Ntp = s.N;
    const gam = () => {
      if (t < tp || cap === Infinity) return 1;
      const base = 1 - o.Ntp / cap;
      if (base <= 0) return 0;
      const v = (1 - s.N / cap) / base;
      return v > 0 ? v : 0;
    };
    let g = gam();
    const maxEv = o.maxEvents || 2e6;
    let nev = 0;
    while (t < t1 && g > 0) {
      if (beta * (t - s.tref) > 30) renorm(s, t, beta);
      let wEnd = t + 1 / 12;
      if (wEnd > t1) wEnd = t1;
      if (t < tp && wEnd > tp) wEnd = tp;
      const dec = Math.exp(-beta * (t - s.tref));
      const bgMax = muTot * Math.exp(rho * (rho > 0 ? wEnd : t));
      const lamBar = g * (bgMax + (aS * s.Etot + aB * s.V) * dec);
      const tn = lamBar > 0 ? t - Math.log(1 - rng()) / lamBar : Infinity;
      if (tn >= wEnd) {
        t = wEnd;
        if (monthly) while (mi < monthly.length && nextB <= t + 1e-9) { monthly[mi++] = s.N; nextB = (m0 + mi + 1) / 12; }
        if (t >= tp && o.Ntp == null) o.Ntp = s.N;
        g = gam();
        continue;
      }
      t = tn;
      if (monthly) while (mi < monthly.length && nextB <= t) { monthly[mi++] = s.N; nextB = (m0 + mi + 1) / 12; }
      const d2 = Math.exp(-beta * (t - s.tref));
      const bg = muTot * Math.exp(rho * t), pS = aS * s.Etot * d2, pB = aB * s.V * d2;
      if (rng() * lamBar > g * (bg + pS + pB)) continue;
      const u = rng() * (bg + pS + pB);
      const k = u < bg ? pickCum(m.muCum, rng()) : u < bg + pS ? pickSelf(s, topo, rng) : pickSib(s, topo, rng);
      addEvent(s, topo, k, t, beta);
      if (counts) counts[k]++;
      if (rec) rec.push(t, k);
      g = gam();
      if (++nev > maxEv) break;
    }
    if (monthly) while (mi < monthly.length) monthly[mi++] = s.N;
    return t;
  }

  // ---------------------------------------------------------------- fitting
  /*
   * EM for the Hawkes process above on events with t < Tobs (gamma = 1).
   * mu_k gets a Gamma prior centred on the exposure-proportional pooled rate
   * (c pseudo-events per average circuit) so sparse circuits are not zeroed.
   */
  function fitHawkes(topo, ev, Tobs, expo, opts) {
    opts = opts || {};
    const K = topo.K, R = topo.R, sub = topo.sub, nr = topo.nr;
    const tArr = ev.t, kArr = ev.k;
    let n = 0;
    while (n < tArr.length && tArr[n] < Tobs) n++;
    const w = new Float64Array(K);
    let ws = 0;
    for (let k = 0; k < K; k++) { w[k] = expo[k] + 1e-9; ws += w[k]; }
    for (let k = 0; k < K; k++) w[k] /= ws;
    const c = opts.shrink != null ? opts.shrink : 2;
    const cnt = new Float64Array(K);
    for (let i = 0; i < n; i++) cnt[kArr[i]]++;

    const init = opts.init || {};
    let rho = init.rho != null ? init.rho : 0.1, aS = init.aS != null ? init.aS : 0.2;
    let aB = init.aB != null ? init.aB : 0.02, beta = init.beta || 2;
    const hawkes = n >= 8;
    if (!hawkes) { aS = 0; aB = 0; }
    const mu = new Float64Array(K);
    let I = integ(rho, Tobs);
    for (let k = 0; k < K; k++) mu[k] = (hawkes ? 0.5 : 1) * (cnt[k] + c * K * w[k]) / (I * (1 + c * K / Math.max(n, 1)));
    if (init.mu) mu.set(init.mu);

    // time-to-horizon and sibling count of each training event, for the
    // compensator's dependence on beta (matters when adoption grows fast and
    // many events sit near the end of the window)
    const tau = new Float64Array(n), nsib = new Float64Array(n);
    for (let i = 0; i < n; i++) { tau[i] = Tobs - tArr[i]; nsib[i] = nr[sub[kArr[i]]] - 1; }
    // maximise SP log b - b LAG - sum_j c_j (1 - e^{-b tau_j}),  c_j = aS + aB nsib_j
    function solveBeta(SP, LAG, aS, aB, b0) {
      const d = b => {
        let s = 0;
        for (let i = 0; i < n; i++) s += (aS + aB * nsib[i]) * tau[i] * Math.exp(-b * tau[i]);
        return SP / b - LAG - s;
      };
      let lo = 0.2, hi = 60;
      if (d(lo) <= 0) return lo;
      if (d(hi) >= 0) return hi;
      // tighten the bracket around the previous value when possible
      const a = Math.max(lo, b0 / 3), c = Math.min(hi, b0 * 3);
      if (d(a) > 0 && d(c) < 0) { lo = a; hi = c; }
      for (let it = 0; it < 40; it++) {
        const mid = Math.sqrt(lo * hi);
        if (d(mid) > 0) lo = mid; else hi = mid;
        if (hi / lo < 1 + 1e-7) break;
      }
      return Math.sqrt(lo * hi);
    }

    const S0 = new Float64Array(K);
    const Ak = new Float64Array(K), Bk = new Float64Array(K), lk = new Float64Array(K);
    const Ar = new Float64Array(R), Br = new Float64Array(R), lr = new Float64Array(R);
    let ll = -Infinity, llPrev = -Infinity, iters = 0, S0last = n;
    const maxIter = opts.maxIter || 400;
    const trace = [];

    for (iters = 0; iters < maxIter; iters++) {
      S0.fill(0); Ak.fill(0); Bk.fill(0); lk.fill(0); Ar.fill(0); Br.fill(0); lr.fill(0);
      let S0t = 0, S0tot = 0, SS = 0, SB = 0, LAG = 0, GS = 0, GB = 0, llE = 0;
      for (let i = 0; i < n; i++) {
        const t = tArr[i], k = kArr[i], r = sub[k];
        let dt = t - lk[k], e = Math.exp(-beta * dt);
        Bk[k] = (Bk[k] + dt * Ak[k]) * e; Ak[k] *= e; lk[k] = t;
        dt = t - lr[r]; e = Math.exp(-beta * dt);
        Br[r] = (Br[r] + dt * Ar[r]) * e; Ar[r] *= e; lr[r] = t;
        const sibA = Math.max(0, Ar[r] - Ak[k]);
        const bg = mu[k] * Math.exp(rho * t), se = aS * beta * Ak[k], sb = aB * beta * sibA;
        const lam = bg + se + sb;
        llE += Math.log(lam > 0 ? lam : 1e-300);
        const p0 = bg / lam, ps = se / lam, pb = sb / lam;
        S0[k] += p0; S0t += p0 * t; S0tot += p0; SS += ps; SB += pb;
        if (ps > 0) LAG += ps * Bk[k] / Ak[k];
        if (pb > 0 && sibA > 1e-12) LAG += pb * Math.max(0, Br[r] - Bk[k]) / sibA;
        Ak[k] += 1; Ar[r] += 1;
        const G = -Math.expm1(-beta * (Tobs - t));
        GS += G; GB += (nr[r] - 1) * G;
      }
      let muTot = 0;
      for (let k = 0; k < K; k++) muTot += mu[k];
      ll = llE - muTot * integ(rho, Tobs) - aS * GS - aB * GB;
      trace.push(ll);

      // M-step (ECM: excitation weights, then decay given the new weights)
      if (hawkes) {
        aS = GS > 0 ? SS / GS : 0;
        aB = GB > 0 ? SB / GB : 0;
        if (LAG > 0 && SS + SB > 1e-9) beta = solveBeta(SS + SB, LAG, aS, aB, beta);
      }
      const target = S0tot > 0 ? S0t / S0tot : Tobs / 2;
      let lo = -3, hi = 3;
      for (let b = 0; b < 60; b++) { const mid = (lo + hi) / 2; if (meanT(mid, Tobs) < target) lo = mid; else hi = mid; }
      rho = (lo + hi) / 2;
      I = integ(rho, Tobs);
      const tot = Math.max(S0tot, 1e-9);
      S0last = tot;
      for (let k = 0; k < K; k++) mu[k] = (S0[k] + c * K * w[k] * tot / Math.max(n, 1)) / (I * (1 + c * K / Math.max(n, 1)));

      if (iters > 15 && Math.abs(ll - llPrev) < 1e-8 * Math.max(1, Math.abs(ll))) break;
      llPrev = ll;
    }
    // Standard error of the growth rate: rho is the natural parameter of an
    // exponential family in t for background events, so its Fisher
    // information is (#background events) x Var(t) under density ∝ e^{rho t}.
    const varT = (() => {
      const G = 400, h = Tobs / G;
      let z = 0, m1 = 0, m2 = 0;
      for (let i = 0; i < G; i++) { const t = (i + 0.5) * h, wv = Math.exp(rho * (t - Tobs)); z += wv; m1 += wv * t; m2 += wv * t * t; }
      m1 /= z;
      return Math.max(1e-9, m2 / z - m1 * m1);
    })();
    const seRho = 1 / Math.sqrt(Math.max(1, S0last) * varT);
    return finalizeModel({ mu, rho, aS, aB, beta, ll, iters: iters + 1, n, Tobs, trace, seRho }, topo);
  }

  // ---------------------------------------------------------------- data
  function buildSynthetic(g) {
    const rng = rngFrom(g.seed);
    const topo = makeTopology(g, rng);
    const T0 = g.startYear, Tend = g.endYear - g.startYear;
    const sectors = {};
    for (const name of SECTORS) {
      const truth = truthModel(topo, topo.cust[name], g.sectors[name], Tend);
      const rec = [];
      simulate(topo, truth, newState(topo), 0, Tend, { rng, record: rec });
      const n = rec.length / 2, t = new Float64Array(n), k = new Int32Array(n);
      for (let i = 0; i < n; i++) { t[i] = rec[2 * i]; k[i] = rec[2 * i + 1]; }
      sectors[name] = { t, k, truth };
    }
    return { synthetic: true, T0, Tend, topo, sectors };
  }

  // u = { T0, Tend, topo: {...plain arrays}, sectors: {name: {t, k}} } prepared by the app
  function buildUploaded(u) {
    const sub = Int32Array.from(u.topo.sub), R = u.topo.substationIds.length;
    const { nr, members } = indexMembers(sub, R);
    const topo = Object.assign({}, u.topo, {
      K: sub.length, R, sub, nr, members,
      x: Float64Array.from(u.topo.x), y: Float64Array.from(u.topo.y),
      sx: Float64Array.from(u.topo.sx), sy: Float64Array.from(u.topo.sy),
      lon: Float64Array.from(u.topo.lon), lat: Float64Array.from(u.topo.lat),
      slon: Float64Array.from(u.topo.slon), slat: Float64Array.from(u.topo.slat),
      z: new Float64Array(sub.length),
      cust: { residential: Float64Array.from(u.topo.cust.residential), commercial: Float64Array.from(u.topo.cust.commercial) },
    });
    const sectors = {};
    for (const name of SECTORS) {
      const s = u.sectors[name] || { t: [], k: [] };
      sectors[name] = { t: Float64Array.from(s.t), k: Int32Array.from(s.k), truth: null };
    }
    return { synthetic: false, T0: u.T0, Tend: u.Tend, topo, sectors };
  }

  function replay(topo, model, ev, upTo, state, from) {
    let p = from || 0;
    while (p < ev.t.length && ev.t[p] < upTo) { addEvent(state, topo, ev.k[p], ev.t[p], model.beta); p++; }
    return p;
  }

  // ---------------------------------------------------------------- HPCP
  /*
   * Calibration pairs: rolling windows of L months starting monthly from the
   * training cutoff tau.  For each window, M trajectories are simulated from
   * the model fitted on D_tr, conditioned on all history before the window.
   * Scores (min over samples of the max abs error over a set of circuits):
   *   HPCP      — sibling circuits (S = C C^T), one score per substation
   *   Marginal  — the circuit alone (S = I)
   *   Joint     — all circuits (S = 1 1^T)
   */
  async function calibrate(topo, model, ev, tau, Tend, L, M, seed, isStale, progress) {
    const K = topo.K, R = topo.R, sub = topo.sub;
    const rng = rngFrom(seed);
    const sStart = Math.ceil(tau * 12 - 1e-9), sEnd = Math.round(Tend * 12) - L;
    const wins = [];
    const st = newState(topo);
    let p = 0;
    const N = ev.t.length;
    const D = new Float64Array(R);
    const total = Math.max(0, sEnd - sStart + 1);
    for (let s = sStart; s <= sEnd; s++) {
      const a = s / 12, b = (s + L) / 12;
      p = replay(topo, model, ev, a, st, p);
      const y = new Int32Array(K);
      for (let q = p; q < N && ev.t[q] < b; q++) y[ev.k[q]]++;
      const sims = new Int32Array(M * K);
      for (let m = 0; m < M; m++) simulate(topo, model, cloneState(st), a, b, { rng, counts: sims.subarray(m * K, (m + 1) * K) });
      const sH = new Float64Array(R).fill(Infinity), sM = new Float64Array(K).fill(Infinity);
      let sJ = Infinity, sSys = Infinity, ySys = 0;
      for (let k = 0; k < K; k++) ySys += y[k];
      for (let m = 0; m < M; m++) {
        D.fill(0);
        let J = 0, tot = 0;
        for (let k = 0; k < K; k++) {
          const v = sims[m * K + k], d = Math.abs(y[k] - v);
          tot += v;
          if (d < sM[k]) sM[k] = d;
          if (d > D[sub[k]]) D[sub[k]] = d;
        }
        for (let r = 0; r < R; r++) { if (D[r] < sH[r]) sH[r] = D[r]; if (D[r] > J) J = D[r]; }
        if (J < sJ) sJ = J;
        const ds = Math.abs(ySys - tot);
        if (ds < sSys) sSys = ds;
      }
      // network total gets its own (one-dimensional) probabilistic conformal score
      wins.push({ s, y, sims, sH, sM, sJ, sSys });
      if ((s - sStart) % 6 === 5) {
        if (progress) progress((s - sStart + 1) / total);
        await tick();
        if (isStale()) return null;
      }
    }
    // prediction for the next window, conditioned on the full history
    replay(topo, model, ev, Infinity, st, p);
    const pred = new Int32Array(M * K);
    for (let m = 0; m < M; m++) simulate(topo, model, cloneState(st), Tend, Tend + L / 12, { rng, counts: pred.subarray(m * K, (m + 1) * K) });
    return { wins, pred, L, M, K, R };
  }

  /*
   * Weighted conformal quantile (non-exchangeable split conformal): the
   * smallest score whose cumulative weight reaches q (sum w + 1), the test
   * point carrying weight 1.  Equal weights give the usual ceil((n+1) q)-th
   * smallest score.  `order` holds indices sorted by score.
   */
  function wQuantile(vals, ws, order, q) {
    const n = vals.length;
    if (!n) return { v: 0, sat: true };
    let tot = 1;
    for (let i = 0; i < n; i++) tot += ws[i];
    const target = q * tot - 1e-12;
    let cum = 0;
    for (let i = 0; i < n; i++) { cum += ws[order[i]]; if (cum >= target) return { v: vals[order[i]], sat: false }; }
    return { v: vals[order[n - 1]], sat: true };
  }
  function confQuantile(sorted, q) {
    const ws = new Float64Array(sorted.length).fill(1), order = sorted.map((_, i) => i);
    return wQuantile(sorted, ws, order, q);
  }

  // Recency weights for calibration windows [from, to): half-life hl months
  // measured back from the window the intervals are used for (0 = equal).
  function windowWeights(from, to, hl) {
    const ws = new Float64Array(to - from);
    for (let j = from; j < to; j++) ws[j - from] = hl > 0 ? Math.pow(0.5, (to - j) / hl) : 1;
    return ws;
  }

  function quantiles(topo, wins, from, to, conf, hl) {
    const K = topo.K, R = topo.R, n = to - from;
    const ws = windowWeights(from, to, hl);
    const col = new Float64Array(n), order = new Array(n);
    let sat = false;
    const take = get => {
      for (let j = 0; j < n; j++) { col[j] = get(wins[from + j]); order[j] = j; }
      order.sort((a, b) => col[a] - col[b]);
    };
    const H = new Float64Array(R), Mq = new Float64Array(K), B = new Float64Array(K);
    for (let r = 0; r < R; r++) { take(w => w.sH[r]); const q = wQuantile(col, ws, order, conf); H[r] = q.v; sat = sat || q.sat; }
    const bLevel = 1 - (1 - conf) / K;
    for (let k = 0; k < K; k++) {
      take(w => w.sM[k]);
      const q = wQuantile(col, ws, order, conf); Mq[k] = q.v; sat = sat || q.sat;
      B[k] = wQuantile(col, ws, order, bLevel).v;
    }
    take(w => w.sJ);
    const J = wQuantile(col, ws, order, conf);
    take(w => w.sSys);
    const Sys = wQuantile(col, ws, order, conf);
    let ess = 0, s1 = 0;
    for (let j = 0; j < n; j++) { s1 += ws[j]; ess += ws[j] * ws[j]; }
    return { H, M: Mq, J: J.v, B, Sys: Sys.v, sat: sat || J.sat || Sys.sat, ess: s1 * s1 / ess };
  }

  const METHODS = ['HPCP', 'Marginal', 'Joint', 'Bonferroni'];
  function qFor(Q, method, topo, k) {
    switch (method) {
      case 'HPCP': return Q.H[topo.sub[k]];
      case 'Marginal': return Q.M[k];
      case 'Joint': return Q.J;
      default: return Q.B[k];
    }
  }
  function intervalsFrom(topo, sims, M, Q, method) {
    const K = topo.K, lo = new Float64Array(K), hi = new Float64Array(K), pt = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      let mn = Infinity, mx = -Infinity, sm = 0;
      for (let m = 0; m < M; m++) { const v = sims[m * K + k]; if (v < mn) mn = v; if (v > mx) mx = v; sm += v; }
      const q = qFor(Q, method, topo, k);
      lo[k] = Math.max(0, mn - q); hi[k] = mx + q; pt[k] = sm / M;
    }
    return { lo, hi, pt };
  }
  function aggregate(topo, arr) {
    const out = new Float64Array(topo.R);
    for (let k = 0; k < topo.K; k++) out[topo.sub[k]] += arr[k];
    return out;
  }

  // Conformal step for one confidence level — cheap, reruns on every slider move.
  function evaluate(topo, cal, conf, hl) {
    const { wins, pred, M } = cal, n = wins.length, K = topo.K, R = topo.R;
    if (n < 2) return { error: 'Not enough calibration windows. Move the training cutoff earlier or shorten the window.' };
    const nCal = n >= 10 ? Math.floor(n * 0.7) : n - 1;
    const Qc = quantiles(topo, wins, 0, nCal, conf, hl);
    const metrics = METHODS.map(method => {
      let cc = 0, ct = 0, sc = 0, stt = 0, cw = 0, sw = 0;
      for (let j = nCal; j < n; j++) {
        const w = wins[j], iv = intervalsFrom(topo, w.sims, M, Qc, method);
        const yS = aggregate(topo, w.y), lS = aggregate(topo, iv.lo), hS = aggregate(topo, iv.hi);
        for (let k = 0; k < K; k++) { cc += (iv.lo[k] <= w.y[k] && w.y[k] <= iv.hi[k]) ? 1 : 0; ct++; cw += iv.hi[k] - iv.lo[k]; }
        for (let r = 0; r < R; r++) { sc += (lS[r] <= yS[r] && yS[r] <= hS[r]) ? 1 : 0; stt++; sw += hS[r] - lS[r]; }
      }
      return { method, circuitCoverage: cc / ct, substationCoverage: sc / stt, circuitWidth: cw / ct, substationWidth: sw / stt };
    });
    const Qa = quantiles(topo, wins, 0, n, conf, hl);
    const iv = intervalsFrom(topo, pred, M, Qa, 'HPCP');
    const subLo = aggregate(topo, iv.lo), subHi = aggregate(topo, iv.hi), subPt = aggregate(topo, iv.pt);
    let sysPt = 0, sysMin = Infinity, sysMax = -Infinity;
    for (let r = 0; r < R; r++) sysPt += subPt[r];
    for (let m = 0; m < M; m++) {
      let tot = 0;
      for (let k = 0; k < K; k++) tot += pred[m * K + k];
      if (tot < sysMin) sysMin = tot;
      if (tot > sysMax) sysMax = tot;
    }
    const sysLo = Math.max(0, sysMin - Qa.Sys), sysHi = sysMax + Qa.Sys;
    // held-out coverage of the network-total interval
    let sysCov = 0;
    for (let j = nCal; j < n; j++) {
      const w = wins[j];
      let yS = 0, mn = Infinity, mx = -Infinity;
      for (let k = 0; k < K; k++) yS += w.y[k];
      for (let m = 0; m < M; m++) {
        let tot = 0;
        for (let k = 0; k < K; k++) tot += w.sims[m * K + k];
        if (tot < mn) mn = tot;
        if (tot > mx) mx = tot;
      }
      if (Math.max(0, mn - Qc.Sys) <= yS && yS <= mx + Qc.Sys) sysCov++;
    }
    sysCov /= Math.max(1, n - nCal);
    const lastObs = wins[n - 1].y;
    return {
      conf, hl, nWindows: n, nCal, nTest: n - nCal, saturated: Qa.sat || Qc.sat, ess: Qa.ess, metrics, sysCov,
      pred: { lo: iv.lo, hi: iv.hi, pt: iv.pt, subLo, subHi, subPt, sysLo, sysHi, sysPt, subQ: Qa.H },
      lastWindowObserved: aggregate(topo, lastObs),
    };
  }

  // ---------------------------------------------------------------- scenarios
  async function longRange(topo, model, ev, Tend, Hend, cap, tp, P, seed, checkpoints, isStale, onPartial) {
    const K = topo.K, months = Math.round((Hend - Tend) * 12);
    const rng = rngFrom(seed);
    const base = newState(topo);
    replay(topo, model, ev, Infinity, base, 0);
    const histCounts = new Int32Array(K);
    for (let i = 0; i < ev.k.length; i++) histCounts[ev.k[i]]++;
    let NtpObs = null;
    if (tp <= Tend) { NtpObs = 0; while (NtpObs < ev.t.length && ev.t[NtpObs] < tp) NtpObs++; }
    const cps = checkpoints.filter(c => c > Tend && c < Hend).concat([Hend]);
    const paths = new Float32Array(P * months);
    const cpCounts = new Float32Array(P * cps.length * K);
    const bounds = [Tend].concat(cps);
    const every = Math.max(2, Math.round(P / 12));
    for (let p = 0; p < P; p++) {
      const st = cloneState(base), cnt = histCounts.slice();
      const o = { rng, cap, tp, Ntp: NtpObs, counts: cnt };
      // growth-rate uncertainty: draw rho from its sampling distribution and
      // anchor the background rate at the end of the data (today's rate is
      // well identified; the future trend is not)
      let pm = model;
      if (model.seRho > 0) {
        const r = model.rho + model.seRho * randn(rng);
        pm = Object.assign({}, model, { rho: r, muTot: model.muTot * Math.exp((model.rho - r) * Tend) });
      }
      for (let c = 0; c < cps.length; c++) {
        const a = bounds[c], b = bounds[c + 1];
        const i0 = Math.round((a - Tend) * 12), i1 = Math.round((b - Tend) * 12);
        o.monthly = paths.subarray(p * months + i0, p * months + i1);
        simulate(topo, pm, st, a, b, o);
        cpCounts.set(cnt, (p * cps.length + c) * K);
      }
      if ((p + 1) % every === 0 || p === P - 1) {
        onPartial({ done: p + 1, paths: paths.slice(0, (p + 1) * months), months, checkpoints: cps, cpCounts: cpCounts.slice(0, (p + 1) * cps.length * K) });
        await tick();
        if (isStale()) return null;
      }
    }
    return { paths, months, checkpoints: cps, cpCounts, P };
  }

  // ---------------------------------------------------------------- pipeline
  const C = { dk: null, data: null, sec: {} };
  let latest = 0;

  function fitSummary(m, topo) {
    return { rho: m.rho, seRho: m.seRho, aS: m.aS, aB: m.aB, beta: m.beta, muTot: m.muTot, eta: m.eta, ll: m.ll, iters: m.iters, n: m.n, Tobs: m.Tobs, mu: m.mu, trace: m.trace };
  }

  function dataSummary(D) {
    const tp = D.topo, sectors = {};
    for (const name of SECTORS) {
      const s = D.sectors[name];
      sectors[name] = { t: s.t, k: s.k, truth: s.truth ? fitSummary(s.truth, tp) : null };
    }
    return {
      synthetic: D.synthetic, T0: D.T0, Tend: D.Tend,
      topo: { K: tp.K, R: tp.R, sub: tp.sub, nr: tp.nr, x: tp.x, y: tp.y, sx: tp.sx, sy: tp.sy,
        lon: tp.lon, lat: tp.lat, slon: tp.slon, slat: tp.slat, geo: !!tp.geo,
        cust: tp.cust, circuitIds: tp.circuitIds, substationIds: tp.substationIds },
      sectors,
    };
  }

  async function run(id, cfg, post) {
    const stale = () => id !== latest;
    const t0 = Date.now();
    const dk = cfg.data.source === 'upload' ? 'U:' + cfg.data.upload.key : 'S:' + JSON.stringify(cfg.data.gen);
    if (C.dk !== dk) {
      post({ type: 'status', id, text: 'Generating installation records' });
      C.data = cfg.data.source === 'upload' ? buildUploaded(cfg.data.upload) : buildSynthetic(cfg.data.gen);
      C.dk = dk; C.sec = {};
    }
    const D = C.data, topo = D.topo;
    post({ type: 'data', id, data: dataSummary(D) });
    const order = [cfg.active].concat(SECTORS.filter(s => s !== cfg.active));
    for (const name of order) {
      if (stale()) return;
      const sc = cfg.sectors[name], ev = D.sectors[name], expo = topo.cust[name];
      const S = C.sec[name] || (C.sec[name] = {});
      const tau = clamp(cfg.model.tau - D.T0, 1, D.Tend - 1 / 12);
      const fk = String(tau);
      if (S.fk !== fk) {
        post({ type: 'status', id, text: `Fitting Hawkes model · ${name}` });
        S.fitTr = fitHawkes(topo, ev, tau, expo);
        S.fk = fk; S.ck = null;
      }
      if (!S.fitFull) S.fitFull = fitHawkes(topo, ev, D.Tend, expo);
      post({ type: 'fit', id, sector: name, train: fitSummary(S.fitTr, topo), full: fitSummary(S.fitFull, topo) });

      const L = cfg.model.L, M = cfg.model.M;
      const ck = [fk, L, M, cfg.model.simSeed].join('|');
      if (S.ck !== ck) {
        const cal = await calibrate(topo, S.fitTr, ev, tau, D.Tend, L, M, cfg.model.simSeed, stale,
          f => post({ type: 'status', id, text: `Calibrating HPCP · ${name}`, frac: f }));
        if (!cal) return;
        S.cal = cal; S.ck = ck;
      }
      post({ type: 'hpcp', id, sector: name, L, M, result: evaluate(topo, S.cal, sc.conf, cfg.model.hl) });

      const Hend = cfg.model.horizon - D.T0;
      let capN = 0;
      for (let k = 0; k < topo.K; k++) capN += expo[k];
      capN *= sc.capPct / 100;
      const tpT = sc.tp - D.T0;
      const lk = [capN, tpT, sc.paths, Hend, cfg.model.simSeed].join('|');
      if (S.lk !== lk) {
        const cps = [2030, 2040].map(y => y - D.T0);
        const res = await longRange(topo, S.fitFull, ev, D.Tend, Hend, capN, tpT, sc.paths, cfg.model.simSeed + 1, cps, stale,
          part => post({ type: 'long', id, sector: name, final: false, P: sc.paths, result: part }));
        if (!res) return;
        S.long = res; S.lk = lk;
      }
      post({ type: 'long', id, sector: name, final: true, P: sc.paths, result: { done: S.long.P, paths: S.long.paths, months: S.long.months, checkpoints: S.long.checkpoints, cpCounts: S.long.cpCounts } });
    }
    post({ type: 'done', id, ms: Date.now() - t0 });
  }

  async function handle(msg, post) {
    if (msg.type !== 'run') return;
    latest = msg.id;
    try {
      await run(msg.id, msg.config, post);
    } catch (e) {
      post({ type: 'error', id: msg.id, message: String(e && e.message || e), stack: String(e && e.stack || '') });
    }
  }

  return {
    handle,
    // exposed for testing / reuse
    rngFrom, makeTopology, truthModel, simulate, fitHawkes, calibrate, evaluate, longRange,
    buildSynthetic, newState, cloneState, replay, confQuantile, METHODS,
  };
}

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof importScripts === 'function') {
  // loaded directly as a worker script (not used by default; the app builds a blob worker)
  const E = HPCPEngine();
  self.onmessage = e => E.handle(e.data, m => self.postMessage(m));
}
