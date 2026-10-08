// Bivariate marked Hawkes process for buy (0) / sell (1) flow.
//
// Kernel: phi(t) = beta * exp(-beta * t), so alpha[i][j] is the expected number
// of type-i trades one type-j trade (of average size) sets off. The branching
// ratio n = spectral radius of alpha: how much of the flow is flow feeding on
// itself rather than arriving from outside.

/** Spectral radius of a 2x2 non-negative matrix. */
export function spectralRadius([[a, b], [c, d]]) {
  const tr = a + d;
  const disc = Math.sqrt(Math.max(0, (a - d) ** 2 + 4 * b * c));
  return (tr + disc) / 2;
}

/** Marks: size relative to the window's typical trade, damped (^eta) and
 *  capped so one whale or one bundle can't stand in for a crowd. Mean 1. */
export function marks(sizes, eta = 0.4, cap = 4) {
  if (sizes.length === 0) return [];
  const sorted = [...sizes].sort((x, y) => x - y);
  const med = sorted[sorted.length >> 1] || 1e-18;
  const raw = sizes.map((v) => Math.min(cap, (Math.max(v, 1e-18) / med) ** eta));
  const mean = raw.reduce((s, x) => s + x, 0) / raw.length;
  return raw.map((x) => x / mean);
}

/**
 * Fit mu and alpha by maximum likelihood with beta fixed, on events in [t0, t1].
 * events: [{ t, j: 0|1, m }], sorted by t.
 *
 * With beta fixed the excitation features of every event are known up front,
 * and the log-likelihood splits into one concave problem per target type i:
 *   ll_i(theta) = sum_k log(theta . x_k) - theta . c,   theta = (mu_i, a_i0, a_i1)
 * where x_k = (1, beta*A0_k, beta*A1_k) and c = (T, D0, D1). Projected Newton
 * solves each in a handful of steps (EM needs hundreds near the boundary).
 * Returns { mu, alpha, n, nBB, nSS, lambdaEnd, ll }.
 */
export function fitHawkes(events, t0, t1, { beta = 0.05, iters = 30 } = {}) {
  const T = Math.max(t1 - t0, 1e-9);
  const D = [0, 0];
  for (const e of events) D[e.j] += e.m * (1 - Math.exp(-beta * (t1 - e.t)));
  const X = [[], []];
  const A = [0, 0];
  let last = t0;
  for (const e of events) {
    const decay = Math.exp(-beta * (e.t - last));
    A[0] *= decay;
    A[1] *= decay;
    last = e.t;
    X[e.j].push([1, beta * A[0], beta * A[1]]);
    A[e.j] += e.m;
  }
  const c = [T, D[0], D[1]];
  const mu = [0, 0];
  const alpha = [[0, 0], [0, 0]];
  let ll = 0;
  for (let i = 0; i < 2; i++) {
    const r = solveConcave(X[i], c, iters);
    mu[i] = r.theta[0];
    alpha[i] = [r.theta[1], r.theta[2]];
    ll += r.ll;
  }
  const Aend = [0, 0];
  for (const e of events) Aend[e.j] += e.m * Math.exp(-beta * (t1 - e.t));
  const lambdaEnd = [
    mu[0] + beta * (alpha[0][0] * Aend[0] + alpha[0][1] * Aend[1]),
    mu[1] + beta * (alpha[1][0] * Aend[0] + alpha[1][1] * Aend[1]),
  ];
  return { mu, alpha, n: spectralRadius(alpha), nBB: alpha[0][0], nSS: alpha[1][1], lambdaEnd, ll };
}

/** max sum log(theta.x) - theta.c over theta >= 0 (theta0 > 0). */
function solveConcave(X, c, iters) {
  const n = X.length;
  if (n === 0) return { theta: [0, 0, 0], ll: 0 };
  let theta = [n / c[0] * 0.5, 0.1, 0.1];
  const f = (th) => {
    let s = 0;
    for (const x of X) {
      const l = th[0] * x[0] + th[1] * x[1] + th[2] * x[2];
      if (!(l > 0)) return -Infinity;
      s += Math.log(l);
    }
    return s - th[0] * c[0] - th[1] * c[1] - th[2] * c[2];
  };
  let cur = f(theta);
  for (let it = 0; it < iters; it++) {
    const g = [-c[0], -c[1], -c[2]];
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const x of X) {
      const l = theta[0] * x[0] + theta[1] * x[1] + theta[2] * x[2];
      const il = 1 / l, il2 = il * il;
      for (let a = 0; a < 3; a++) {
        g[a] += x[a] * il;
        for (let b = 0; b < 3; b++) H[a][b] -= x[a] * x[b] * il2;
      }
    }
    // Active set: a coefficient pinned at zero whose gradient points further
    // down stays out of the Newton system.
    const free = [0, 1, 2].filter((a) => a === 0 || theta[a] > 1e-12 || g[a] > 0);
    const step = newtonStep(H, g, free);
    let t = 1;
    let next = null, val = -Infinity;
    for (let k = 0; k < 30; k++) {
      const cand = theta.map((v, a) => Math.max(a === 0 ? 1e-12 : 0, v + t * step[a]));
      val = f(cand);
      if (val >= cur - 1e-12) { next = cand; break; }
      t /= 2;
    }
    if (!next) break;
    const moved = Math.abs(val - cur);
    theta = next;
    cur = val;
    if (moved < 1e-9) break;
  }
  return { theta, ll: cur };
}

/** Solve -H d = g on the free coordinates (H negative definite there). */
function newtonStep(H, g, free) {
  const k = free.length;
  const M = free.map((a) => free.map((b) => -H[a][b]));
  const v = free.map((a) => g[a]);
  for (let i = 0; i < k; i++) M[i][i] += 1e-12;
  // Gaussian elimination, k <= 3.
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    [v[i], v[p]] = [v[p], v[i]];
    for (let r = i + 1; r < k; r++) {
      const f = M[r][i] / M[i][i];
      for (let col = i; col < k; col++) M[r][col] -= f * M[i][col];
      v[r] -= f * v[i];
    }
  }
  const d = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = v[i];
    for (let col = i + 1; col < k; col++) s -= M[i][col] * d[col];
    d[i] = s / M[i][i];
  }
  const out = [0, 0, 0];
  free.forEach((a, i) => (out[a] = d[i]));
  return out;
}

/** Simulate a bivariate Hawkes process by Ogata thinning (unit marks). For
 *  tests: lets the fit be checked against known parameters. */
export function simulateHawkes({ mu, alpha, beta }, T, rand = Math.random) {
  const out = [];
  let t = 0;
  const A = [0, 0];
  let last = 0;
  const lam = () => [mu[0] + beta * (alpha[0][0] * A[0] + alpha[0][1] * A[1]), mu[1] + beta * (alpha[1][0] * A[0] + alpha[1][1] * A[1])];
  while (t < T) {
    const l = lam();
    const bound = l[0] + l[1];
    t += -Math.log(1 - rand()) / bound;
    if (t >= T) break;
    const d = Math.exp(-beta * (t - last));
    A[0] *= d; A[1] *= d; last = t;
    const l2 = lam();
    const u = rand() * bound;
    if (u < l2[0]) { out.push({ t, j: 0, m: 1 }); A[0] += 1; }
    else if (u < l2[0] + l2[1]) { out.push({ t, j: 1, m: 1 }); A[1] += 1; }
  }
  return out;
}
