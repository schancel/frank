/**
 * Client-side POP (proof-of-payment) flow over Monad (ticket #5): the client half of the wire
 * contract the server implements in `backend/cashweb/cashweb-registry/src/http/pop_protection.rs`
 * (tickets #4/#22/#23/#24, merged). That module's own header is the source of truth for the exact
 * shape; the parts this file depends on, verified by reading it directly rather than guessing:
 *
 *   - The protected endpoint is `PUT /metadata/:addr` (`handle_put_registry` in
 *     `backend/cashweb/cashweb-registry/src/http/server.rs`) -- not `/registry/:address`.
 *   - A payment proof is presented as a single query parameter on that same PUT request:
 *     `pop_tx_hash=0x<32-byte Monad tx hash>`. There is no `pop_value_wei` parameter -- an earlier
 *     revision had one, but ticket #25 made server-side verification look the paid value up
 *     on-chain itself, so it was dropped; this client never sends it.
 *   - On success, the response carries an `X-Pop-Token: POP <token>` header. On subsequent
 *     requests to the same address, that token can be presented instead of paying again, via
 *     `Authorization: POP <token>` (the form this client uses) or `?access_token=POP <token>`.
 *   - On failure (no/invalid token and no/invalid payment proof), the response is `402 Payment
 *     Required` with a JSON body (`PopChallengeBody` in `server.rs`) that -- confirmed by reading
 *     its `Serialize` impl, not assumed -- already carries everything a client needs to know what
 *     to pay: `recipient` (0x-prefixed Monad address, decimal-string `min_value_wei`), so no
 *     separate out-of-band config/handshake is needed to learn them. This client's very first
 *     attempt at any address (with no cached token) is expected to hit exactly this 402 and reads
 *     `recipient`/`min_value_wei` straight out of it.
 *
 * Flow implemented by `MonadPopClient.payAndPutMetadata`:
 *   1. Attempt the real metadata PUT, presenting a cached bearer token for `address` if one is
 *      held (nothing otherwise). If it succeeds, done -- no payment needed.
 *   2. If it comes back `402`, parse the challenge for `recipient`/`min_value_wei`, acquire a
 *      sub-account lease (`SubAccountLeaseManager.acquireLease`, ticket #18), and build+sign+submit
 *      a plain native-value transfer of at least `min_value_wei` to `recipient` from the leased
 *      sub-account (`MonadAccountTxSigner`, ticket #11, obtained via
 *      `MonadSubAccountPool.getSigner`, ticket #14).
 *   3. Wait for the payment tx to settle (`awaitLeaseSettlement`, ticket #18), which also releases
 *      the lease per its own outcome: `'confirmed'` -> `'available'`; `'failed'`/`'stuck'` ->
 *      `'retired'` (this is this ticket's "documented abandonment on failure" -- there is no
 *      separate bookkeeping here beyond what #18 already does).
 *   4. If it confirmed, retry the metadata PUT with `?pop_tx_hash=<hash>`. Success mints a fresh
 *      token (surfaced via `X-Pop-Token`), which is cached for reuse on the next call for the same
 *      address and returned to the caller.
 *
 * Ownership: this file only imports the existing, already-merged public API of
 * `monad-account-lease.ts` (#18), `monad-account-pool.ts` (#14), and `monad-account-tx.ts` (#11) --
 * it does not modify any of them, `monad-http.ts`, `chain-adapter.ts`, `lotus-adapter.ts`, or
 * `index.ts` (this ticket's file-ownership boundary).
 *
 * Non-goal: server-side verification (already done, #4/#22/#23/#24) -- this file never validates a
 * token or a payment itself; it only drives the client side of the same protocol.
 */
import { Provider } from 'ethers'
import axios, { AxiosInstance } from 'axios'

import { MonadSubAccountPool } from './monad-account-pool'
import { MonadTxSubmitter } from './monad-account-tx'
import {
  AccountLeaseHandle,
  AwaitLeaseSettlementParams,
  LeaseOutcome,
  SubAccountLeaseManager,
  awaitLeaseSettlement,
} from './monad-account-lease'

/** Query parameter carrying a Monad tx hash payment proof -- mirrors
 * `pop_protection.rs`'s `TX_HASH_PARAM`. */
export const POP_TX_HASH_PARAM = 'pop_tx_hash'
/** Query parameter carrying a fallback bearer token -- mirrors `pop_protection.rs`'s
 * `ACCESS_TOKEN_PARAM`. This client always presents a cached token via the `Authorization` header
 * instead (see `authHeaderForToken`), but the constant is exported for callers/tests that need the
 * query-param form (e.g. a plain `GET` made outside this class). */
export const POP_ACCESS_TOKEN_PARAM = 'access_token'

const POP_TOKEN_HEADER = 'x-pop-token'
const POP_SCHEME_PREFIX = 'POP '

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300
}

function authHeaderForToken(token: string): Record<string, string> {
  return { Authorization: `${POP_SCHEME_PREFIX}${token}` }
}

/** Strips the `pop_protection.rs`-mandated `"POP "` scheme prefix from a presented/returned
 * token value, tolerating a bare token (no prefix) too, since some callers/mocks may hand one
 * over already-unwrapped. */
function stripPopScheme(value: string): string {
  return value.startsWith(POP_SCHEME_PREFIX)
    ? value.slice(POP_SCHEME_PREFIX.length)
    : value
}

function extractBearerToken(response: PopHttpResponse): string | undefined {
  const raw = response.headers[POP_TOKEN_HEADER]
  return raw === undefined ? undefined : stripPopScheme(raw)
}

/** One HTTP round trip's worth of the metadata-PUT request this module needs to make -- decoupled
 * from any particular HTTP library so `MonadPopClient` can be unit-tested against a plain mock
 * (the same pattern `MonadTxSubmitter`/`LeaseTxStatusSource` already use elsewhere in this
 * directory), and so a real implementation can be swapped in without touching this file's core
 * logic. */
export interface PopPutRequest {
  /** Registry HTTP(S) base URL, e.g. `https://registry.example.com` (no trailing slash required).
   */
  registryBaseUrl: string
  /** The Lotus address whose metadata is being PUT -- the `:addr` path segment. */
  address: string
  /** Already-built, already-signed request body (a serialized `SignedPayload` protobuf) --
   * building that payload is the caller's responsibility; this module only concerns itself with
   * the POP payment/token dance layered on top of the PUT. */
  body: Uint8Array
  /** Extra query parameters (e.g. `pop_tx_hash`) to add to the PUT. */
  query?: Record<string, string>
  /** Extra headers (e.g. `Authorization: POP <token>`) to add to the PUT. */
  headers?: Record<string, string>
}

/** The response shape `PopHttpClient.putRegistryMetadata` must resolve with -- for *any* status
 * code, including `402`. A `402` challenge is an expected, normal outcome of this flow, not an
 * error; implementations must not throw merely because of a non-2xx status (see
 * `AxiosPopHttpClient`, which sets `validateStatus: () => true` for exactly this reason). Only a
 * genuine network/transport failure should reject the returned promise. */
export interface PopHttpResponse {
  status: number
  /** Response headers, keyed lower-case (matches `pop_protection.rs`'s own lower-case
   * `x-pop-token` header name, and axios' own header-casing convention). */
  headers: Record<string, string | undefined>
  data: unknown
}

/** Structural HTTP surface this module needs against the registry's metadata-PUT endpoint. */
export interface PopHttpClient {
  putRegistryMetadata(request: PopPutRequest): Promise<PopHttpResponse>
}

function normalizeHeaders(
  headers: unknown,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  if (headers !== null && typeof headers === 'object') {
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      result[key.toLowerCase()] = typeof value === 'string' ? value : undefined
    }
  }
  return result
}

/** Default `PopHttpClient`, backed by `axios` (already this app's HTTP client of choice for the
 * deprecated Lotus/BIP70 POP flow -- see `../pop.ts`/`../registry/index.ts`). */
export class AxiosPopHttpClient implements PopHttpClient {
  private readonly axiosInstance: AxiosInstance

  constructor(axiosInstance: AxiosInstance = axios) {
    this.axiosInstance = axiosInstance
  }

  async putRegistryMetadata(request: PopPutRequest): Promise<PopHttpResponse> {
    const url = `${request.registryBaseUrl.replace(/\/+$/, '')}/metadata/${
      request.address
    }`
    const response = await this.axiosInstance.request({
      method: 'put',
      url,
      params: request.query,
      headers: request.headers,
      data: request.body,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    })
    return {
      status: response.status,
      headers: normalizeHeaders(response.headers),
      data: response.data,
    }
  }
}

/** Parsed shape of `PopChallengeBody` (`server.rs`), for the two fields this client needs. Field
 * names are snake_case verbatim -- the Rust struct has no `#[serde(rename_all = ...)]`, so its
 * `Serialize` output uses its Rust field names as-is. */
interface PopChallengeResponseBody {
  error?: string
  reason?: string
  detail?: string | null
  recipient?: string
  min_value_wei?: string
  how_to_pay?: string
}

function decodeJsonBody(data: unknown): unknown {
  if (data instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(data).toString('utf-8'))
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
        'utf-8',
      ),
    )
  }
  if (typeof data === 'string') {
    return JSON.parse(data)
  }
  // Already a parsed JS value -- e.g. a test double's `PopHttpClient` handing back plain objects
  // instead of wire bytes.
  return data
}

/** Base class for every error this module throws, so callers can `catch (e) { if (e instanceof
 * PopClientError) ... }` to distinguish POP-flow failures from unrelated errors (mirrors
 * `monad-account-lease.ts`'s `AccountLeaseError` convention). */
export class PopClientError extends Error {}

/** The registry's 402 challenge didn't carry the `recipient`/`min_value_wei` fields this client
 * relies on to know what to pay. Per this file's header, the live server is expected to always
 * include them (verified by reading `PopChallengeBody`'s `Serialize` impl) -- this only fires
 * against a misbehaving/incompatible server. */
export class PopProtocolError extends PopClientError {}

/** The payment tx never confirmed (`awaitLeaseSettlement` settled it `'failed'` or `'stuck'`). The
 * lease has already been released/retired accordingly by the time this is thrown -- see
 * `monad-account-lease.ts`'s `releaseLease` semantics. */
export class PopPaymentNotConfirmedError extends PopClientError {
  readonly outcome: Exclude<LeaseOutcome, 'confirmed'>
  readonly txHash: string

  constructor(
    message: string,
    outcome: Exclude<LeaseOutcome, 'confirmed'>,
    txHash: string,
  ) {
    super(message)
    this.outcome = outcome
    this.txHash = txHash
  }
}

/** The registry rejected the redeeming PUT (the one carrying `pop_tx_hash`) even though the
 * payment tx itself confirmed on-chain. */
export class PopRedeemError extends PopClientError {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** An HTTP response outside the two shapes this flow understands (2xx success, 402 challenge). */
export class PopUnexpectedResponseError extends PopClientError {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

function parseChallenge(response: PopHttpResponse): {
  recipient: string
  minValueWei: bigint
} {
  const parsed = decodeJsonBody(response.data) as PopChallengeResponseBody
  if (
    typeof parsed?.recipient !== 'string' ||
    typeof parsed?.min_value_wei !== 'string'
  ) {
    throw new PopProtocolError(
      '402 challenge response did not carry the expected recipient/min_value_wei fields ' +
        `(got: ${JSON.stringify(parsed)})`,
    )
  }
  let minValueWei: bigint
  try {
    minValueWei = BigInt(parsed.min_value_wei)
  } catch (err) {
    throw new PopProtocolError(
      `402 challenge response's min_value_wei was not a valid integer: ${parsed.min_value_wei}`,
    )
  }
  return { recipient: parsed.recipient, minValueWei }
}

/** Result of a successful `MonadPopClient.payAndPutMetadata` call. */
export interface PopPaymentResult {
  /** Bearer token to present on subsequent requests to this same address. Already cached
   * internally by `MonadPopClient` (see `getCachedToken`) -- returned here too for convenience/
   * logging, not because callers need to thread it through themselves. */
  token: string
  /** `true` if an already-cached (or otherwise already-valid) token satisfied the PUT with no
   * on-chain payment; `false` if a fresh payment tx was built, signed, submitted, and confirmed to
   * obtain it. */
  reusedToken: boolean
  /** Present only when `reusedToken` is `false`. */
  payment?: {
    txHash: string
    leaseIndex: number
    leaseAddress: string
    recipient: string
    minValueWei: bigint
  }
}

/** Constructor params for `MonadPopClient`. */
export interface MonadPopClientParams {
  leaseManager: SubAccountLeaseManager
  pool: MonadSubAccountPool
  /** ethers `Provider` used (via `pool.getSigner`) for nonce/gas/fee/chainId reads when building
   * the payment tx -- see `monad-account-tx.ts`'s header for why this is separate from
   * `monadHttpClient`. */
  provider: Provider
  /** Used (via `pool.getSigner`) to submit the payment tx and poll its receipt -- the same
   * `MonadTxSubmitter` surface `MonadAccountTxSigner`/`awaitLeaseSettlement` already depend on. */
  monadHttpClient: MonadTxSubmitter
  /** Registry HTTP(S) base URL passed through to every `PopHttpClient.putRegistryMetadata` call. */
  registryBaseUrl: string
  /** Defaults to `new AxiosPopHttpClient()`. Overridable for tests, or to point at a different
   * transport entirely. */
  popHttpClient?: PopHttpClient
}

/** Options for `MonadPopClient.payAndPutMetadata`. */
export interface PayAndPutMetadataParams {
  address: string
  body: Uint8Array
  /** Forwarded to `awaitLeaseSettlement` (poll interval/timeout, and injectable `sleep`/`now` for
   * deterministic tests) when a payment ends up being required. Ignored if a cached/valid token
   * already satisfies the request. */
  settlement?: Omit<
    AwaitLeaseSettlementParams,
    'manager' | 'handle' | 'txHash' | 'statusSource'
  >
  /** Overrides how a lease is acquired when a payment ends up being required. Defaults to
   * `() => this.leaseManager.acquireLease()` (reject-immediately semantics, per
   * `monad-account-lease.ts`'s own default). Pass e.g.
   * `() => acquireLeaseWhenAvailable(leaseManager, opts)` to wait-and-retry instead. */
  acquireLease?: () => AccountLeaseHandle | Promise<AccountLeaseHandle>
}

/**
 * Drives the client side of the live POP protocol
 * (`backend/cashweb/cashweb-registry/src/http/pop_protection.rs`) for the registry's
 * `PUT /metadata/:addr` endpoint: reuse a cached bearer token if one still works, otherwise pay
 * for one over Monad from a leased sub-account and redeem it, per this file's header.
 *
 * Intended usage: one instance per registry base URL (or per app, if there's only one registry),
 * sharing the same `SubAccountLeaseManager`/`MonadSubAccountPool` instances used for other Monad
 * flows (e.g. Stamp-over-Monad, ticket #6/#13) -- acquiring/releasing leases through the *same*
 * manager instance is what keeps contention correct (see `monad-account-lease.ts`'s header).
 */
export class MonadPopClient {
  private readonly leaseManager: SubAccountLeaseManager
  private readonly pool: MonadSubAccountPool
  private readonly provider: Provider
  private readonly monadHttpClient: MonadTxSubmitter
  private readonly registryBaseUrl: string
  private readonly popHttpClient: PopHttpClient
  private readonly tokensByAddress = new Map<string, string>()

  constructor(params: MonadPopClientParams) {
    this.leaseManager = params.leaseManager
    this.pool = params.pool
    this.provider = params.provider
    this.monadHttpClient = params.monadHttpClient
    this.registryBaseUrl = params.registryBaseUrl
    this.popHttpClient = params.popHttpClient ?? new AxiosPopHttpClient()
  }

  /** Bearer token currently cached for `address` (from a previous `payAndPutMetadata` call), if
   * any. */
  getCachedToken(address: string): string | undefined {
    return this.tokensByAddress.get(address)
  }

  /** Forget any cached token for `address` -- e.g. if a caller learns out-of-band that it expired,
   * to force the next `payAndPutMetadata` call to re-authenticate rather than waste a round trip
   * discovering that itself. */
  clearCachedToken(address: string): void {
    this.tokensByAddress.delete(address)
  }

  /**
   * Perform a metadata-PUT against the registry's POP-protected endpoint, paying for access over
   * Monad if no cached token already works. See this file's header for the full flow. Throws
   * `PopProtocolError` / `PopPaymentNotConfirmedError` / `PopRedeemError` /
   * `PopUnexpectedResponseError` (all `PopClientError`) on failure, plus whatever
   * `SubAccountLeaseManager.acquireLease`/`MonadAccountTxSigner.buildAndSignTransfer`/`submit`
   * themselves throw (e.g. `NoAvailableSubAccountError`, `MonadRpcError`).
   */
  async payAndPutMetadata(
    params: PayAndPutMetadataParams,
  ): Promise<PopPaymentResult> {
    const { address, body } = params
    const cachedToken = this.tokensByAddress.get(address)

    const authedAttempt = await this.popHttpClient.putRegistryMetadata({
      registryBaseUrl: this.registryBaseUrl,
      address,
      body,
      headers: cachedToken ? authHeaderForToken(cachedToken) : undefined,
    })

    if (isSuccessStatus(authedAttempt.status)) {
      const token = extractBearerToken(authedAttempt) ?? cachedToken
      if (token === undefined) {
        throw new PopProtocolError(
          'Registry accepted the metadata PUT without presenting or minting a POP bearer token',
        )
      }
      this.tokensByAddress.set(address, token)
      return { token, reusedToken: true }
    }

    if (authedAttempt.status !== 402) {
      throw new PopUnexpectedResponseError(
        `Unexpected status ${authedAttempt.status} from registry metadata PUT`,
        authedAttempt.status,
        authedAttempt.data,
      )
    }

    // No valid token (or none presented) -- the cached one, if any, is stale; the 402 challenge
    // tells us what to pay.
    this.tokensByAddress.delete(address)
    const challenge = parseChallenge(authedAttempt)

    const acquire =
      params.acquireLease ?? (() => this.leaseManager.acquireLease())
    const handle = await acquire()
    const signer = this.pool.getSigner(handle.index, {
      provider: this.provider,
      httpClient: this.monadHttpClient,
    })

    let txHash: string
    try {
      const signedTx = await signer.buildAndSignTransfer(
        challenge.recipient,
        challenge.minValueWei,
      )
      txHash = await signer.submit(signedTx)
    } catch (err) {
      // The payment tx never made it on-chain at all -- release (rather than leave dangling) the
      // lease as 'failed', per this ticket's "documented abandonment on failure" requirement and
      // the lease API's own outcome semantics.
      this.leaseManager.releaseLease(handle, 'failed')
      throw err
    }

    const settlement = await awaitLeaseSettlement({
      manager: this.leaseManager,
      handle,
      txHash,
      statusSource: signer,
      ...params.settlement,
    })

    if (settlement.outcome !== 'confirmed') {
      throw new PopPaymentNotConfirmedError(
        `POP payment tx ${txHash} did not confirm (outcome: ${settlement.outcome}); ` +
          `sub-account ${handle.index} has been retired`,
        settlement.outcome,
        txHash,
      )
    }

    const redeemAttempt = await this.popHttpClient.putRegistryMetadata({
      registryBaseUrl: this.registryBaseUrl,
      address,
      body,
      query: { [POP_TX_HASH_PARAM]: txHash },
    })

    if (!isSuccessStatus(redeemAttempt.status)) {
      throw new PopRedeemError(
        `Registry rejected the redeeming PUT (${POP_TX_HASH_PARAM}=${txHash}) with status ` +
          `${redeemAttempt.status} even though the payment tx confirmed`,
        redeemAttempt.status,
        redeemAttempt.data,
      )
    }

    const token = extractBearerToken(redeemAttempt)
    if (token === undefined) {
      throw new PopProtocolError(
        `Registry accepted the redeeming PUT (${POP_TX_HASH_PARAM}=${txHash}) but did not return ` +
          `an ${POP_TOKEN_HEADER} header`,
      )
    }
    this.tokensByAddress.set(address, token)

    return {
      token,
      reusedToken: false,
      payment: {
        txHash,
        leaseIndex: handle.index,
        leaseAddress: handle.address,
        recipient: challenge.recipient,
        minValueWei: challenge.minValueWei,
      },
    }
  }
}
