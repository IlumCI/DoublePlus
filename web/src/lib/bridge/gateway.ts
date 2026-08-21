import { pad, parseAbi, zeroAddress, type Address, type Hex } from "viem";

/**
 * Circle Gateway bridge plumbing: USDC moves from a source chain (Base) into
 * Circle's GatewayWallet, becomes a unified balance once the deposit
 * finalizes, and is minted on Arc by presenting a signed burn intent to the
 * Gateway API and submitting its attestation to the GatewayMinter.
 *
 * The API is public and CORS-open; there is no key. Arc's mainnet domain (26)
 * is feature-flagged by Circle and may be absent from /v1/info while off.
 */

export const GATEWAY_API = "https://gateway-api.circle.com";
/** Same address on every EVM source chain. */
export const GATEWAY_WALLET: Address = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
/** Same address on every EVM destination chain, including Arc. */
export const GATEWAY_MINTER: Address = "0x2222222d7164433c4C09B0b0D809a9b52C04C205";
/** Arc's Gateway domain id. */
export const ARC_DOMAIN = 26;
/** Native USDC on Arc through its ERC-20 interface. */
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;

export interface SourceChain {
  key: string;
  label: string;
  chainId: number;
  domain: number;
  usdc: Address;
  /** Gateway transfer fee in USDC for this source. */
  feeUsdc: number;
  finalityLabel: string;
  explorerTx: string;
}

export const BASE_SOURCE: SourceChain = {
  key: "base",
  label: "Base",
  chainId: 8453,
  domain: 6,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  feeUsdc: 0.01,
  finalityLabel: "~20 min",
  explorerTx: "https://basescan.org/tx/",
};

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);

export const gatewayWalletAbi = parseAbi(["function deposit(address token, uint256 amount)"]);

export const gatewayMinterAbi = parseAbi([
  "function gatewayMint(bytes attestationPayload, bytes signature)",
]);

/** EIP-712 domain; chain-agnostic by design, so the intent can be signed
 *  without switching networks. */
export const EIP712_DOMAIN = { name: "GatewayWallet", version: "1" } as const;

export const EIP712_TYPES = {
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${GATEWAY_API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${r.status}`);
  }
  if (!r.ok) throw new Error(parsed?.message || parsed?.error || `HTTP ${r.status}`);
  return parsed as T;
}

export interface GatewayDomain {
  chain: string;
  network: string;
  domain: number;
  burnIntentExpirationHeight: string;
}

export async function gatewayDomains(): Promise<GatewayDomain[]> {
  const info = await api<{ domains?: GatewayDomain[] }>("/v1/info");
  return info.domains ?? [];
}

/** Arc bridging is feature-flagged by Circle; absent from /v1/info while off. */
export async function arcGatewayDomain(): Promise<GatewayDomain | null> {
  const domains = await gatewayDomains();
  return domains.find((d) => d.domain === ARC_DOMAIN) ?? null;
}

/** Unified Gateway balance for a depositor on one source domain (USDC raw 6d). */
export async function unifiedBalance(domain: number, depositor: Address): Promise<bigint> {
  const r = await api<{ balances?: Array<{ domain: number; available?: string; balance?: string }> }>(
    "/v1/balances",
    { token: "USDC", sources: [{ domain, depositor }] },
  );
  const b = r.balances?.[0];
  const v = b?.available ?? b?.balance;
  if (!v) return 0n;
  try {
    return BigInt(v);
  } catch {
    return BigInt(Math.round(parseFloat(v) * 1e6));
  }
}

export interface BurnIntent {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: bigint;
    salt: Hex;
    hookData: Hex;
  };
}

const asBytes32 = (a: Address): Hex => pad(a, { size: 32 });

/** Build a burn intent moving `value` (USDC raw 6d) from the source domain to
 *  the user's own address on Arc. `expirationHeight` comes from /v1/info. */
export function buildBurnIntent(
  source: SourceChain,
  user: Address,
  value: bigint,
  expirationHeight: string,
): BurnIntent {
  const salt = `0x${[...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
  return {
    maxBlockHeight: BigInt(expirationHeight) + 5_000n,
    maxFee: BigInt(Math.round(source.feeUsdc * 1e6)),
    spec: {
      version: 1,
      sourceDomain: source.domain,
      destinationDomain: ARC_DOMAIN,
      sourceContract: asBytes32(GATEWAY_WALLET),
      destinationContract: asBytes32(GATEWAY_MINTER),
      sourceToken: asBytes32(source.usdc),
      destinationToken: asBytes32(ARC_USDC),
      sourceDepositor: asBytes32(user),
      destinationRecipient: asBytes32(user),
      sourceSigner: asBytes32(user),
      destinationCaller: asBytes32(zeroAddress),
      value,
      salt,
      hookData: "0x",
    },
  };
}

/** JSON shape the API accepts (bigints stringified). */
export function burnIntentJson(intent: BurnIntent) {
  return {
    maxBlockHeight: intent.maxBlockHeight.toString(),
    maxFee: intent.maxFee.toString(),
    spec: { ...intent.spec, value: intent.spec.value.toString() },
  };
}

export interface Attestation {
  attestation: Hex;
  signature: Hex;
}

/** Exchange a signed burn intent for a mint attestation. */
export async function requestAttestation(intentJson: unknown, signature: Hex): Promise<Attestation> {
  const r = await api<unknown>("/v1/transfer", [{ burnIntent: intentJson, signature }]);
  const first: any = Array.isArray(r) ? r[0] : r;
  if (!first?.attestation || !first?.signature) throw new Error("Transfer response missing attestation.");
  return { attestation: first.attestation, signature: first.signature };
}

/** The API rejects intents whose maxBlockHeight lags its view; it replies with
 *  the height it expects. Parse it so the caller can re-sign once. */
export function expectedHeightFrom(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /expected at least (\d+)/i.exec(msg);
  return m ? m[1] : null;
}
