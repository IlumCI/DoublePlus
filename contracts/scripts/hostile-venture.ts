import { ethers, network } from "hardhat";

// Frontend stress fixture. Deploys the venture stack on a local node and
// launches coins whose creator-controlled fields are hostile: script in names,
// javascript: links, non-JSON and wrongly typed metadata, prototype keys,
// huge and unicode-tricky strings, absurd prices, plus a crowd of filler
// coins and trades. The web app is then pointed at this node and crawled
// (web/scripts/stress-crawl.mjs). Vanity is off so launches are instant.
//
//   npx hardhat node &   then   npx hardhat run scripts/hostile-venture.ts --network localhost
//
// Payloads that run set window.__xss, which the crawler watches.

const DAY = 86_400;
const XSS = (n: number) => `<img src=x onerror="window.__xss=${n}">`;

async function main() {
  const [admin, creator, ...rest] = await ethers.getSigners();
  const traders = rest.slice(0, 8);
  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  await weth.waitForDeployment();
  const placeholder = await weth.getAddress();
  const vestingDeployer = await (await ethers.getContractFactory("VestingDeployer")).deploy();
  await vestingDeployer.waitForDeployment();
  const nonce = await ethers.provider.getTransactionCount(admin.address);
  const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });
  const hook = await (await ethers.getContractFactory("VentureFeeHook")).deploy(placeholder, admin.address, predictedFactory, 55, 2000);
  await hook.waitForDeployment();
  const tokenDeployer = await (await ethers.getContractFactory("VentureTokenDeployer")).deploy(predictedFactory);
  await tokenDeployer.waitForDeployment();
  const factory = await (await ethers.getContractFactory("VentureFactory")).deploy(
    admin.address, admin.address, placeholder, await hook.getAddress(), placeholder, placeholder,
    await vestingDeployer.getAddress(), await tokenDeployer.getAddress(), 50, 100, 1n, 0, 1n, 2n ** 63n,
  );
  await factory.waitForDeployment();
  const router = await (await ethers.getContractFactory("VentureRouter")).deploy(placeholder, await factory.getAddress(), placeholder, placeholder);
  await router.waitForDeployment();
  const updates = await (await ethers.getContractFactory("VentureUpdates")).deploy(await factory.getAddress());
  await updates.waitForDeployment();
  const startBlock = await ethers.provider.getBlockNumber();

  const base = {
    pair: placeholder, buyTaxBps: 200, sellTaxBps: 300, devWallet: ethers.ZeroAddress,
    devBps: 4000, dividendBps: 3000, liquidityBps: 1500, mmBps: 1500,
    ethUsdPrice8: 1865n * 10n ** 8n, targetRaiseWei: ethers.parseEther("4"), raiseDurationSecs: 7 * DAY,
    maxBuyWei: 0n, founderRaiseBps: 2000, founderSupplyBps: 1000, vestingSecs: 365 * DAY,
    mode: 0, minHoldForDividends: 0, dividendMode: 0, v3Path: "0x",
  };
  const coins: Record<string, string> = {};
  let salt = 0n;
  async function launch(label: string, name: string, symbol: string, metadataURI: string, over: Record<string, unknown> = {}) {
    const p = { ...base, name, symbol, metadataURI, ...over };
    await (await factory.connect(creator).launch(p, ethers.zeroPadValue(ethers.toBeHex(++salt), 32))).wait();
    coins[label] = await factory.allTokens((await factory.totalTokens()) - 1n);
  }

  // Metadata is stored on-chain, so block gas caps it near ~45 KB; go close.
  const bigLogo = "data:image/png;base64," + "iVBORw0KGgo".padEnd(10_000, "A");
  await launch("xss-name", XSS(1), `<svg/onload=window.__xss=2>`, JSON.stringify({ pitch: XSS(3), description: `</p><script>window.__xss=4</script>${XSS(5)}`, sector: XSS(6) }));
  await launch("js-links", "Link Bait", "LINK", JSON.stringify({
    pitch: "links that should never run", website: "javascript:window.__xss=10", twitter: " javascript:window.__xss=11",
    telegram: "JaVaScRiPt:window.__xss=12", discord: "data:text/html,<script>window.__xss=13</script>",
    github: "https://example.com/\"><img src=x onerror=window.__xss=14>", docs: "vbscript:msgbox",
    logo: "javascript:window.__xss=15", banner: "http://tracker.example/pixel.gif",
  }));
  await launch("svg-logo", "Svg Logo", "SVG", JSON.stringify({
    pitch: "inline svg with script inside", logo: "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=20"><script>window.__xss=21</script><rect width="10" height="10"/></svg>`).toString("base64"),
  }));
  await launch("not-json", "Plain Meta", "PLAIN", "this is not json {{{");
  await launch("json-array", "Array Meta", "ARR", JSON.stringify([1, 2, 3]));
  await launch("json-number", "Number Meta", "NUM", "123456789");
  await launch("json-null", "Null Meta", "NULL", "null");
  await launch("wrong-types", "Typed Wrong", "TYPE", JSON.stringify({ pitch: { nested: true }, description: 42, website: ["https://a.example"], twitter: null, logo: 7, sector: false }));
  await launch("proto", "Proto Keys", "PROTO", '{"__proto__":{"polluted":"yes","pitch":"from proto"},"constructor":{"prototype":{"polluted":"yes"}},"pitch":"proto keys"}');
  await launch("huge", "H".repeat(400), "S".repeat(120), JSON.stringify({ pitch: "word ".repeat(400), description: "Longword".repeat(800), logo: bigLogo }));
  await launch("unicode", "‮gnp.exe مرحبا Z͑͐͗ă̐lgo​​", "\u{1F680}\u{1F680}‮‍", JSON.stringify({ pitch: "‮⁦reversed⁩ \u{1F600}".repeat(30), description: "line\nbreaks\r\nand\ttabs\u0000nul" }));
  await launch("newline-name", "Line\nBreak\nName", "NL\nX", "{}");
  await launch("empty", " ", " ", "");
  await launch("tiny-price", "Tiny Price", "TINY", JSON.stringify({ pitch: "start price at the bottom of the range" }), { ethUsdPrice8: 2n ** 62n, targetRaiseWei: 10n ** 14n });
  await launch("huge-price", "Huge Price", "HUGE", JSON.stringify({ pitch: "a million-ETH target" }), { ethUsdPrice8: 1n * 10n ** 8n, targetRaiseWei: 10n ** 24n, maxBuyWei: 10n ** 24n });
  await launch("open-curve", "Open Curve", "OPEN", JSON.stringify({ pitch: "no target" }), { mode: 1, founderRaiseBps: 0 });
  await launch("dead-raise", "Dead Raise", "DEAD", JSON.stringify({ pitch: "missed its target" }), { raiseDurationSecs: DAY });

  // A crowd, for list and polling performance.
  for (let i = 0; i < 150; i++) await launch(`filler-${i}`, `Filler Coin ${i}`, `F${i}`, JSON.stringify({ pitch: `filler number ${i}` }));

  // Past the launch window, then trading on the hostile coins.
  await network.provider.send("evm_increaseTime", [61]);
  await network.provider.send("evm_mine");
  const targets = ["xss-name", "js-links", "unicode", "huge", "open-curve", "dead-raise", "tiny-price"];
  let trades = 0;
  for (let round = 0; round < 40; round++) {
    for (const t of targets) {
      const who = traders[(round + trades) % traders.length];
      await factory.connect(who).buy(coins[t], 0, { value: ethers.parseEther("0.002") + BigInt(round) * 10n ** 14n })
        .then((x: any) => x.wait()).then(() => trades++).catch(() => undefined);
    }
  }
  // Some sells back.
  for (const t of targets) {
    for (const who of traders) {
      const owned = (await factory.boughtTokens(coins[t], who.address)) / 10n ** 18n;
      if (owned === 0n) continue;
      const erc = await ethers.getContractAt("QuiverToken", coins[t]);
      await (await erc.connect(who).approve(await factory.getAddress(), ethers.MaxUint256)).wait();
      await factory.connect(who).sell(coins[t], owned / 3n + 1n, 0).then((x: any) => x.wait()).then(() => trades++).catch(() => undefined);
    }
  }
  // Hostile founder updates.
  await (await updates.connect(creator).postUpdate(coins["xss-name"], XSS(30))).wait();
  await (await updates.connect(creator).postUpdate(coins["unicode"], "‮update " + "x".repeat(5000))).wait();
  // Kill the dead raise.
  await network.provider.send("evm_increaseTime", [8 * DAY]);
  await network.provider.send("evm_mine");
  await (await factory.abort(coins["dead-raise"])).wait();

  console.log(JSON.stringify({
    chainId: Number((await ethers.provider.getNetwork()).chainId), startBlock,
    factory: await factory.getAddress(), tokenDeployer: await tokenDeployer.getAddress(), hook: await hook.getAddress(),
    router: await router.getAddress(), updates: await updates.getAddress(), weth: placeholder,
    trades, coins: Object.fromEntries(Object.entries(coins).filter(([k]) => !k.startsWith("filler-"))),
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
