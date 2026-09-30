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
export function faucetSettingsFromEnv(
  env: Record<string, string | undefined>,
  home: string,
): FaucetSettings {
  return {
    config: faucetConfigFromEnv(env),
    // A persistent per-user default: the state is the only thing preventing double funding, so it
    // must not live in a directory the OS clears.
    stateDir: env.FAUCET_STATE_DIR || join(home, '.frank-faucet'),
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
  /** Receipt lookup by hash; `'pending'` covers both "in the mempool" and "unknown". */
  getTxStatus(txHash: string): Promise<'pending' | 'confirmed' | 'failed'>
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
  private readonly failures = new Map<string, number>()
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
    await store.put(address, { ...record, state: 'submitted' })
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
    const key = address.toLowerCase()
    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)
    if (count < MAX_PROFILE_FAILURES) {
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
        await this.deps.store.put(address, { ...record, state: 'submitted' })
        recovered++
        continue
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        let status: 'pending' | 'confirmed' | 'failed' = 'pending'
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

/** Operator commands on the durable state, with no wallet or RPC needed. `--list-stuck` prints
 * records that are not settled; `--clear <address>` deletes one so the address may be funded
 * again (only do this after confirming on an explorer that its transaction never landed: the
 * record is the only thing preventing a second payment). Returns lines to print. */
export async function faucetAdmin(
  store: FaucetStateStore,
  args: readonly string[],
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
  if (at !== -1) {
    const address = args[at + 1]
    const record = address ? store.get(address) : undefined
    if (!address || !record)
      return [`no record for ${address ?? '(missing address)'}`]
    if (record.state === 'submitted' || record.state === 'confirmed') {
      return [
        `refusing to clear ${address}: state is ${record.state} (it was paid)`,
      ]
    }
    await store.delete(address)
    return [`cleared ${address} (was ${record.state}); it may be funded again`]
  }
  return undefined
}
