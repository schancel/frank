import {
  FetchRequest,
  JsonRpcApiProviderOptions,
  JsonRpcProvider,
  Network,
  Networkish,
  concat,
  getBigInt,
  getBytes,
  hexlify,
  makeError,
  sha256,
  toBeHex,
  toUtf8Bytes,
} from "ethers";

export const DEFAULT_MONAD_CHAIN_ID = 10143n;

export interface MonadJsonRpcProviderOptions extends JsonRpcApiProviderOptions {
  rpcUrl: string;
  chainId?: number | bigint | Networkish;
  relayAuth?: MonadRelayRpcAuth;
}

export interface MonadRelayRpcAuth {
  chain: string;
  customer: string;
  networkTag: string;
  signDigest: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

interface RelayRpcChallenge {
  epoch: string;
  nonce: string;
  expires_at_ms: number;
  token: string;
  signing_domain: string;
  customer: string;
  chain: string;
  body_sha256: string;
  network_tag: string;
}

const RELAY_RPC_AUTH_DOMAIN = "frank:rpc-http-auth:v1";
function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function bareHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2);
}

function validateChallenge(
  challenge: RelayRpcChallenge,
  auth: MonadRelayRpcAuth,
  bodyHash: string
): void {
  const expectedNetworkTag = bareHex(toUtf8Bytes(auth.networkTag));
  const hex32 = /^[0-9a-f]{64}$/;
  if (
    challenge.signing_domain !== RELAY_RPC_AUTH_DOMAIN ||
    challenge.customer.toLowerCase() !== auth.customer.toLowerCase() ||
    challenge.chain !== auth.chain ||
    challenge.body_sha256 !== bodyHash ||
    challenge.network_tag !== expectedNetworkTag ||
    !hex32.test(challenge.epoch) ||
    !hex32.test(challenge.nonce) ||
    !hex32.test(challenge.token) ||
    !Number.isSafeInteger(challenge.expires_at_ms) ||
    challenge.expires_at_ms <= Date.now()
  ) {
    throw new Error("relay returned a malformed or mismatched RPC challenge");
  }
}

function rpcAuthDigest(
  challenge: RelayRpcChallenge,
  auth: MonadRelayRpcAuth,
  bodyHash: string
): Uint8Array {
  const chain = toUtf8Bytes(auth.chain);
  const customer = getBytes(auth.customer);
  const networkTag = toUtf8Bytes(auth.networkTag);
  if (customer.length !== 20)
    throw new Error("relay RPC customer must be a 20-byte address");
  return getBytes(
    sha256(
      concat([
        toUtf8Bytes(RELAY_RPC_AUTH_DOMAIN),
        new Uint8Array([0]),
        getBytes(`0x${challenge.epoch}`),
        getBytes(`0x${challenge.nonce}`),
        getBytes(toBeHex(BigInt(challenge.expires_at_ms), 8)),
        getBytes(`0x${challenge.token}`),
        toUtf8Bytes("POST\0/chain-rpc/"),
        u32be(chain.length),
        chain,
        toUtf8Bytes("\0rpc"),
        customer,
        getBytes(`0x${bodyHash}`),
        u32be(networkTag.length),
        networkTag,
      ])
    )
  );
}

/** Builds an ethers connection to a relay family route. Public bootstrap calls are sent directly;
 * customer-only calls first obtain a body-bound challenge and sign it with the registered profile
 * identity. The upstream provider URL never reaches this process or the browser bundle. */
export function createMonadRelayRpcConnection(
  rpcUrl: string,
  auth: MonadRelayRpcAuth
): FetchRequest {
  const connection = new FetchRequest(rpcUrl);
  // A fixed-hour quota cannot recover during ethers' short automatic 429
  // retry window. Return ownership of retry timing to the application.
  connection.retryFunc = async () => false;
  connection.preflightFunc = async (request) => {
    const body = request.body;
    if (body === null) return request;

    const bodyHash = bareHex(getBytes(sha256(body)));
    const challengeRequest = new FetchRequest(`${rpcUrl}/auth`);
    challengeRequest.body = body;
    challengeRequest.timeout = request.timeout;
    challengeRequest.retryFunc = async () => false;
    challengeRequest.setHeader("content-type", "application/json");
    challengeRequest.setHeader("x-frank-rpc-customer", auth.customer);
    const response = await challengeRequest.send();
    response.assertOk();
    const challenge = response.bodyJson as RelayRpcChallenge;
    validateChallenge(challenge, auth, bodyHash);
    const signature = await auth.signDigest(
      rpcAuthDigest(challenge, auth, bodyHash)
    );

    request.setHeader("x-frank-rpc-customer", auth.customer);
    request.setHeader("x-frank-rpc-epoch", challenge.epoch);
    request.setHeader("x-frank-rpc-nonce", challenge.nonce);
    request.setHeader("x-frank-rpc-expires-at-ms", challenge.expires_at_ms);
    request.setHeader("x-frank-rpc-token", challenge.token);
    request.setHeader("x-frank-rpc-signature", bareHex(signature));
    return request;
  };
  return connection;
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
    options?: JsonRpcApiProviderOptions & { relayAuth?: MonadRelayRpcAuth }
  ) {
    const chainId =
      expectedChainId !== undefined && typeof expectedChainId !== "object"
        ? BigInt(expectedChainId)
        : DEFAULT_MONAD_CHAIN_ID;

    // Pass staticNetwork: true so ethers initializes its internal #network and does NOT
    // enter the unbounded _start() loop that retries network detection every 1s indefinitely on 503.
    const { relayAuth, ...providerOptions } = options ?? {};
    const connection =
      typeof url === "string" && relayAuth
        ? createMonadRelayRpcConnection(url, relayAuth)
        : url;
    super(connection, chainId, {
      ...providerOptions,
      batchMaxCount: providerOptions.batchMaxCount ?? 20,
      batchMaxSize: providerOptions.batchMaxSize ?? 256 * 1024,
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
