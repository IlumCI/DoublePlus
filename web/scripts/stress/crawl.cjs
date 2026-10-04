const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const fix = require(require("path").resolve(process.env.FIXTURE ?? "hostile.json"));
const BASE = "http://localhost:5174";
const pages = ["/", "/?sort=mcap", "/?show=raising", "/launch", "/desk", "/rewards", "/stats", "/docs", "/legal",
  ...Object.entries(fix.coins).flatMap(([k, a]) => [`/venture/${a}`, `/venture/${a}?tab=backers`, `/venture/${a}?tab=updates`, `/venture/${a}?tab=terms`]),
  "/venture/0x0000000000000000000000000000000000000000", "/venture/not-an-address", "/venture/0xDEADBEEF", "/venture/%3Cscript%3E", "/does/not/exist?q=%3Cimg%20src=x%20onerror=window.__xss=99%3E",
  "/?q=%3Cimg%20src%3Dx%20onerror%3Dwindow.__xss%3D98%3E", "/?sort=__proto__&show=constructor&dir=asc"];
const BAD = /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|-Infinity/;
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const findings = [];
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript(() => {
      let v; Object.defineProperty(window, "__xss", { configurable: true, get: () => v, set: (x) => { v = x; console.error("XSS_FIRED " + x); } });
    });
    const p = await ctx.newPage();
    let errs = [];
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 160)));
    p.on("console", (m) => { if (m.type() === "error" && !/favicon|ERR_|net::|WebSocket|walletconnect|reown|Failed to load resource|429|cca-supply/i.test(m.text())) errs.push("console: " + m.text().slice(0, 160)); });
    for (const path of pages) {
      errs = [];
      const t0 = Date.now();
      await p.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => errs.push("goto: " + e.message.slice(0, 80)));
      await p.waitForTimeout(path === "/" ? 5000 : 2500);
      const r = await p.evaluate((bad) => {
        const main = document.querySelector(".lh-client") || document.body;
        const text = main.innerText;
        const m = text.match(new RegExp(bad));
        return {
          xss: window.__xss,
          polluted: ({}).polluted,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          wideEls: [...document.querySelectorAll(".lh-client *")].filter((e) => e.getBoundingClientRect().right > (document.querySelector(".lh-client")?.getBoundingClientRect().right ?? innerWidth) + 2 && !e.closest(".dp-ticker,.dp-tabbar,.dp-blotter,.lh-cmdbar,.lh-list,canvas,.klinecharts-pro")).slice(0, 2).map((e) => e.tagName + "." + [...e.classList].slice(0, 2).join(".")),
          bad: m ? text.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, " ") : null,
          len: text.length,
        };
      }, BAD.source);
      const ms = Date.now() - t0;
      const issues = [];
      if (r.xss !== undefined) issues.push(`XSS fired (${r.xss})`);
      if (r.polluted) issues.push("prototype polluted");
      if (r.overflow > 1) issues.push(`page overflow ${r.overflow}px`);
      if (r.wideEls.length) issues.push(`overflowing ${r.wideEls.join(",")}`);
      if (r.bad) issues.push(`shows "${r.bad}"`);
      if (r.len < 40) issues.push("near-empty page");
      issues.push(...errs);
      if (issues.length) findings.push(`[${w}] ${path.slice(0, 70)}: ${issues.join(" | ")}`);
    }
    await ctx.close();
  }
  await b.close();
  console.log(findings.length ? findings.join("\n") : "NO FINDINGS");
})();
