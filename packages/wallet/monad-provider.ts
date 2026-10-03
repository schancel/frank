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

const relayConnectionDestroy = new WeakMap<FetchRequest, () => void>();

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

interface RelayRpcCapability {
  rpc_path: string;
  ws_path?: string;
  expires_at_ms: number;
}

export interface MonadRelayRpcCapability {
  rpcUrl: string;
  wsUrl?: string;
  expiresAtMs: number;
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
  bodyHash: string,
  resource: "rpc" | "capability" = "rpc"
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
        toUtf8Bytes(`\0${resource}`),
        customer,
        getBytes(`0x${bodyHash}`),
        u32be(networkTag.length),
        networkTag,
      ])
    )
  );
}

/** Obtain one standard-client-compatible HTTP/WebSocket bearer URL pair from a relay. */
export async function issueMonadRelayRpcCapability(
  rpcUrl: string,
  auth: MonadRelayRpcAuth,
  timeout = 30_000,
  isCancelled: () => boolean = () => false
): Promise<MonadRelayRpcCapability> {
  const ensureActive = () => {
    if (isCancelled()) throw new Error("relay capability request cancelled");
  };
  ensureActive();
  const relayBaseUrl = rpcUrl.replace(/\/rpc\/?$/, "");
  const emptyBody = new Uint8Array(0);
  const bodyHash = bareHex(getBytes(sha256(emptyBody)));
  const challengeRequest = new FetchRequest(`${relayBaseUrl}/capability/auth`);
  challengeRequest.body = emptyBody;
  challengeRequest.timeout = timeout;
  challengeRequest.retryFunc = async () => false;
  challengeRequest.setHeader("content-type", "application/octet-stream");
  challengeRequest.setHeader("x-frank-rpc-customer", auth.customer);
  const challengeResponse = await challengeRequest.send();
  ensureActive();
  challengeResponse.assertOk();
  const challenge = challengeResponse.bodyJson as RelayRpcChallenge;
  validateChallenge(challenge, auth, bodyHash);
  const signature = await auth.signDigest(
    rpcAuthDigest(challenge, auth, bodyHash, "capability")
  );
  ensureActive();

  const issueRequest = new FetchRequest(`${relayBaseUrl}/capability`);
  issueRequest.body = emptyBody;
  issueRequest.timeout = timeout;
  issueRequest.retryFunc = async () => false;
  issueRequest.setHeader("content-type", "application/octet-stream");
  issueRequest.setHeader("x-frank-rpc-customer", auth.customer);
  issueRequest.setHeader("x-frank-rpc-epoch", challenge.epoch);
  issueRequest.setHeader("x-frank-rpc-nonce", challenge.nonce);
  issueRequest.setHeader("x-frank-rpc-expires-at-ms", challenge.expires_at_ms);
  issueRequest.setHeader("x-frank-rpc-token", challenge.token);
  issueRequest.setHeader("x-frank-rpc-signature", bareHex(signature));
  const issueResponse = await issueRequest.send();
  ensureActive();
  issueResponse.assertOk();
  const capability = issueResponse.bodyJson as RelayRpcCapability;
  if (
    !capability.rpc_path.startsWith("/chain-rpc/") ||
    (capability.ws_path !== undefined &&
      !capability.ws_path.startsWith("/chain-rpc/")) ||
    !Number.isSafeInteger(capability.expires_at_ms) ||
    capability.expires_at_ms <= Date.now()
  ) {
    throw new Error("relay returned a malformed RPC capability");
  }
  const httpUrl = new URL(capability.rpc_path, rpcUrl);
  const wsUrl = capability.ws_path
    ? new URL(capability.ws_path, rpcUrl)
    : undefined;
  if (wsUrl) wsUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return {
    rpcUrl: httpUrl.toString(),
    wsUrl: wsUrl?.toString(),
    expiresAtMs: capability.expires_at_ms,
  };
}

/** Builds an ethers connection to a relay family route. The first customer request obtains one
 * expiring bearer capability; subsequent requests are ordinary JSON-RPC POSTs to that URL. The
 * upstream provider URL never reaches this process or the browser bundle. */
export function createMonadRelayRpcConnection(
  rpcUrl: string,
  auth: MonadRelayRpcAuth
): FetchRequest {
  const connection = new FetchRequest(rpcUrl);
  // A fixed-hour quota cannot recover during ethers' short automatic 429
  // retry window. Return ownership of retry timing to the application.
  connection.retryFunc = async () => false;
  let cachedCapability: MonadRelayRpcCapability | null = null;
  let capabilityInFlight: Promise<MonadRelayRpcCapability> | null = null;
  let destroyed = false;
  relayConnectionDestroy.set(connection, () => {
    destroyed = true;
    cachedCapability = null;
  });

  const capabilityFor = async (
    timeout: number
  ): Promise<MonadRelayRpcCapability> => {
    if (destroyed) throw new Error("relay capability request cancelled");
    if (
      cachedCapability !== null &&
      cachedCapability.expiresAtMs > Date.now() + 30_000
    ) {
      return cachedCapability;
    }
    if (capabilityInFlight !== null) return capabilityInFlight;

    const issuance = issueMonadRelayRpcCapability(
      rpcUrl,
      auth,
      timeout,
      () => destroyed
    );
    capabilityInFlight = issuance;
    try {
      const capability = await issuance;
      // Only the currently registered issuance may update the cache. This
      // keeps a late completion from replacing a newer capability.
      if (capabilityInFlight === issuance) cachedCapability = capability;
      return capability;
    } finally {
      // A failed challenge or issuance must not poison later requests.
      if (capabilityInFlight === issuance) capabilityInFlight = null;
    }
  };

  connection.preflightFunc = async (request) => {
    const body = request.body;
    if (body === null) return request;
    const capability = await capabilityFor(request.timeout);
    if (destroyed) throw new Error("relay capability request cancelled");
    const authorized = new FetchRequest(capability.rpcUrl);
    authorized.body = body;
    authorized.timeout = request.timeout;
    authorized.retryFunc = async () => false;
    authorized.setHeader("content-type", "application/json");
    return authorized;
  };
  connection.processFunc = async (request, response) => {
    if (
      response.statusCode === 401 &&
      cachedCapability?.rpcUrl === request.url
    ) {
      cachedCapability = null;
    }
    return response;
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
  #destroyRelayConnection: (() => void) | null = null;

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
    if (connection instanceof FetchRequest) {
      this.#destroyRelayConnection =
        relayConnectionDestroy.get(connection) ?? null;
    }
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
    this.#destroyRelayConnection?.();
    this.#destroyRelayConnection = null;
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
