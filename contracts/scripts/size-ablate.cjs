// Bytecode cost of each feature, by ablation: recompile the contract with a
// group of function bodies replaced by `revert()` and report how much smaller
// the runtime code gets. Groups overlap where they share helpers, so rows sum
// to a little more than the whole. Run after `npx hardhat compile`:
//
//   node scripts/size-ablate.cjs factory
//   node scripts/size-ablate.cjs hook
//
// See docs/contract-sizes.md for the last recorded results.
const TARGETS = {
  factory: { file: "contracts/v4/venture/VentureFactory.sol", name: "VentureFactory", groups: {
      "launch (validation, curve setup, vesting, token deploy)": [
          "launch"
      ],
      "graduation (pool create, price math, liquidity add)": [
          "_graduate",
          "finalize",
          "unlockCallback"
      ],
      "curve buy+sell, keeping graduation reachable": [
          "buy",
          "sell"
      ],
      "failed-raise path (abort, refund, refundMany, sweep)": [
          "abort",
          "refund",
          "refundMany",
          "sweepUnclaimed"
      ],
      "refundMany alone": [
          "refundMany"
      ],
      "curve fee split + withdraw": [
          "_splitCurveFee",
          "withdrawFees"
      ],
      "admin (setParams, pause, resume)": [
          "setParams",
          "pause",
          "resume"
      ],
      "views (curveState, terms, tokensByCreator)": [
          "curveState",
          "terms",
          "tokensByCreator"
      ],
      "EVERY function body at once": [
          "launch",
          "_graduate",
          "finalize",
          "unlockCallback",
          "buy",
          "sell",
          "curveCost",
          "tokensForValue",
          "priceNow",
          "abort",
          "refund",
          "refundMany",
          "sweepUnclaimed",
          "_splitCurveFee",
          "withdrawFees",
          "setParams",
          "pause",
          "resume",
          "curveState",
          "terms",
          "tokensByCreator",
          "_reached",
          "_feeFor",
          "_accrue",
          "_poolStart",
          "_settleNegative",
          "totalTokens"
      ]
  } },
  hook: { file: "contracts/v4/venture/VentureFeeHook.sol", name: "VentureFeeHook", groups: {
      "last-buyer pot (_payPot, claimPot, pot view)": [
          "_payPot",
          "claimPot",
          "pot"
      ],
      "wall recenter (recenter, unlockCallback, poolTick)": [
          "recenter",
          "unlockCallback",
          "poolTick"
      ],
      "quote walls + auto-liquidity bands (_placeQuotes, _addBand)": [
          "_placeQuotes",
          "_addBand"
      ],
      "in-pool conversions (_convert)": [
          "_convert"
      ],
      "holder dividends (_payDividends)": [
          "_payDividends"
      ],
      "bucket split (_settleBuckets)": [
          "_settleBuckets"
      ],
      "referrals (setReferrer)": [
          "setReferrer"
      ],
      "config (registerPool, setDevWallet, policyOf)": [
          "registerPool",
          "setDevWallet",
          "policyOf"
      ],
      "unused IHooks stubs (must exist)": [
          "afterInitialize",
          "beforeAddLiquidity",
          "afterAddLiquidity",
          "beforeRemoveLiquidity",
          "afterRemoveLiquidity",
          "beforeSwap",
          "beforeDonate",
          "afterDonate"
      ],
      "whole afterSwap fee engine": [
          "afterSwap"
      ]
  } },
};
const T = TARGETS[process.argv[2] ?? "factory"];
if (!T) throw new Error("usage: size-ablate.cjs factory|hook");
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const SOLC = process.env.SOLC ?? `${process.env.HOME}/.cache/hardhat-nodejs/compilers-v2/linux-amd64/solc-linux-amd64-v0.8.26+commit.8a97fa7a`;
const FILE = T.file, NAME = T.name;
const dir = "artifacts/" + FILE;
const bi = JSON.parse(fs.readFileSync(path.join(dir, JSON.parse(fs.readFileSync(`${dir}/${NAME}.dbg.json`)).buildInfo)));
const input = bi.input;
input.settings.outputSelection = { [FILE]: { [NAME]: ["evm.deployedBytecode.object"] } };
const src = input.sources[FILE].content;
const buf = Buffer.from(src, "utf8");
const ast = bi.output.sources[FILE].ast;
const cases = [];
const contract = ast.nodes.find((n) => n.nodeType === "ContractDefinition" && n.name === NAME);
const stub = (names) => contract.nodes.filter((n) => n.nodeType === "FunctionDefinition" && names.includes(n.name || n.kind) && n.body)
  .map((n) => { const [st, len] = n.body.src.split(":").map(Number); return [st, st + len, "{ revert(); }"]; });
const GROUPS = T.groups;
for (const [name, fns] of Object.entries(GROUPS)) cases.push({ name, edits: stub(fns) });
// Every public state variable demoted to internal: the cost of the getters.
const pubs = contract.nodes.filter((n) => n.nodeType === "VariableDeclaration" && n.visibility === "public");
cases.push({ name: `ALL ${pubs.length} public getters`, edits: pubs.map((n) => {
  const [st, len] = n.src.split(":").map(Number);
  const text = buf.slice(st, st + len).toString();
  const i = text.indexOf(" public ");
  return [st + i, st + i + 8, " internal "];
}) });
function size(edits) {
  let b = buf;
  for (const [s, e, r] of [...edits].sort((x, y) => y[0] - x[0])) b = Buffer.concat([b.slice(0, s), Buffer.from(r), b.slice(e)]);
  const inp = JSON.parse(JSON.stringify(input)); inp.sources[FILE].content = b.toString();
  return new Promise((res) => {
    const p = spawn(SOLC, ["--standard-json"]); let out = "";
    p.stdout.on("data", (d) => (out += d)); p.on("close", () => {
      const j = JSON.parse(out); const errs = (j.errors || []).filter((e) => e.severity === "error");
      if (errs.length) return res(`ERR ${errs[0].message.slice(0, 60)}`);
      res(j.contracts[FILE][NAME].evm.deployedBytecode.object.length / 2);
    });
    p.stdin.end(JSON.stringify(inp));
  });
}
(async () => {
  const base = await size([]);
  const results = []; let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < cases.length) { const c = cases[i++]; const s = await size(c.edits); results.push([c.name, typeof s === "number" ? base - s : s]); }
  }));
  console.log("base", base);
  results.sort((a, b) => (typeof b[1] === "number" ? b[1] : -1) - (typeof a[1] === "number" ? a[1] : -1));
  for (const [n, d] of results) console.log(String(d).padStart(6), n);
})();
