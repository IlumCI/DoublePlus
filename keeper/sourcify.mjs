// Every launched coin's source, verified on Sourcify (and through it on the
// chain's Blockscout) without anyone asking: scanners and explorers then
// read the code itself instead of an unverified contract. No transaction, no
// gas; a request to Sourcify per new coin.
const API = "https://sourcify.dev/server";
const PER_RUN = 5; // a burst of launches is worked through a few a run
const RETRY_SECS = 3600; // a submission that hasn't matched is resent hourly

/** Submits every coin in `coins` that Sourcify doesn't match yet. `state`
 *  ({ done: [address], tried: { address: unix secs } }) is kept by the
 *  caller between runs; returns how many were found verified this run. */
export async function verifyCoins({ coins, chainId, source, state, pastDeadline }) {
  const done = new Set(state.done ?? []);
  const tried = state.tried ?? {};
  const now = Math.floor(Date.now() / 1000);
  const ask = (path, init) => fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  let checked = 0, verified = 0;
  for (const coin of coins.map((c) => c.toLowerCase())) {
    if (done.has(coin) || (tried[coin] ?? 0) > now - RETRY_SECS) continue;
    if (checked++ >= PER_RUN || pastDeadline()) break;
    try {
      const got = await (await ask(`/v2/contract/${chainId}/${coin}`)).json();
      if (got.match) { done.add(coin); delete tried[coin]; verified++; continue; }
      // The match lands a few seconds after the submission; the next pass
      // after RETRY_SECS reads it, or submits again if it never did.
      const r = await ask(`/v2/verify/${chainId}/${coin}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(source),
      });
      tried[coin] = now;
      console.log(`sourcify: submitted ${coin} (${r.status})`);
    } catch (e) {
      tried[coin] = now;
      console.log(`sourcify: ${coin} failed: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  state.done = [...done];
  state.tried = tried;
  return verified;
}
