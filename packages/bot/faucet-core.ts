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
/** Monad testnet chain id; the process wrapper refuses to run on any other chain. */
export const MONAD_TESTNET_CHAIN_ID = 10143n

export interface FaucetConfig {
  amountWei: bigint
  maxPerRun: number
  maxPerDay: number
  /** Never let the faucet wallet fall below this after a transfer. */
  minReserveWei: bigint
}

export function faucetConfigFromEnv(
  env: Record<string, string | undefined>,
): FaucetConfig {
  const bigint = (name: string, fallback: bigint): bigint => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    if (!/^\d+$/.test(raw))
      throw new Error(`${name} must be a non-negative integer`)
    return BigInt(raw)
  }
  const int = (name: string, fallback: number): number => {
    const value = bigint(name, BigInt(fallback))
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(`${name} is too large`)
    return Number(value)
  }
  const config: FaucetConfig = {
    amountWei: bigint('FAUCET_AMOUNT_WEI', 50_000_000_000_000_000n), // 0.05 MON
    maxPerRun: int('FAUCET_MAX_PER_RUN', 10),
    maxPerDay: int('FAUCET_MAX_PER_DAY', 20),
    minReserveWei: bigint('FAUCET_MIN_RESERVE_WEI', 100_000_000_000_000_000n), // 0.1 MON
  }
  if (config.amountWei === 0n) throw new Error('FAUCET_AMOUNT_WEI must be > 0')
  if (config.amountWei > MAX_AMOUNT_WEI) {
    throw new Error(
      `FAUCET_AMOUNT_WEI ${config.amountWei} exceeds the hard ceiling ${MAX_AMOUNT_WEI} wei (1 MON)`,
    )
  }
  return config
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
  getBalance(address: string): Promise<bigint>
  faucetAddress: string
  now?: () => number
}

export type FaucetOutcome =
  | { status: 'funded'; txHash: string; confirmed: boolean }
  | { status: 'skipped'; reason: string }
  /** Stop the batch; the profile is retried on a later poll. */
  | {
      status: 'stop'
      reason: 'run-cap' | 'daily-cap' | 'faucet-low' | 'error'
      error?: unknown
    }

export class Faucet {
  fundedThisRun = 0
  private readonly now: () => number

  constructor(private readonly deps: FaucetDeps) {
    this.now = deps.now ?? Date.now
  }

  async handleProfile(
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
      return { status: 'stop', reason: 'error', error }
    }

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

  /** Replays every persisted-but-unsubmitted transaction's exact bytes (never re-signs, so an
   * address can never be paid twice). Run on startup and before each poll. A replay the node
   * rejects (e.g. nonce already used) leaves the record for the operator; it is logged, not
   * retried with new bytes. Returns the number of records that moved to 'submitted'. */
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
      } catch (error) {
        console.error(
          `[faucet] could not replay ${record.txHash} for ${address}:`,
          error instanceof Error ? error.message : error,
        )
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
