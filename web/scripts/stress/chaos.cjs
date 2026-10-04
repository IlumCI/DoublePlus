const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const fix = require(require("path").resolve(process.env.FIXTURE ?? "hostile.json"));
const BASE = "http://localhost:5174";
const RPC = "http://127.0.0.1:8545/**";
async function page(b, w = 1440, h = 900) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  return { ctx, p, errs };
}
const text = (p) => p.evaluate(() => (document.querySelector(".lh-client") || document.body).innerText);
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const out = [];
  // 1) RPC down
  {
    const { ctx, p, errs } = await page(b);
    await p.route(RPC, (r) => r.abort("connectionrefused"));
    await p.goto(BASE + "/"); await p.waitForTimeout(12000);
    const t = await text(p);
    out.push(`rpc down, board: ${/can't reach|try again/i.test(t) ? "shows error + retry" : "NO ERROR SHOWN: " + t.slice(0, 120).replace(/\s+/g, " ")} | pageerrors ${errs.length}`);
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await p.waitForTimeout(10000);
    const t2 = await text(p);
    out.push(`rpc down, coin page: ${t2.slice(0, 100).replace(/\s+/g, " ")} | pageerrors ${errs.length}`);
    await ctx.close();
  }
  // 2) RPC slow (4 s per call)
  {
    const { ctx, p, errs } = await page(b);
    await p.route(RPC, async (r) => { await new Promise((x) => setTimeout(x, 4000)); r.continue(); });
    const t0 = Date.now();
    await p.goto(BASE + "/");
    let shown = 0;
    for (let i = 0; i < 60; i++) { await p.waitForTimeout(500); if (await p.locator(".lh-drow").count() > 0) { shown = Date.now() - t0; break; } }
    out.push(`rpc slow 4s: list visible after ${shown ? shown + "ms" : "NEVER (30s)"} | pageerrors ${errs.length}`);
    await ctx.close();
  }
  // 3) RPC returns garbage
  {
    const { ctx, p, errs } = await page(b);
    await p.route(RPC, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"jsonrpc":"2.0","id":1,"result":"0xZZZ<script>window.__x=1</script>"}' }));
    await p.goto(BASE + "/"); await p.waitForTimeout(10000);
    const t = await text(p);
    out.push(`rpc garbage: ${/can't reach|try again/i.test(t) ? "shows error" : t.slice(0, 100).replace(/\s+/g, " ")} | pageerrors ${errs.length} | x=${await p.evaluate(() => window.__x)}`);
    await ctx.close();
  }
  // 4) Rapid navigation
  {
    const { ctx, p, errs } = await page(b);
    await p.goto(BASE + "/"); await p.waitForTimeout(3000);
    const routes = ["/", "/stats", "/desk", ...Object.values(fix.coins).map((a) => "/venture/" + a), "/launch", "/docs", "/rewards"];
    for (let i = 0; i < 60; i++) {
      const r = routes[i % routes.length];
      await p.evaluate((u) => { history.pushState({}, "", u); dispatchEvent(new PopStateEvent("popstate")); }, r);
      await p.waitForTimeout(80);
    }
    await p.waitForTimeout(4000);
    const t = await text(p);
    out.push(`rapid nav x60: final page len ${t.length} | pageerrors ${errs.length}${errs.length ? " " + errs[0] : ""}`);
    await ctx.close();
  }
  // 5) Memory over 2 minutes on the board (polling every 10-30 s)
  {
    const { ctx, p, errs } = await page(b);
    const cdp = await ctx.newCDPSession(p);
    await p.goto(BASE + "/"); await p.waitForTimeout(8000);
    const heap = async () => { await cdp.send("HeapProfiler.collectGarbage"); return (await p.evaluate(() => performance.memory.usedJSHeapSize)) / 1e6; };
    const h0 = await heap();
    await p.waitForTimeout(120000);
    const h1 = await heap();
    out.push(`heap after 2 min idle on board: ${h0.toFixed(1)} MB -> ${h1.toFixed(1)} MB | pageerrors ${errs.length}`);
    await ctx.close();
  }
  await b.close();
  console.log(out.join("\n"));
})();
