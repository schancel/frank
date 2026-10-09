import { Address } from "ecash-lib/dist/address/address";
import { ChronikClient } from "chronik-client";
import { formatBaseUnit } from "./base-unit";
import { canonicalEcashNetworkId, EcashNetworkId } from "../ecash-wallet";

export type ChronikUtxoItem = {
  sats?: bigint | number | string;
  value?: bigint | number | string;
};

export interface ChronikScriptClientSeam {
  script: (
    type: string,
    hash: string
  ) => {
    utxos: () => Promise<
      | { utxos?: ReadonlyArray<ChronikUtxoItem> }
      | ReadonlyArray<{ utxos?: ReadonlyArray<ChronikUtxoItem> }>
    >;
  };
}

export interface FetchEcashBalanceOptions {
  /** The eCash cashaddress (e.g. `ectest:q...` or `ecash:q...`). */
  address: string;
  /** Explicit network ID override. If omitted, derived from address prefix. */
  networkId?: EcashNetworkId;
  /** Relay base URL to route via the relay's Chronik reverse proxy (`/chain-rpc/<networkId>/chronik`). */
  relayBaseUrl?: string;
  /** Direct Chronik endpoints override. */
  chronikUrls?: string[];
  /** Test seam to inject a mock ChronikClient or factory by URL. */
  client?: ChronikScriptClientSeam | ((url: string) => ChronikScriptClientSeam);
}

export interface EcashBalanceResult {
  sats: bigint;
  formatted: string;
  unit: string;
  networkId: "xec-mainnet" | "xec-testnet";
}

export const DEFAULT_CHRONIK_UPSTREAMS: Record<
  "xec-mainnet" | "xec-testnet",
  string
> = {
  "xec-mainnet": "https://chronik.fabien.cash",
  "xec-testnet": "https://chronik-testnet.fabien.cash",
};

/**
 * Resolves failover Chronik URLs for eCash queries.
 * Places the local/configured relay reverse proxy first, followed by public upstream indexer fallback.
 */
export function getEcashChronikUrls(params: {
  networkId: "xec-mainnet" | "xec-testnet";
  relayBaseUrl?: string;
  chronikUrls?: string[];
}): string[] {
  if (params.chronikUrls && params.chronikUrls.length > 0) {
    return params.chronikUrls;
  }
  const upstream = DEFAULT_CHRONIK_UPSTREAMS[params.networkId];
  if (params.relayBaseUrl) {
    const cleanRelay = params.relayBaseUrl.replace(/\/+$/, "");
    if (typeof window === "undefined") {
      return [`${cleanRelay}/chain-rpc/${params.networkId}/chronik`, upstream];
    }
    return [`${cleanRelay}/chain-rpc/${params.networkId}/chronik`];
  }
  return [upstream];
}

/**
 * Public, read-only eCash balance fetcher by address.
 * Iterates sequentially through candidate Chronik endpoints (relay reverse proxy first,
 * then public upstreams) with automatic failover if any endpoint encounters an error.
 * Does not require private keys, HD wallet derivation, or wallet state changes.
 */
export async function fetchEcashBalance(
  options: FetchEcashBalanceOptions
): Promise<EcashBalanceResult> {
  const parsed = Address.fromCashAddress(options.address.toLowerCase());
  const networkId = options.networkId
    ? canonicalEcashNetworkId(options.networkId)
    : parsed.prefix === "ectest"
    ? "xec-testnet"
    : "xec-mainnet";

  const chronikUrls = getEcashChronikUrls({
    networkId,
    relayBaseUrl: options.relayBaseUrl,
    chronikUrls: options.chronikUrls,
  });

  const clientCtor = ChronikClient as unknown as new (
    urls: string[] | string
  ) => ChronikScriptClientSeam;

  let lastError: unknown = null;

  for (const url of chronikUrls) {
    try {
      const chronik =
        typeof options.client === "function"
          ? options.client(url)
          : options.client ?? new clientCtor(url);

      const res = await chronik.script(parsed.type, parsed.hash).utxos();
      const utxoList: ReadonlyArray<ChronikUtxoItem> = Array.isArray(res)
        ? res.flatMap(
            (group: { utxos?: ReadonlyArray<ChronikUtxoItem> }) =>
              group.utxos ?? []
          )
        : (res as { utxos?: ReadonlyArray<ChronikUtxoItem> }).utxos ?? [];

      const sats = utxoList.reduce((acc: bigint, u: ChronikUtxoItem) => {
        if (u.sats !== undefined) {
          return acc + BigInt(u.sats);
        }
        if (u.value !== undefined) {
          return acc + BigInt(u.value);
        }
        return acc;
      }, 0n);

      const unit = networkId === "xec-testnet" ? "tXEC" : "XEC";
      const formatted = `${formatBaseUnit(sats, 2)} ${unit}`;

      return {
        sats,
        formatted,
        unit,
        networkId,
      };
    } catch (err) {
      lastError = err;
      // If a static mock object was supplied for unit testing, propagate error directly
      if (options.client && typeof options.client !== "function") {
        throw err;
      }
    }
  }

  throw lastError ?? new Error("Error connecting to known Chronik instances");
}
