// ABOUTME: Crypto wallet handlers for x402 payment signing using viem.
// ABOUTME: Ports EIP-712/EIP-3009 signing from Rust to JavaScript for the local runtime.

import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import {
  type Hex,
  type Address,
  createPublicClient,
  http,
  encodeFunctionData,
  formatUnits,
  pad,
  toHex,
  isHex,
  getAddress,
} from "viem";
import { base } from "viem/chains";

// ── Constants ─────────────────────────────────────────────────────────

const SEREN_DIR = join(homedir(), ".seren-local");
const WALLET_FILE = join(SEREN_DIR, "data", "crypto-wallet.json");
const USDC_CONTRACT_BASE: Address =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC_URL = "https://mainnet.base.org";

// ── Wallet Storage ────────────────────────────────────────────────────

interface WalletStore {
  privateKey: string;
  walletAddress: string;
}

async function loadStore(): Promise<WalletStore | null> {
  try {
    const data = await readFile(WALLET_FILE, "utf-8");
    return JSON.parse(data) as WalletStore;
  } catch {
    return null;
  }
}

async function saveStore(store: WalletStore): Promise<void> {
  await mkdir(join(SEREN_DIR, "data"), { recursive: true });
  await writeFile(WALLET_FILE, JSON.stringify(store), "utf-8");
}

async function clearStore(): Promise<void> {
  try {
    await writeFile(WALLET_FILE, "{}", "utf-8");
  } catch {
    // File doesn't exist, nothing to clear
  }
}

function loadAccount(store: WalletStore): PrivateKeyAccount {
  let key = store.privateKey;
  if (!key.startsWith("0x")) {
    key = `0x${key}`;
  }
  return privateKeyToAccount(key as Hex);
}

// ── Network Helpers ───────────────────────────────────────────────────

function chainIdFromNetwork(network: string): bigint | null {
  const eip155Match = network.match(/^eip155:(\d+)$/);
  if (eip155Match) return BigInt(eip155Match[1]);

  const map: Record<string, bigint> = {
    base: 8453n,
    "base-sepolia": 84532n,
    ethereum: 1n,
    "ethereum-sepolia": 11155111n,
    avalanche: 43114n,
    "avalanche-fuji": 43113n,
  };
  return map[network] ?? null;
}

// ── Payment Requirement Parsing ───────────────────────────────────────

interface X402ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

interface X402PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

interface ParsedRequirements {
  x402Version: number | null;
  resource: X402ResourceInfo | null;
  options: X402PaymentOption[];
}

function parseRequirements(json: string): ParsedRequirements {
  const body = JSON.parse(json);

  // Prepaid/credits shape
  if (body.minimumRequired !== undefined && body.currentBalance !== undefined) {
    throw new Error("Prepaid payment not supported for wallet signing");
  }

  const version = body.x402Version;
  if (!version) throw new Error("Missing x402Version");

  if (version === 1) {
    const accepts = body.accepts ?? [];
    const first = accepts[0];
    return {
      x402Version: 1,
      resource: first
        ? {
            url: first.resource,
            description: first.description,
            mimeType: first.mimeType ?? "application/json",
          }
        : null,
      options: accepts.map(
        (opt: Record<string, unknown>): X402PaymentOption => ({
          scheme: opt.scheme as string,
          network: opt.network as string,
          asset: opt.asset as string,
          amount: (opt.maxAmountRequired ?? opt.amount) as string,
          payTo: opt.payTo as string,
          maxTimeoutSeconds: opt.maxTimeoutSeconds as number,
          extra: (opt.extra as Record<string, unknown>) ?? {},
        }),
      ),
    };
  }

  if (version === 2) {
    return {
      x402Version: 2,
      resource: body.resource ?? null,
      options: (body.accepts ?? []).map(
        (opt: Record<string, unknown>): X402PaymentOption => ({
          scheme: opt.scheme as string,
          network: opt.network as string,
          asset: opt.asset as string,
          amount: opt.amount as string,
          payTo: opt.payTo as string,
          maxTimeoutSeconds: opt.maxTimeoutSeconds as number,
          extra: (opt.extra as Record<string, unknown>) ?? {},
        }),
      ),
    };
  }

  throw new Error(`Unsupported x402Version: ${version}`);
}

// ── EIP-712 Signing ───────────────────────────────────────────────────

const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function getExtra(
  option: X402PaymentOption,
  ...path: string[]
): string | undefined {
  let current: unknown = option.extra;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

async function signPayload(
  account: PrivateKeyAccount,
  requirements: ParsedRequirements,
  option: X402PaymentOption,
): Promise<{ headerName: string; headerValue: string; x402Version: number }> {
  const chainId = chainIdFromNetwork(option.network);
  if (!chainId) throw new Error(`Unsupported network: ${option.network}`);

  // Resolve verifying contract
  const typedVC = getExtra(
    option,
    "eip712TypedData",
    "domain",
    "verifyingContract",
  );
  if (typedVC && typedVC.toLowerCase() !== option.asset.toLowerCase()) {
    throw new Error(
      `Mismatched verifyingContract (${typedVC}) for asset ${option.asset}`,
    );
  }
  const verifyingContract = getAddress(
    (typedVC ?? option.asset) as Address,
  );

  const domainName =
    getExtra(option, "name") ??
    getExtra(option, "eip712TypedData", "domain", "name") ??
    "USD Coin";
  const domainVersion =
    getExtra(option, "version") ??
    getExtra(option, "eip712TypedData", "domain", "version") ??
    "2";

  // Validity window
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfterStr = getExtra(
    option,
    "eip712TypedData",
    "message",
    "validAfter",
  );
  const validBeforeStr = getExtra(
    option,
    "eip712TypedData",
    "message",
    "validBefore",
  );
  const validAfter = validAfterStr
    ? BigInt(validAfterStr)
    : now - 60n;
  const validBefore = validBeforeStr
    ? BigInt(validBeforeStr)
    : now + BigInt(option.maxTimeoutSeconds);

  // Nonce
  const nonceStr = getExtra(option, "eip712TypedData", "message", "nonce");
  let nonce: Hex;
  if (nonceStr && isHex(nonceStr) && nonceStr.length === 66) {
    nonce = nonceStr as Hex;
  } else {
    nonce = toHex(randomBytes(32), { size: 32 });
  }

  const domain = {
    name: domainName,
    version: domainVersion,
    chainId,
    verifyingContract,
  };

  const message = {
    from: account.address,
    to: getAddress(option.payTo as Address),
    value: BigInt(option.amount),
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await account.signTypedData({
    domain,
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const authorization = {
    from: account.address,
    to: getAddress(option.payTo as Address),
    value: option.amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  const payload =
    requirements.x402Version === 1
      ? {
          x402Version: 1,
          scheme: option.scheme,
          network: option.network,
          payload: { signature, authorization },
        }
      : {
          x402Version: 2,
          resource: requirements.resource,
          accepted: option,
          payload: { signature, authorization },
        };

  const headerValue = Buffer.from(JSON.stringify(payload)).toString("base64");
  const headerName =
    requirements.x402Version === 1 ? "X-PAYMENT" : "PAYMENT-SIGNATURE";

  return {
    headerName,
    headerValue,
    x402Version: requirements.x402Version ?? 2,
  };
}

// ── RPC Handlers ──────────────────────────────────────────────────────

export async function storeCryptoPrivateKey(params: {
  privateKey: string;
}): Promise<string> {
  const { privateKey } = params;
  if (!privateKey) throw new Error("Empty private key");

  let key = privateKey;
  if (!key.startsWith("0x")) {
    key = `0x${key}`;
  }

  // Validate by deriving account
  const account = privateKeyToAccount(key as Hex);
  const address = account.address;

  await saveStore({ privateKey: key, walletAddress: address });

  return address;
}

export async function getCryptoWalletAddress(): Promise<string | null> {
  const store = await loadStore();
  return store?.walletAddress ?? null;
}

export async function clearCryptoWallet(): Promise<void> {
  await clearStore();
}

export async function signX402Payment(params: {
  requirementsJson: string;
}): Promise<{
  headerName: string;
  headerValue: string;
  x402Version: number;
}> {
  const store = await loadStore();
  if (!store?.privateKey) throw new Error("Wallet not configured");

  const account = loadAccount(store);
  const requirements = parseRequirements(params.requirementsJson);

  const option = requirements.options[0];
  if (!option) throw new Error("No x402 payment option in requirements");

  return signPayload(account, requirements, option);
}

export async function getCryptoUsdcBalance(): Promise<{
  balance: string;
  balanceRaw: string;
  network: string;
}> {
  const store = await loadStore();
  if (!store?.walletAddress) throw new Error("Wallet not configured");

  const client = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  });

  const balanceRaw = await client.readContract({
    address: USDC_CONTRACT_BASE,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [store.walletAddress as Address],
  });

  const formatted = formatUnits(balanceRaw, 6);
  // Format to 2 decimal places
  const balance = Number.parseFloat(formatted).toFixed(2);

  return {
    balance,
    balanceRaw: balanceRaw.toString(),
    network: "Base",
  };
}
