import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Official token launch: same flow as launch-test-final but with on-chain
// metadata (logo + social links) baked into the token.
const NAME = process.env.T_NAME ?? "Toebeans";
const SYMBOL = process.env.T_SYMBOL ?? "BEANS";
const PAIR = process.env.T_PAIR ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; // WETH
const USD8 = BigInt(process.env.T_USD8 ?? "186322000000");
const TAX = Number(process.env.T_TAX ?? "100");

// Jelly-bean paw mark (glossy pink on peach) as a compact SVG data URI.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><radialGradient id="bg" cx="50%" cy="14%" r="100%"><stop offset="0" stop-color="#ffe8d6"/><stop offset=".6" stop-color="#ffd9bd"/><stop offset="1" stop-color="#f7b98f"/></radialGradient><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb3c7"/><stop offset=".5" stop-color="#ff7fa4"/><stop offset="1" stop-color="#e5486f"/></linearGradient><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="256" height="256" fill="url(#bg)"/><g transform="rotate(-18 66 89)"><ellipse cx="66" cy="89" rx="23.5" ry="30" fill="url(#p)"/><ellipse cx="60" cy="78" rx="13" ry="9" fill="url(#g)" opacity=".8"/></g><g transform="rotate(-6 110 64)"><ellipse cx="110" cy="64" rx="23.5" ry="31" fill="url(#p)"/><ellipse cx="105" cy="52" rx="13" ry="9" fill="url(#g)" opacity=".8"/></g><g transform="rotate(7 156 66)"><ellipse cx="156" cy="66" rx="23.5" ry="31" fill="url(#p)"/><ellipse cx="152" cy="54" rx="13" ry="9" fill="url(#g)" opacity=".8"/></g><g transform="rotate(19 196 93)"><ellipse cx="196" cy="93" rx="23" ry="29.5" fill="url(#p)"/><ellipse cx="192" cy="82" rx="12" ry="8.5" fill="url(#g)" opacity=".8"/></g><path d="M128 108 C168 108 201 137 201 170 C201 202 168 218 128 218 C88 218 55 202 55 170 C55 137 88 108 128 108 Z" fill="url(#p)"/><ellipse cx="100" cy="132" rx="32" ry="15" fill="url(#g)" opacity=".7"/></svg>`;
const LOGO = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString("base64")}`;

const METADATA = JSON.stringify({
  description:
    "The official token of toebeans.fun, the launch-to-earn launchpad on Robinhood Chain. Every coin trades against ETH with a flat 1% fee: 80% to the creator in ETH, 5% builds a real bid wall under the price, and snipers pay extra straight into the wall. Every coin lands on its feet.",
  logo: LOGO,
  website: "https://www.toebeans.fun",
  twitter: "https://x.com/Toebeans_fun",
  telegram: "",
});

async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/robinhood-hood.json"), "utf8"));
  const factoryAddr = dep.contracts.factory as string;
  const factory = await ethers.getContractAt("HoodFactory", factoryAddr);
  const params = { name: NAME, symbol: SYMBOL, metadataURI: METADATA, pair: PAIR, taxBps: TAX, pairUsdPrice8: USD8 };
  const salt = ethers.hexlify(ethers.randomBytes(32));
  await (await factory.launch(params, salt)).wait();
  const coin = await factory.allTokens((await factory.totalTokens()) - 1n);
  console.log(`${SYMBOL}: ${coin}  pair=${PAIR}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
