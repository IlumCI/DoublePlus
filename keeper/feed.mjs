// The launch feed: every new coin, and every coin that graduates to its
// pool, posted to a Telegram channel and a Discord channel with its link
// (which previews the coin, see web/worker.mjs). Free; no transaction. Each
// destination is optional and off until its secret is set.
const SITE = "https://doubleplus.fun";
const PER_RUN = 5; // a burst of launches goes out a few a minute
const GIVE_UP = 5; // a post that fails this many runs in a row is dropped

const TOKEN_ABI = ["function name() view returns (string)", "function symbol() view returns (string)", "function metadataURI() view returns (string)"];

// Creator text for a plain-text post: invisible and direction-changing
// characters out, whitespace collapsed, capped.
function clean(v, max) {
  if (typeof v !== "string") return "";
  const t = v.replace(/[\u0000-\u001F\u007F-\u009F­؜​-‏‪-‮⁠-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : t;
}

/** Posts what's new since the last run to each destination configured in
 *  `feed`. `state` ({ [destination]: { launched: [address], graduated:
 *  [address], fails: { key: n } } }) is kept by the caller between runs;
 *  each destination keeps its own, so one failing never re-posts to the
 *  other. Returns how many posts went out. */
export async function postFeed({ coins, factory, ethers, provider, feed, state, pastDeadline }) {
  const dests = [];
  if (feed.telegramToken && feed.telegramChat) {
    dests.push(["telegram", (text) => post(`https://api.telegram.org/bot${feed.telegramToken}/sendMessage`, { chat_id: feed.telegramChat, text })]);
  }
  // allowed_mentions: a coin named "@everyone" must not ping the server.
  if (feed.discordWebhook) dests.push(["discord", (text) => post(feed.discordWebhook, { content: text, allowed_mentions: { parse: [] } })]);

  const finalized = new Map(); // curveState read once a run per coin
  const isFinalized = async (coin) => {
    if (!finalized.has(coin)) finalized.set(coin, (await factory.curveState(coin)).finalized);
    return finalized.get(coin);
  };
  const texts = new Map();
  const textFor = async (coin, kind) => {
    if (!texts.has(coin)) {
      const t = new ethers.Contract(coin, TOKEN_ABI, provider);
      const [name, symbol, metaRaw] = await Promise.all([t.name(), t.symbol(), t.metadataURI().catch(() => "")]);
      let pitch = "";
      try { pitch = clean(JSON.parse(metaRaw)?.pitch, 200); } catch { /* no metadata */ }
      texts.set(coin, { head: `${clean(name, 64)} ($${clean(symbol, 16)})`, pitch, url: `${SITE}/venture/${ethers.getAddress(coin)}` });
    }
    const { head, pitch, url } = texts.get(coin);
    return kind === "launch"
      ? `New coin: ${head}${pitch ? `\n${pitch}` : ""}\n${url}`
      : `${head} filled its curve and graduated: Uniswap pool open, liquidity locked.\n${url}`;
  };

  let posted = 0;
  for (const [id, send] of dests) {
    const st = state[id] ?? (state[id] = {});
    const launched = new Set(st.launched ?? []);
    const graduated = new Set(st.graduated ?? []);
    const fails = st.fails ?? {};
    let sent = 0;
    for (const coin of coins.map((c) => c.toLowerCase())) {
      if (sent >= PER_RUN || pastDeadline()) break;
      const kind = !launched.has(coin) ? "launch" : !graduated.has(coin) && (await isFinalized(coin)) ? "graduate" : null;
      if (!kind) continue;
      const key = `${kind}:${coin}`;
      try {
        await send(await textFor(coin, kind));
        sent++;
      } catch (e) {
        fails[key] = (fails[key] ?? 0) + 1;
        console.log(`feed ${id}: ${key} failed (${fails[key]}/${GIVE_UP}): ${String(e?.message ?? e).slice(0, 160)}`);
        if (fails[key] < GIVE_UP) break; // retried next run, in order
      }
      delete fails[key];
      (kind === "launch" ? launched : graduated).add(coin);
    }
    posted += sent;
    Object.assign(st, { launched: [...launched], graduated: [...graduated], fails });
  }
  return posted;
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  // The URL holds the bot token or webhook secret: report the host only.
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status} ${(await r.text()).slice(0, 120)}`);
}
