import { formatBaseUnit } from "./base-unit";

export interface FetchSolanaBalanceOptions {
  /** The base58 Solana public key address. */
  address: string;
  /** Explicit network ID override. Defaults to 'solana-devnet'. */
  networkId?: "solana-devnet" | "solana-mainnet" | "solana-testnet" | string;
  /** Custom RPC URL override. If omitted, uses default upstream RPC. */
  rpcUrl?: string;
  /** Injected fetch implementation for unit testing or custom environments. */
  fetchImpl?: typeof fetch;
}

export interface SolanaBalanceResult {
  lamports: bigint;
  formatted: string;
  unit: string;
  networkId: "solana-devnet" | "solana-mainnet";
}

export const DEFAULT_SOLANA_RPC_URLS: Record<
  "solana-devnet" | "solana-mainnet",
  string
> = {
  "solana-devnet": "https://api.devnet.solana.com",
  "solana-mainnet": "https://api.mainnet-beta.solana.com",
};

/**
 * Public, read-only Solana balance fetcher by address via standard JSON-RPC.
 * Does not require private keys, custody initialization, or heavy SDK initialization.
 */
export async function fetchSolanaBalance(
  options: FetchSolanaBalanceOptions
): Promise<SolanaBalanceResult> {
  const isTestnet =
    options.networkId === undefined ||
    options.networkId === "solana-devnet" ||
    options.networkId === "solana-testnet" ||
    options.networkId.includes("testnet") ||
    options.networkId.includes("devnet");

  const canonicalNetwork: "solana-devnet" | "solana-mainnet" = isTestnet
    ? "solana-devnet"
    : "solana-mainnet";

  const rpcUrl = options.rpcUrl || DEFAULT_SOLANA_RPC_URLS[canonicalNetwork];
  const unit = isTestnet ? "tSOL" : "SOL";
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  if (!fetchFn) {
    throw new Error("fetch is not available in the current environment");
  }

  const response = await fetchFn(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [options.address, { commitment: "confirmed" }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Solana RPC HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as {
    error?: { message?: string };
    result?: { value?: number | string | bigint };
  };

  if (data.error) {
    throw new Error(data.error.message || "Solana RPC error");
  }

  const rawValue = data.result?.value ?? 0;
  const lamports = BigInt(rawValue);
  const formatted = `${formatBaseUnit(lamports, 9)} ${unit}`;

  return {
    lamports,
    formatted,
    unit,
    networkId: canonicalNetwork,
  };
}
