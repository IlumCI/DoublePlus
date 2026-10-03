const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const fs = require("fs");
const fix = require(require("path").resolve(process.env.FIXTURE ?? "hostile.json"));
const BASE = "http://localhost:5174";
const LAUNCHER = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"; // #5
let browser;
const only = process.argv[2];
async function session({ account = LAUNCHER, width = 1440, init = "", offlineAfter = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript({ content: init + "\n" + fs.readFileSync(__dirname + "/mock-wallet.js", "utf8").replace('account: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"', `account: "${account}"`) });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
  return { ctx, p, errs };
}
async function connect(p) {
  await p.click("button:has-text('Connect wallet')", { timeout: 15000 });
  await p.getByText("Mock Wallet").first().click({ timeout: 10000 });
  await p.waitForFunction(() => /0x/.test(document.querySelector(".lh-addr")?.innerText ?? ""), null, { timeout: 15000 });
}
const toasts = (p) => p.evaluate(() => window.__toasts.slice());
const out = (t, ...l) => console.log(`## ${t}\n` + l.map((x) => "   " + x).join("\n"));
const S = {
  async launch() {
    const { ctx, p, errs } = await session();
    const step = (m) => console.log("   step:", m);
    await p.goto(BASE + "/launch"); step("loaded"); await connect(p); step("connected");
    await p.setInputFiles("input[type=file]", (process.env.NOISY_PNG ?? __dirname + "/noisy.png")).catch((e) => errs.push("upload: " + e.message));
    await p.waitForTimeout(2500);
    const logoLen = await p.evaluate(() => document.querySelector(".dp-logodrop img")?.getAttribute("src")?.length ?? 0);
    step("logo " + (await p.evaluate(() => document.querySelector(".dp-logodrop img")?.getAttribute("src")?.length ?? 0)));
    await p.fill("#v-name", "Wild West Three"); await p.fill("#v-sym", "wwt3"); await p.fill("#v-pitch", "Launched by a robot poking at things.");
    const cont = async () => { await p.click("button:has-text('Continue')", { force: true, timeout: 5000 }); await p.waitForTimeout(600); };
    await cont(); await p.fill("#v-target", "2"); await p.waitForTimeout(300); await cont(); await cont();
    step("now at: " + (await p.locator(".dp-form-sheet .dp-sec").first().innerText()).split("\n")[0]);
    const reviewText = await p.locator(".lh-client").innerText();
    await p.check("input[type=checkbox]", { force: true }).catch((e) => errs.push("checkbox: " + e.message.slice(0, 80)));
    const t0 = Date.now();
    await p.click("button[type=submit]", { force: true });
    await p.waitForFunction(() => window.__toasts.some((t) => /is live|failed|Too much/.test(t)), null, { timeout: 240000 }).catch(() => {});
    const took = Date.now() - t0;
    await p.waitForTimeout(4000);
    const url = p.url();
    const board = await p.locator(".lh-client").innerText();
    out("launch a coin through the UI with a 2400x1600 noisy photo as logo",
      `logo after compression: ${logoLen} chars`,
      `review mentions: ${/Review/.test(reviewText) ? "ok" : "no review step?"}`,
      `toasts: ${JSON.stringify(await toasts(p))} after ${took} ms`,
      `ended on: ${url.replace(BASE, "")}, new coin on board: ${board.includes("Wild West Three")}`,
      `page errors: ${errs.length} ${errs.slice(0, 2).join(" / ")}`);
    await ctx.close();
  },
  async noStorage() {
    const init = `(() => { const boom = () => { throw new DOMException("blocked", "SecurityError"); };
      for (const k of ["getItem","setItem","removeItem","clear","key"]) Storage.prototype[k] = boom;
      Object.defineProperty(window, "localStorage", { get: boom, configurable: true }); Object.defineProperty(window, "sessionStorage", { get: boom, configurable: true }); })();`;
    const { ctx, p, errs } = await session({ init, account: "0x976EA74026E726554dB657fA54763abd0C3a0aa9" });
    const pages = ["/", "/venture/" + fix.coins["open-curve"], "/desk", "/launch", "/stats"];
    const lens = [];
    for (const u of pages) { await p.goto(BASE + u); await p.waitForTimeout(3500); lens.push(`${u.slice(0, 20)}:${(await p.locator("body").innerText()).length}`); }
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await p.waitForTimeout(2000);
    let conn = "ok"; await connect(p).catch((e) => conn = e.message.split("\n")[0].slice(0, 80));
    await p.click(".dp-bell", { force: true }).catch(() => {});
    await p.waitForTimeout(800);
    out("browser that blocks all storage", `pages rendered (text length): ${lens.join("  ")}`, `connect: ${conn}`, `alert toggle: ${await p.locator(".dp-bell").innerText().catch(() => "?")}`, `page errors: ${errs.length} ${[...new Set(errs)].slice(0, 3).join(" / ")}`);
    await ctx.close();
  },
  async clockSkew() {
    for (const [label, ms] of [["1 hour behind", -3600e3], ["1 day ahead", 86400e3]]) {
      const init = `(() => { const off = ${ms}; const N = Date.now; Date.now = () => N() + off; const D = Date; window.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(N() + off); } static now() { return N() + off; } }; })();`;
      const { ctx, p, errs } = await session({ init });
      // A fresh launch to see the launch window, launched on-chain now.
      await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await p.waitForTimeout(3500);
      const box = (await p.locator(".dp-tradebox").innerText().catch(() => "")).replace(/\s+/g, " ");
      const head = (await p.locator(".dp-coinhead .dp-prov").innerText().catch(() => "")).replace(/\s+/g, " ");
      out(`device clock ${label}`, `coin age shown: ${head.slice(0, 80)}`, `trade box mentions launch window: ${/Just launched|First minute/.test(box)}`, `page errors: ${errs.length}`);
      await ctx.close();
    }
  },
  async offlineMidTrade() {
    const { ctx, p, errs } = await session({ account: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" });
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await connect(p);
    await p.fill(".dp-tradebox input", "0.002", { force: true }); await p.waitForTimeout(600);
    await ctx.setOffline(true);
    await p.locator(".dp-tradebox .dp-tb-go").click({ force: true }); await p.waitForTimeout(6000);
    const t1 = await toasts(p);
    const btn = await p.locator(".dp-tradebox .dp-tb-go").innerText();
    await ctx.setOffline(false); await p.waitForTimeout(12000);
    const after = (await p.locator(".lh-client").innerText()).length;
    out("network drops right as the user hits Buy", `toasts: ${JSON.stringify(t1)}`, `button: ${btn}`, `page after reconnect has content: ${after > 500}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async tinyScreen() {
    const { ctx, p, errs } = await session({ width: 320 });
    const res = [];
    for (const u of ["/", "/venture/" + fix.coins["huge"], "/venture/" + fix.coins["open-curve"], "/launch", "/desk", "/docs"]) {
      await p.goto(BASE + u); await p.waitForTimeout(3500);
      const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      res.push(`${u.slice(0, 22)} overflow ${ov}px`);
    }
    out("320px-wide phone", ...res, `page errors: ${errs.length}`);
    await ctx.close();
  },
};
(async () => {
  browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  for (const [k, f] of Object.entries(S)) { if (only && k !== only) continue; try { await f(); } catch (e) { out(k, "SCENARIO CRASHED: " + e.message.split("\n")[0].slice(0, 200)); } }
  await browser.close();
})();
