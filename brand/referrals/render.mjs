// Renders referral-card.html to doubleplus-referrals.png (1600x900 at 2x).
// Needs playwright-core and a Chromium; pass its path as CHROME if it isn't
// Playwright's own install.
import { chromium } from "playwright-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch({ executablePath: process.env.CHROME });
const pg = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await pg.goto(`file://${join(here, "referral-card.html")}`);
await pg.evaluate(() => document.fonts.ready);
await pg.waitForTimeout(300);
await pg.screenshot({ path: join(here, "doubleplus-referrals.png") });
await b.close();
