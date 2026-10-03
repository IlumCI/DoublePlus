const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const fix = require(require("path").resolve(process.env.FIXTURE ?? "hostile.json"));
const VALUES = ["0", "0.", ".", "..", "1.2.3", "-1", "1e18", "0.0000000000000000001", "999999999999999999999999999999", "١٢٣", " 5 ", "NaN", "Infinity", "0x10", "1,5", "<script>window.__x=1</script>", "9".repeat(400), "0.".padEnd(300, "1")];
const BAD = /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b/;
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
  const report = [];
  for (const key of ["open-curve", "xss-name", "huge-price", "tiny-price"]) {
    await p.goto("http://localhost:5174/venture/" + fix.coins[key]); await p.waitForTimeout(3500);
    for (const side of ["Buy", "Sell"]) {
      await p.click(`.dp-tb-tabs button:has-text("${side}")`).catch(() => {});
      for (const v of VALUES) {
        const input = p.locator(".dp-tradebox input").first();
        await input.fill(v).catch(() => {});
        await p.waitForTimeout(150);
        const t = await p.locator(".dp-tradebox").innerText();
        const m = t.match(BAD);
        if (m) report.push(`${key} ${side} "${v.slice(0, 20)}": shows ${m[0]} — ${t.slice(Math.max(0, m.index - 40), m.index + 20).replace(/\s+/g, " ")}`);
      }
    }
  }
  // Launch form fields
  await p.goto("http://localhost:5174/launch"); await p.waitForTimeout(2500);
  for (const id of ["#v-name", "#v-sym", "#v-pitch", "#v-site", "#v-x"]) {
    for (const v of ["<img src=x onerror=window.__x=2>", "‮evil", "A".repeat(5000), "javascript:alert(1)"]) await p.fill(id, v).catch(() => {});
  }
  const lt = await p.locator(".lh-client").innerText();
  if (BAD.test(lt)) report.push("launch form shows " + lt.match(BAD)[0]);
  report.push(`page errors: ${errs.length}${errs.length ? " — " + [...new Set(errs)].slice(0, 3).join(" / ") : ""}`, `script ran: ${await p.evaluate(() => window.__x ?? "no")}`);
  await b.close();
  console.log(report.join("\n"));
})();
