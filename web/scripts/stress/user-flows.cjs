const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const fs = require("fs");
const fix = require(require("path").resolve(process.env.FIXTURE ?? "hostile.json"));
const BASE = "http://localhost:5174";
const W1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";   // creator (#1)
const TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // #2, traded in the fixture
const node = (method, params) => fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const only = process.argv[2];
let browser;
async function session(name, { account = W1, width = 1440, init = "" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript({ content: fs.readFileSync(__dirname + "/mock-wallet.js", "utf8").replace('account: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"', `account: "${account}"`) + "\n" + init });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  return { ctx, p, errs };
}
async function connect(p) {
  await p.click("button:has-text('Connect wallet')", { timeout: 15000 });
  await p.getByText("Mock Wallet").first().click({ timeout: 10000 });
  await p.waitForFunction(() => document.querySelector(".lh-addr")?.innerText.includes("0x"), null, { timeout: 15000 });
}
const toasts = (p) => p.evaluate(() => window.__toasts.slice());
const W = (p, js, arg) => p.evaluate(js, arg);
const report = [];
const log = (name, ...lines) => { report.push(`## ${name}`, ...lines.map((l) => "   " + l)); console.log(`## ${name}\n` + lines.map((l) => "   " + l).join("\n")); };
async function buyBox(p, amt) {
  await p.waitForSelector(".dp-tradebox input", { timeout: 20000 });
  await p.click(".dp-tb-tabs button:has-text('Buy')", { force: true });
  await p.fill(".dp-tradebox input", amt, { force: true });
  await p.waitForTimeout(600);
}
const goBtn = (p) => p.locator(".dp-tradebox .dp-tb-go");
const scenarios = {
  async happyBuy() {
    const { ctx, p, errs } = await session("happy");
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await connect(p);
    await buyBox(p, "0.01");
    await goBtn(p).click({ force: true });
    await p.waitForTimeout(6000);
    const bag = await p.locator(".dp-bag").innerText().catch(() => "(no bag line)");
    log("buy 0.01 ETH on an open curve", `toasts: ${JSON.stringify(await toasts(p))}`, `txs: ${(await W(p, () => window.__wallet.txs.length))}`, `bag line: ${bag.replace(/\s+/g, " ")}`, `button now: ${await goBtn(p).innerText()}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async rejected() {
    const { ctx, p, errs } = await session("reject");
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await connect(p);
    await buyBox(p, "0.01");
    await W(p, () => { window.__wallet.reject = true; });
    await goBtn(p).click({ force: true }); await p.waitForTimeout(2500);
    log("user rejects the buy in the wallet", `toasts: ${JSON.stringify(await toasts(p))}`, `button now: ${await goBtn(p).innerText()}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async doubleClick() {
    const { ctx, p } = await session("double");
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await connect(p);
    await buyBox(p, "0.003");
    for (let i = 0; i < 6; i++) await goBtn(p).click({ force: true, noWaitAfter: true }).catch(() => {});
    await p.waitForTimeout(6000);
    log("mashes Buy 6 times", `transactions sent: ${await W(p, () => window.__wallet.txs.length)}`, `toasts: ${JSON.stringify(await toasts(p))}`);
    await ctx.close();
  },
  async broke() {
    const poor = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // #3
    await node("hardhat_setBalance", [poor, "0x" + (10n ** 15n).toString(16)]); // 0.001 ETH
    const { ctx, p, errs } = await session("poor", { account: poor });
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await connect(p);
    await buyBox(p, "0.05");
    const label = await goBtn(p).innerText(); const disabled = await goBtn(p).isDisabled();
    await buyBox(p, "0.00099");
    await goBtn(p).click().catch(() => {}); await p.waitForTimeout(3500);
    log("wallet with 0.001 ETH", `0.05 ETH buy button: "${label}" disabled=${disabled}`, `0.00099 ETH (leaves nothing for gas): toasts ${JSON.stringify(await toasts(p))}`, `page errors: ${errs.length}`);
    await node("hardhat_setBalance", [poor, "0x" + (10n ** 22n).toString(16)]);
    await ctx.close();
  },
  async wrongChain() {
    const { ctx, p, errs } = await session("chain");
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await connect(p);
    await W(p, () => window.__wallet.setChain(1)); await p.waitForTimeout(1500);
    const bar = await p.locator(".lh-infobar").innerText().catch(() => "(no network bar)");
    await buyBox(p, "0.01"); await goBtn(p).click({ force: true }); await p.waitForTimeout(3000);
    const t1 = await toasts(p);
    await W(p, () => { window.__wallet.rejectSwitch = true; });
    await p.click(".lh-infobar button").catch(() => {}); await p.waitForTimeout(1500);
    const t2 = (await toasts(p)).slice(t1.length);
    await W(p, () => { window.__wallet.rejectSwitch = false; });
    await p.click(".lh-infobar button").catch(() => {}); await p.waitForTimeout(2000);
    const barAfter = await p.locator(".lh-infobar").count();
    log("wallet on Ethereum mainnet", `bar: ${bar.replace(/\s+/g, " ")}`, `buy attempt toasts: ${JSON.stringify(t1)}`, `switch rejected toasts: ${JSON.stringify(t2)}`, `bar gone after switching: ${barAfter === 0}`, `txs sent while on wrong chain: ${await W(p, () => window.__wallet.txs.length)}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async accountSwap() {
    const { ctx, p, errs } = await session("swap");
    await p.goto(BASE + "/venture/" + fix.coins["xss-name"]); await connect(p);
    await p.waitForTimeout(2500);
    const before = await p.locator(".lh-addr .lh-wallet, .lh-addr button").last().innerText();
    await W(p, (a) => window.__wallet.setAccount(a), TRADER); await p.waitForTimeout(4000);
    console.log("   debug sent after swap:", await W(p, () => window.__wallet.sent.slice(-12).join(",")), "| W.account", await W(p, () => window.__wallet.account), "connected", await W(p, () => window.__wallet.connected));
    const after = await p.locator(".lh-addr .lh-wallet, .lh-addr button").last().innerText();
    const bag = await p.locator(".dp-bag").innerText().catch(() => "(no bag line)");
    await W(p, () => window.__wallet.setAccount(null)); await p.waitForTimeout(2500);
    const gone = await p.locator(".lh-addr .lh-wallet, .lh-addr button").last().innerText();
    log("switches accounts, then disconnects, in the wallet", `wallet button: ${before.trim()} -> ${after.trim()} -> ${gone.trim()}`, `bag line for new account: ${bag.replace(/\s+/g, " ")}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async hang() {
    const { ctx, p, errs } = await session("hang");
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await connect(p);
    await buyBox(p, "0.01");
    await W(p, () => { window.__wallet.hang = true; });
    await goBtn(p).click({ force: true }); await p.waitForTimeout(3000);
    const stuck = await goBtn(p).innerText();
    await p.click("text=Coins"); await p.waitForTimeout(1500);
    await p.goBack(); await p.waitForTimeout(3000);
    await W(p, () => { window.__wallet.hang = false; });
    await buyBox(p, "0.01");
    const after = await goBtn(p).innerText();
    await goBtn(p).click().catch(() => {}); await p.waitForTimeout(5000);
    log("wallet never answers, user wanders off and comes back", `button while waiting: "${stuck}"`, `button after coming back: "${after}"`, `retry toasts: ${JSON.stringify(await toasts(p))}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async frontrun() {
    const { ctx, p, errs } = await session("frontrun");
    await p.goto(BASE + "/venture/" + fix.coins["open-curve"]); await connect(p);
    await buyBox(p, "0.002");
    await p.selectOption(".dp-tradebox select.dp-slip", "100");
    await W(p, () => { window.__wallet.frontrun = "0x" + (10n ** 16n * 3n).toString(16); window.__wallet.forceGas = "0x2DC6C0"; }); // 0.03 ETH lands first; ours is mined anyway
    await goBtn(p).click({ force: true }); await p.waitForTimeout(6000);
    const h = await W(p, () => window.__wallet.txs.at(-1));
    const rc = h ? (await node("eth_getTransactionReceipt", [h])).result : null;
    log("someone else's bigger buy lands first (1% slippage)", `user tx status on-chain: ${rc ? rc.status : "none"}`, `toasts shown: ${JSON.stringify(await toasts(p))}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async sellFlow() {
    const { ctx, p, errs } = await session("sell", { account: TRADER });
    await p.goto(BASE + "/venture/" + fix.coins["unicode"]); await connect(p);
    await p.waitForSelector(".dp-tradebox", { timeout: 20000 });
    await p.click(".dp-tb-tabs button:has-text('Sell')", { force: true, timeout: 8000 }).catch((e) => console.log('   sell tab:', e.message.split('\n')[0])); console.log('   tabs:', await p.locator('.dp-tb-tabs').innerText().catch(() => 'no tabs'), '| panel head:', (await p.locator('.dp-tradebox').innerText().catch(() => '')).slice(0, 80).replace(/\s+/g, ' '));
    await p.click(".dp-quicks button:has-text('50%')").catch(() => {});
    await p.waitForTimeout(800);
    const quote = await p.locator(".dp-tb-est").innerText().catch(() => "");
    await W(p, () => { window.__wallet.reject = true; });
    await goBtn(p).click({ force: true }); await p.waitForTimeout(2500);
    const t1 = await toasts(p);
    await W(p, () => { window.__wallet.reject = false; });
    await goBtn(p).click({ force: true }); await p.waitForTimeout(7000);
    log("sells half back to the curve (rejects once first)", `quote: ${quote.replace(/\s+/g, " ")}`, `after reject: ${JSON.stringify(t1)}`, `after retry: ${JSON.stringify((await toasts(p)).slice(t1.length))}`, `txs: ${await W(p, () => window.__wallet.txs.length)}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async refund() {
    const { ctx, p, errs } = await session("refund", { account: TRADER });
    await p.goto(BASE + "/venture/" + fix.coins["dead-raise"]); await connect(p);
    await p.waitForTimeout(3000);
    const panel = await p.locator(".dp-tradebox").innerText().catch(() => "(no panel)");
    const btn = p.locator(".dp-tradebox button.dp-tb-go");
    if (await btn.count()) { await btn.click({ force: true }); await p.waitForTimeout(8000); }
    log("refund from a failed raise, on the coin page", `panel: ${panel.replace(/\s+/g, " ").slice(0, 200)}`, `toasts: ${JSON.stringify(await toasts(p))}`, `txs: ${await W(p, () => window.__wallet.txs.length)}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
  async portfolio() {
    const { ctx, p, errs } = await session("desk", { account: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" }); // #4
    await p.goto(BASE + "/desk"); await connect(p); await p.waitForTimeout(8000);
    const t = await p.locator(".lh-client").innerText();
    const btn = p.locator("button:has-text('back')").first();
    let after = "";
    if (await btn.count()) { await btn.click({ force: true }); await p.waitForTimeout(9000); after = JSON.stringify(await toasts(p)); }
    log("portfolio of a trader with a failed raise", `page: ${t.replace(/\s+/g, " ").slice(0, 420)}`, `refund from table: ${after || "(no refund button)"}`, `page errors: ${errs.length}`);
    await ctx.close();
  },
};
(async () => {
  browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  for (const [k, f] of Object.entries(scenarios)) {
    if (only && k !== only) continue;
    try { await f(); } catch (e) { log(k, "SCENARIO CRASHED: " + e.message.split("\n")[0].slice(0, 200)); }
  }
  await browser.close();
  fs.writeFileSync(__dirname + "/report.txt", report.join("\n"));
})();
