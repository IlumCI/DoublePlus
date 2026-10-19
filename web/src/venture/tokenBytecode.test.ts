import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { QUIVER_TOKEN_BYTECODE } from "./tokenBytecode";

// The launch form mines its vanity salt against this bytecode. If it drifts
// from the compiled QuiverToken, every launch reverts on the vanity check.
const artifact = path.join(__dirname, "../../../contracts/artifacts/contracts/v4/QuiverToken.sol/QuiverToken.json");

describe("venture token bytecode", () => {
  it.skipIf(!fs.existsSync(artifact))("matches the compiled QuiverToken (regenerate: node web/scripts/venture-bytecode.mjs)", () => {
    const { bytecode } = JSON.parse(fs.readFileSync(artifact, "utf8"));
    expect(QUIVER_TOKEN_BYTECODE.toLowerCase()).toBe(bytecode.toLowerCase());
  });
});
