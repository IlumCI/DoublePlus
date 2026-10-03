# Frontend stress kit

Hostile coins on a local chain, then the site crawled and abused in a real
browser. Run before a release.

1. `cd contracts && npx hardhat node`
2. `npx hardhat run scripts/hostile-venture.ts --network localhost > hostile.json`
   (script names, javascript: links, non-JSON / null / array metadata,
   prototype keys, 400-char names, right-to-left overrides, absurd prices,
   150 filler coins, ~290 trades)
3. Install Multicall3 on the node (the site batches reads through it):
   copy `eth_getCode` of `0xcA11bde05977b3631167028862bE2a173976CA11` from any
   chain into the node with `hardhat_setCode`.
4. Start the site against it with the addresses from hostile.json
   (`VITE_CHAIN_ID=31337`, `VITE_RPC_URL=http://127.0.0.1:8545`,
   `VITE_VENTURE_*`, `VITE_VENTURE_API_URL=` empty) on port 5174.
5. `FIXTURE=hostile.json node web/scripts/stress/crawl.cjs`: every page at
   1440 and 390 px; flags script execution, prototype pollution, overflow,
   visible NaN/undefined/[object Object], empty pages, page errors.
   `chaos.cjs`: RPC down / slow / garbage, 60 rapid navigations, heap over
   two minutes. `inputs.cjs`: junk and extreme values in every amount and
   launch field.

Needs `playwright` (set `PLAYWRIGHT` to its path if it isn't resolvable, and
`CHROME` to a Chrome binary if Playwright's own isn't installed).
