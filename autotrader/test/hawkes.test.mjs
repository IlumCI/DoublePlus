import { test } from "node:test";
import assert from "node:assert/strict";

import { fitHawkes, marks, simulateHawkes, spectralRadius } from "../src/hawkes.mjs";

// Deterministic PRNG so the fits are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);
}

test("spectral radius of 2x2", () => {
  assert.equal(spectralRadius([[0.5, 0], [0, 0.3]]), 0.5);
  assert.ok(Math.abs(spectralRadius([[0.2, 0.3], [0.3, 0.2]]) - 0.5) < 1e-12);
});

test("the fit recovers a known self-exciting buy flow", () => {
  const truth = { mu: [0.2, 0.1], alpha: [[0.6, 0.05], [0.25, 0.3]], beta: 0.05 };
  const ev = simulateHawkes(truth, 20_000, lcg(7));
  const fit = fitHawkes(ev, 0, 20_000, { beta: 0.05 });
  assert.ok(Math.abs(fit.nBB - 0.6) < 0.1, `nBB ${fit.nBB}`);
  assert.ok(Math.abs(fit.alpha[1][0] - 0.25) < 0.1, `aSB ${fit.alpha[1][0]}`);
  assert.ok(Math.abs(fit.mu[0] - 0.2) < 0.06, `muB ${fit.mu[0]}`);
});

test("a Poisson stream fits as barely self-exciting", () => {
  const ev = simulateHawkes({ mu: [0.3, 0.3], alpha: [[0, 0], [0, 0]], beta: 0.05 }, 20_000, lcg(11));
  const fit = fitHawkes(ev, 0, 20_000, { beta: 0.05 });
  assert.ok(fit.n < 0.15, `n ${fit.n}`);
});

test("marks are mean one and capped", () => {
  const m = marks([1, 1, 1, 1000]);
  assert.ok(Math.abs(m.reduce((s, x) => s + x, 0) / 4 - 1) < 1e-12);
  assert.ok(m[3] / m[0] <= 4 + 1e-9);
  assert.deepEqual(marks([]), []);
});
