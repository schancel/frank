import {
  FetchRequest,
  JsonRpcApiProviderOptions,
  JsonRpcProvider,
  Network,
  Networkish,
  getBigInt,
  makeError,
} from "ethers";

export const DEFAULT_MONAD_CHAIN_ID = 10143n;

export interface MonadJsonRpcProviderOptions extends JsonRpcApiProviderOptions {
  rpcUrl: string;
  chainId?: number | bigint | Networkish;
}

/**
 * Specialized JsonRpcProvider for Monad EVM endpoints (Issue #534).
 *
 * In standard ethers v6, `new JsonRpcProvider(url)` without `staticNetwork: true` spawns an
 * internal retry loop in `_start()` that attempts `_detectNetwork()` every 1 second indefinitely
 * on failure (logging "JsonRpcProvider failed to detect network and cannot start up; retry in 1s").
 * During an RPC outage, this bypasses application-level backoff policies (such as `useBalance`),
 * causing ~60 requests/minute.
 *
 * `MonadJsonRpcProvider`:
 * 1. Passes `staticNetwork: true` to `super()` to disable ethers' uncontrolled 1-second internal retry loop.
 * 2. Overrides `_detectNetwork()` to perform bounded, non-looping verification:
 *    - Queries `eth_chainId` via `send("eth_chainId", [])`.
 *    - Rejects immediately on RPC error (e.g. 503) without retrying internally, allowing the caller's
 *      backoff/cancellation policy to govern retry timing.
 *    - Rejects wrong-chain responses if the RPC reports a chain ID different from `expectedChainId`.
 *    - Caches the verified network so healthy steady-state operations do not re-query `eth_chainId`.
 */
export class MonadJsonRpcProvider extends JsonRpcProvider {
  readonly expectedChainId: bigint;
  #verifiedNetwork: Network | null = null;
  #pendingDetectNetwork: Promise<Network> | null = null;

  constructor(
    url: string | FetchRequest,
    expectedChainId?: number | bigint | Networkish,
    options?: JsonRpcApiProviderOptions
  ) {
    const chainId =
      expectedChainId !== undefined && typeof expectedChainId !== "object"
        ? BigInt(expectedChainId)
        : DEFAULT_MONAD_CHAIN_ID;

    // Pass staticNetwork: true so ethers initializes its internal #network and does NOT
    // enter the unbounded _start() loop that retries network detection every 1s indefinitely on 503.
    super(url, chainId, {
      ...options,
      staticNetwork: true,
    });

    this.expectedChainId = chainId;
  }

  override async _detectNetwork(): Promise<Network> {
    if (this.destroyed) {
      throw makeError(
        "provider destroyed; cancelled request",
        "UNSUPPORTED_OPERATION",
        {
          operation: "_detectNetwork",
        }
      );
    }

    if (this.#verifiedNetwork !== null) {
      return this.#verifiedNetwork;
    }

    if (this.#pendingDetectNetwork !== null) {
      return await this.#pendingDetectNetwork;
    }

    this.#pendingDetectNetwork = (async () => {
      try {
        const raw = await this.send("eth_chainId", []);
        const actualChainId = getBigInt(raw);

        if (actualChainId !== this.expectedChainId) {
          throw makeError(
            `network mismatch: expected ${this.expectedChainId} but RPC reported ${actualChainId}`,
            "NETWORK_ERROR",
            { event: "changed" }
          );
        }

        const network = new Network("monad", actualChainId);
        this.#verifiedNetwork = network;
        return network;
      } finally {
        this.#pendingDetectNetwork = null;
      }
    })();

    return await this.#pendingDetectNetwork;
  }

  override destroy(): void {
    this.#verifiedNetwork = null;
    this.#pendingDetectNetwork = null;
    super.destroy();
  }
}

/**
 * Creates a configured `MonadJsonRpcProvider` with bounded network detection and backoff compliance.
 */
export function createMonadJsonRpcProvider(
  options: MonadJsonRpcProviderOptions
): MonadJsonRpcProvider {
  return new MonadJsonRpcProvider(options.rpcUrl, options.chainId, options);
}
