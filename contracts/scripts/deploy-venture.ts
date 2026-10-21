import { deployVentureStack } from "./lib/venture-stack";

// Venture (doubleplus) launchpad deploy. Env and network setup are documented
// in scripts/lib/venture-stack.ts.
deployVentureStack().catch((e) => { console.error(e); process.exit(1); });
