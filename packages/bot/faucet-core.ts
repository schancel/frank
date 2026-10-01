/**
 * Testnet faucet logic (#316), separated from the `faucet-bot.livecheck.ts` process wrapper so it
 * can be tested with fakes (no chain, no keys, no network).
 *
 * Funds each newly registered profile at most once, from a wallet the operator supplies, with an
 * LLM-free path. Safety properties (each covered by a test):
 * - once per address, durable across restarts and address casing: the signed transaction is
 *   persisted BEFORE broadcast and any record, in any state, blocks re-funding;
 * - never funds ourselves, a denylisted address, or a self-declared bot (#311's marker);
 * - caps per run and per rolling 24h; a cap stops the batch WITHOUT advancing the cursor, so users
 *   behind it are served later rather than skipped forever;
 * - never spends below a reserve, never funds an address that already has enough;
 * - hard ceiling on the per-address amount so a typo cannot drain the wallet.
 *
 * Abuse limits (demo level, by design): registration costs nothing, so an attacker can mint many
 * addresses and collect `amountWei` for each until a cap hits. The daily cap bounds the loss to
 * `maxPerDay * amountWei` and the reserve protects the wallet floor; there is no captcha, proof of
 * humanity or per-IP limit. Testnet MON has no value; do not point this at a real-value network.
 */
import { join, resolve, sep } from 'path'

import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata } = __pb_registry_metadata_pb
import __pb_signed_payload_payload_pb from '@frank/cashweb/signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb

import { BotLoopGuard } from './bot-loop-guard'
import { FaucetStateStore } from './faucet-state'

type SignedPayloadMsg = InstanceType<typeof SignedPayload>

export const DAY_MS = 24 * 60 * 60 * 1000
/** Hard ceiling for `FAUCET_AMOUNT_WEI`: 1 MON. */
export const MAX_AMOUNT_WEI = 1_000_000_000_000_000_000n
/** The reserve must cover the gas of in-flight transfers; 0.01 MON is far above a testnet
 * transfer's cost, and 0 would let the wallet be drained to nothing. */
export const MIN_RESERVE_FLOOR_WEI = 10_000_000_000_000_000n
export const MAX_PER_DAY_CEILING = 1000
export const MIN_POLL_INTERVAL_MS = 1000
export const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000
/** Consecutive per-address failures (with the RPC itself healthy) before a profile is skipped. */
export const MAX_PROFILE_FAILURES = 3
/** Errors that are not clearly about the address itself need many failures spread over time, so a
 * flaky RPC cannot mark a legitimate user skipped. */
export const MAX_UNCLASSIFIED_FAILURES = 10
export const UNCLASSIFIED_FAILURE_SPREAD_MS = 10 * 60 * 1000
/** A `submitted` transfer without a receipt is re-checked after this long (and at most this often). */
export const RECHECK_SUBMITTED_AFTER_MS = 5 * 60 * 1000

export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export type TxLookup = 'confirmed' | 'failed' | 'pending' | 'unknown'

const TRANSIENT_ERROR =
  /timeout|timed out|econn|enotfound|eai_again|network[_ ]error|socket|fetch failed|server[_ ]error|\b(429|502|503|504)\b|rate.?limit|too many requests|service unavailable/i
const MALFORMED_ADDRESS_ERROR =
  /invalid (address|argument)|malformed|bad address|bad checksum|invalid checksum|INVALID_ARGUMENT/i

/** How a failure before signing counts toward skipping the profile. */
export function classifyProfileError(
  error: unknown,
): 'transient' | 'malformed' | 'unclassified' {
  const text = `${(error as { code?: unknown })?.code ?? ''} ${
    error instanceof Error ? error.message : String(error)
  }`
  if (MALFORMED_ADDRESS_ERROR.test(text) && !/timeout|network/i.test(text)) {
    return 'malformed'
  }
  if (TRANSIENT_ERROR.test(text)) return 'transient'
  return 'unclassified'
}
/** Monad testnet chain id; the process wrapper refuses to run on any other chain. */
export const MONAD_TESTNET_CHAIN_ID = 10143n
export const TESTNET_NETWORK_TAG = 'MONT'

export interface FaucetConfig {
  amountWei: bigint
  maxPerRun: number
  maxPerDay: number
  /** Never let the faucet wallet fall below this after a transfer. */
  minReserveWei: bigint
}

export interface FaucetSettings {
  config: FaucetConfig
  stateDir: string
  pollIntervalMs: number
  /** First-run profile cursor override; `undefined` means "now". */
  profileSinceMs?: number
}

function parseUint(
  env: Record<string, string | undefined>,
  name: string,
  fallback: bigint | undefined,
): bigint | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`)
  }
  return BigInt(raw)
}

function parseIntInRange(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  const value = parseUint(
    env,
    name,
    fallback === undefined ? undefined : BigInt(fallback),
  )
  if (value === undefined) return undefined
  if (value < BigInt(min) || value > BigInt(max)) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`)
  }
  return Number(value)
}

export function faucetConfigFromEnv(
  env: Record<string, string | undefined>,
): FaucetConfig {
  const amountWei = parseUint(
    env,
    'FAUCET_AMOUNT_WEI',
    50_000_000_000_000_000n,
  )! // 0.05 MON
  if (amountWei === 0n) throw new Error('FAUCET_AMOUNT_WEI must be > 0')
  if (amountWei > MAX_AMOUNT_WEI) {
    throw new Error(
      `FAUCET_AMOUNT_WEI ${amountWei} exceeds the hard ceiling ${MAX_AMOUNT_WEI} wei (1 MON)`,
    )
  }
  const minReserveWei = parseUint(
    env,
    'FAUCET_MIN_RESERVE_WEI',
    100_000_000_000_000_000n, // 0.1 MON
  )!
  if (minReserveWei < MIN_RESERVE_FLOOR_WEI) {
    throw new Error(
      `FAUCET_MIN_RESERVE_WEI must be at least ${MIN_RESERVE_FLOOR_WEI} wei (0.01 MON): the reserve has to cover the gas of in-flight transfers`,
    )
  }
  return {
    amountWei,
    maxPerRun: parseIntInRange(env, 'FAUCET_MAX_PER_RUN', 10, 1, 10_000)!,
    maxPerDay: parseIntInRange(
      env,
      'FAUCET_MAX_PER_DAY',
      20,
      1,
      MAX_PER_DAY_CEILING,
    )!,
    minReserveWei,
  }
}

/** All process settings, validated up front so a bad value fails startup with a clear message
 * instead of turning into NaN or a tight loop later. `home` is the user's home directory. */
/** State directory from env, without validating anything else (admin commands need only this). */
export function faucetStateDirFromEnv(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return env.FAUCET_STATE_DIR || join(home, '.frank-faucet')
}

export function faucetSettingsFromEnv(
  env: Record<string, string | undefined>,
  home: string,
): FaucetSettings {
  return {
    config: faucetConfigFromEnv(env),
    // A persistent per-user default: the state is the only thing preventing double funding, so it
    // must not live in a directory the OS clears.
    stateDir: faucetStateDirFromEnv(env, home),
    pollIntervalMs: parseIntInRange(
      env,
      'FAUCET_POLL_INTERVAL_MS',
      4000,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    )!,
    profileSinceMs: parseIntInRange(
      env,
      'FAUCET_PROFILE_SINCE_MS',
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  }
}

/** Testnet-only guard, pure so it is tested: throws unless both the configured network tag and
 * the RPC's chain id are Monad testnet. */
export function assertTestnet(params: {
  networkTag: string
  chainId: bigint
}): void {
  if (params.networkTag !== TESTNET_NETWORK_TAG) {
    throw new Error(
      `Refusing to run: FRANK_NETWORK_TAG is "${params.networkTag}", the faucet is testnet-only (${TESTNET_NETWORK_TAG})`,
    )
  }
  if (params.chainId !== MONAD_TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing to run: RPC reports chain id ${params.chainId}, the faucet only runs on Monad testnet (${MONAD_TESTNET_CHAIN_ID})`,
    )
  }
}

/** A warning when the durable state would live somewhere the OS may clear (it is what prevents
 * funding an address twice). */
export function stateDirWarning(
  stateDir: string,
  tmpDirs: readonly string[],
): string | undefined {
  const dir = resolve(stateDir)
  const under = tmpDirs
    .map(tmp => resolve(tmp))
    .some(tmp => dir === tmp || dir.startsWith(tmp + sep))
  return under
    ? `FAUCET_STATE_DIR ${dir} is under a temporary directory; if it is cleared, every address can be funded again. Use a persistent path.`
    : undefined
}

/** A warning for a wallet JSON readable by group/others (it holds a private key). `mode` is
 * `fs.Stats.mode`. */
export function keyFilePermissionWarning(
  path: string,
  mode: number,
): string | undefined {
  return (mode & 0o077) !== 0
    ? `wallet file ${path} is accessible to group/others (mode ${(
        mode & 0o777
      ).toString(8)}); restrict it with chmod 600`
    : undefined
}

export interface FaucetSignedTx {
  rawTx: string
  txHash: string
}

export interface FaucetDeps {
  store: FaucetStateStore
  guard: BotLoopGuard
  config: FaucetConfig
  signTransfer(to: string, valueWei: bigint): Promise<FaucetSignedTx>
  /** Broadcasts exactly these signed bytes (idempotent for identical bytes). */
  submitRaw(tx: FaucetSignedTx): Promise<void>
  waitForConfirmation(txHash: string): Promise<void>
  /** Lookup by hash: a receipt (`confirmed`/`failed`), else `pending` if the node knows the tx
   * (mempool), else `unknown` (never seen or dropped). */
  getTxStatus(txHash: string): Promise<TxLookup>
  getBalance(address: string): Promise<bigint>
  faucetAddress: string
  now?: () => number
  log?: (message: string) => void
}

export type FaucetOutcome =
  | { status: 'funded'; txHash: string; confirmed: boolean }
  | { status: 'skipped'; reason: string }
  /** Stop the batch; the profile is retried on a later poll. */
  | {
      status: 'stop'
      reason:
        | 'run-cap'
        | 'daily-cap'
        | 'faucet-low'
        | 'unsettled'
        | 'error'
        | 'rpc-down'
      error?: unknown
    }

export class Faucet {
  fundedThisRun = 0
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly loggedOnce = new Set<string>()
  private readonly failures = new Map<
    string,
    { count: number; firstAt: number }
  >()
  private readonly lastRechecked = new Map<string, number>()
  /** Serializes handleProfile: the check-then-sign-then-persist sequence is not atomic across
   * awaits, so two concurrent calls (even for different addresses, which would sign with the same
   * nonce) must never interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: FaucetDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (message => console.log(`[faucet] ${message}`))
  }

  /** Logs `message` the first time `key` is seen, so a condition that persists across polls is
   * reported once per state change, not once per poll. */
  private logOnce(key: string, message: string): void {
    if (this.loggedOnce.has(key)) return
    this.loggedOnce.add(key)
    this.log(message)
  }

  handleProfile(
    address: string,
    signedPayload: SignedPayloadMsg,
  ): Promise<FaucetOutcome> {
    const run = this.queue.then(() =>
      this.handleProfileSerialized(address, signedPayload),
    )
    this.queue = run.catch(() => undefined)
    return run
  }

  private async handleProfileSerialized(
    address: string,
    signedPayload: SignedPayloadMsg,
  ): Promise<FaucetOutcome> {
    // Validate before any RPC: with ethers, a malformed address ('abc', '0x1234', 'foo.eth') fails
    // with errors that look transient, and would otherwise stall the cursor forever.
    if (!EVM_ADDRESS.test(address)) {
      return { status: 'skipped', reason: 'invalid-address' }
    }
    const { store, guard, config } = this.deps
    const blocked = guard.profileBlockReason(address, signedPayload)
    if (blocked) return { status: 'skipped', reason: blocked }
    if (store.get(address))
      return { status: 'skipped', reason: 'already-funded' }
    if (this.fundedThisRun >= config.maxPerRun) {
      return { status: 'stop', reason: 'run-cap' }
    }
    if (store.countSince(this.now() - DAY_MS) >= config.maxPerDay) {
      return { status: 'stop', reason: 'daily-cap' }
    }
    // A signed-but-unsettled transfer owns the wallet's next nonce; signing another now could
    // reuse it and kill the earlier transfer, leaving its user unfunded.
    if (store.signedRecords().length > 0) {
      return { status: 'stop', reason: 'unsettled' }
    }

    let signed: FaucetSignedTx
    try {
      if ((await this.deps.getBalance(address)) >= config.amountWei) {
        return { status: 'skipped', reason: 'has-funds' }
      }
      const faucetBalance = await this.deps.getBalance(this.deps.faucetAddress)
      if (faucetBalance < config.amountWei + config.minReserveWei) {
        return { status: 'stop', reason: 'faucet-low' }
      }
      signed = await this.deps.signTransfer(address, config.amountWei)
    } catch (error) {
      return this.handleProfileFailure(address, error)
    }
    this.failures.delete(address.toLowerCase())

    // Persist the exact signed transaction BEFORE broadcasting (see FaucetStateStore).
    await store.put(address, {
      state: 'signed',
      amountWei: config.amountWei.toString(),
      at: this.now(),
      txHash: signed.txHash,
      rawTx: signed.rawTx,
    })
    this.fundedThisRun++
    try {
      await this.deps.submitRaw(signed)
    } catch (error) {
      // The record stays 'signed': never re-signed, only replayed byte for byte by recoverSigned().
      return { status: 'stop', reason: 'error', error }
    }
    const record = store.get(address)!
    await store.put(address, {
      ...record,
      state: 'submitted',
      broadcastAt: this.now(),
    })
    try {
      await this.deps.waitForConfirmation(signed.txHash)
      await store.put(address, { ...store.get(address)!, state: 'confirmed' })
      return { status: 'funded', txHash: signed.txHash, confirmed: true }
    } catch {
      return { status: 'funded', txHash: signed.txHash, confirmed: false }
    }
  }

  /** A failure before anything was signed. If the faucet's own RPC calls also fail it is an
   * outage: stop and retry, never blame the profile. Otherwise the profile itself is bad (e.g.
   * a malformed address): after MAX_PROFILE_FAILURES consecutive failures record it as skipped so
   * it cannot block everyone behind it forever. */
  private async handleProfileFailure(
    address: string,
    error: unknown,
  ): Promise<FaucetOutcome> {
    try {
      await this.deps.getBalance(this.deps.faucetAddress)
    } catch {
      return { status: 'stop', reason: 'rpc-down', error }
    }
    const kind = classifyProfileError(error)
    // A transient error (timeouts, 5xx, rate limits) says nothing about the profile.
    if (kind === 'transient') return { status: 'stop', reason: 'error', error }
    const key = address.toLowerCase()
    const now = this.now()
    const previous = this.failures.get(key)
    const entry = {
      count: (previous?.count ?? 0) + 1,
      firstAt: previous?.firstAt ?? now,
    }
    this.failures.set(key, entry)
    const count = entry.count
    const enough =
      kind === 'malformed'
        ? count >= MAX_PROFILE_FAILURES
        : count >= MAX_UNCLASSIFIED_FAILURES &&
          now - entry.firstAt >= UNCLASSIFIED_FAILURE_SPREAD_MS
    if (!enough) {
      return { status: 'stop', reason: 'error', error }
    }
    this.failures.delete(key)
    this.log(
      `skipping ${address} after ${count} consecutive failures: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    await this.deps.store.put(address, {
      state: 'skipped',
      amountWei: '0',
      at: this.now(),
      txHash: '',
      rawTx: '',
    })
    return { status: 'skipped', reason: 'repeated-failure' }
  }

  /** Replays every persisted-but-unsettled transaction's exact bytes (never re-signs, so an
   * address can never be paid twice). Run on startup and before each poll. If the node rejects
   * the replay (already known, nonce too low, ...) the receipt is looked up by hash: mined means
   * the record moves on; otherwise it is left alone and reported ONCE per state (see
   * `--list-stuck` / `--clear` in faucet-bot.livecheck.ts for the operator path). Returns the
   * number of records that were settled or accepted. */
  async recoverSigned(): Promise<number> {
    let recovered = 0
    for (const [address, record] of this.deps.store.signedRecords()) {
      try {
        await this.deps.submitRaw({
          rawTx: record.rawTx,
          txHash: record.txHash,
        })
        await this.deps.store.put(address, {
          ...record,
          state: 'submitted',
          broadcastAt: this.now(),
        })
        recovered++
        continue
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        let status: TxLookup = 'pending'
        try {
          status = await this.deps.getTxStatus(record.txHash)
        } catch {
          // treated as pending; the next poll asks again
        }
        if (status === 'confirmed') {
          await this.deps.store.put(address, { ...record, state: 'confirmed' })
          this.log(`${record.txHash} for ${address} was already mined`)
          recovered++
        } else if (status === 'failed') {
          await this.deps.store.put(address, { ...record, state: 'failed' })
          this.log(
            `${record.txHash} for ${address} was mined but reverted; address left unfunded (clear with --clear ${address})`,
          )
        } else {
          this.logOnce(
            `${record.txHash}:${reason}`,
            `replay of ${record.txHash} for ${address} rejected (${reason}) and it has no receipt; waiting. If it stays stuck: yarn faucet --list-stuck, then --clear ${address} once you have confirmed it never landed`,
          )
        }
      }
    }
    return recovered
  }

  /** Bounded re-check of `submitted` transfers whose confirmation was never seen (a dropped tx
   * would otherwise leave that user unfunded, silently). Due records are looked up by hash at
   * most every RECHECK_SUBMITTED_AFTER_MS: a receipt settles them; a tx the node no longer knows
   * and has no receipt for is marked `failed` so it shows in `--list-stuck`. Fail-safe: this
   * never re-funds or clears anything; the operator decides. */
  async recheckSubmitted(): Promise<number> {
    let changed = 0
    const now = this.now()
    for (const [address, record] of this.deps.store.submittedRecords()) {
      // Measured from the (re)broadcast, not the original signing: after a long outage the node
      // and indexers need time before the tx can be expected to show up.
      if (now - (record.broadcastAt ?? record.at) < RECHECK_SUBMITTED_AFTER_MS)
        continue
      const last = this.lastRechecked.get(record.txHash)
      if (last !== undefined && now - last < RECHECK_SUBMITTED_AFTER_MS)
        continue
      this.lastRechecked.set(record.txHash, now)
      let status: TxLookup
      try {
        status = await this.deps.getTxStatus(record.txHash)
      } catch {
        continue // node unreachable: ask again later
      }
      if (status === 'confirmed') {
        await this.deps.store.put(address, { ...record, state: 'confirmed' })
        changed++
      } else if (status === 'failed' || status === 'unknown') {
        await this.deps.store.put(address, { ...record, state: 'failed' })
        this.log(
          `${record.txHash} for ${address} ${
            status === 'failed'
              ? 'was mined but reverted'
              : 'is gone from the node with no receipt'
          }; address left unfunded (see --list-stuck)`,
        )
        changed++
      }
    }
    return changed
  }

  /** Handles one poll's profiles in registration order. Returns the cursor to persist: the
   * registration time of the last profile fully handled (NOT +1: equal-timestamp registrations
   * are re-fetched, and are harmless because every profile is deduplicated by the store), or
   * `since` unchanged if the batch stopped on its first profile. A stop leaves the stopping
   * profile (and everything after) unconsumed. */
  async pollOnce(
    profiles: Array<{ address: string; signedPayload: SignedPayloadMsg }>,
    since: number,
  ): Promise<{ cursor: number; stopped?: string }> {
    let cursor = since
    for (const profile of profiles) {
      const outcome = await this.handleProfile(
        profile.address,
        profile.signedPayload,
      )
      if (outcome.status === 'stop') {
        return { cursor, stopped: outcome.reason }
      }
      cursor = Math.max(
        cursor,
        AddressMetadata.deserializeBinary(
          profile.signedPayload.getPayload_asU8(),
        ).getTimestamp(),
      )
    }
    return { cursor }
  }
}

/** Operator commands on the durable state. `--list-stuck` prints records that are not settled.
 * `--clear <address>` deletes one so the address may be funded again, which is DANGEROUS: the
 * record is the only thing preventing a second payment. Rules:
 * - `submitted`/`confirmed` (paid) are never cleared;
 * - if the node can be asked (`lookup`), a tx that is mined or in its mempool is never cleared;
 * - a `signed` record may have been broadcast (a timeout after the node accepted it looks the
 *   same), so it needs `--force --confirm-tx <txHash>` even when the node has never heard of it.
 * Returns lines to print. */
export async function faucetAdmin(
  store: FaucetStateStore,
  args: readonly string[],
  lookup?: (txHash: string) => Promise<TxLookup>,
): Promise<string[] | undefined> {
  if (args.includes('--list-stuck')) {
    const stuck = store.unsettledRecords()
    return stuck.length === 0
      ? ['no stuck records']
      : stuck.map(
          ([address, r]) =>
            `${address} state=${r.state} tx=${r.txHash || '-'} at=${new Date(
              r.at,
            ).toISOString()}`,
        )
  }
  const at = args.indexOf('--clear')
  if (at === -1) return undefined
  const address = args[at + 1]
  const record = address ? store.get(address) : undefined
  if (!address || !record) {
    return [`no record for ${address ?? '(missing address)'}`]
  }
  if (record.state === 'submitted' || record.state === 'confirmed') {
    return [
      `refusing to clear ${address}: state is ${record.state} (it was paid)`,
    ]
  }
  if (record.txHash) {
    if (lookup) {
      let seen: TxLookup
      try {
        seen = await lookup(record.txHash)
      } catch (error) {
        return [
          `refusing to clear ${address}: could not ask the node about ${
            record.txHash
          } (${error instanceof Error ? error.message : String(error)})`,
        ]
      }
      if (seen === 'confirmed' || seen === 'pending') {
        return [
          `refusing to clear ${address}: tx ${record.txHash} is ${
            seen === 'confirmed' ? 'mined' : 'in the node mempool'
          }; the address was (or is about to be) paid`,
        ]
      }
    }
    // A `failed` record with a hash but no node lookup may only mean "the node did not know the
    // tx" (recheckSubmitted): it can still land, so it needs the same explicit confirmation.
    if (record.state === 'signed' || (record.state === 'failed' && !lookup)) {
      const confirm = args[args.indexOf('--confirm-tx') + 1]
      const confirmed =
        args.includes('--force') &&
        args.includes('--confirm-tx') &&
        confirm?.toLowerCase() === record.txHash.toLowerCase()
      if (!confirmed) {
        return [
          `refusing to clear ${address}: state is ${record.state}, so tx ${record.txHash} may already have been broadcast or may still land (a timeout after the node accepted it looks identical). Clearing lets the address be paid a SECOND time.`,
          lookup
            ? 'The node does not know this tx right now.'
            : 'No RPC was consulted (set MONAD_TESTNET_HTTP_RPC_URL to check the node).',
          `If you are certain it never landed, re-run with: --clear ${address} --force --confirm-tx ${record.txHash}`,
        ]
      }
      await store.delete(address)
      return [
        `WARNING: forced clear of a ${record.state} record; tx ${record.txHash} may still land and pay ${address} twice.`,
        `cleared ${address} (was ${record.state}); it may be funded again`,
      ]
    }
  }
  await store.delete(address)
  return [`cleared ${address} (was ${record.state}); it may be funded again`]
}
