/**
 * Shared setup for the bots: load or create a bot's identity, register its profile, load the
 * operator's main wallet, and open a bot's account-based wallet and directory entry.
 *
 * Bots send and read messages through the wallet's own message path
 * (`chain.directMessages`), the same one the app uses.
 */
import { readFileSync, existsSync, statSync, writeFileSync } from 'fs'
import { JsonRpcProvider } from 'ethers'

import { MonadHttpClient } from '@frank/wallet/monad-http'
import {
  MonadAccountTxSigner,
  MonadTxSubmitter,
} from '@frank/wallet/monad-account-tx'
import {
  fetchMonadProfile,
  MonadIdentity,
  MonadProfileFields,
  registerMonadIdentity,
  registerMonadIdentityCbor,
} from '@frank/wallet/monad-identity'
import type { ProfileInfo } from '@frank/wallet/chain/active-chain'
import { randomBytes } from 'crypto'
import {
  directMessageText,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import {
  canonicalNetworkDescriptor,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import type { MonadTxOverrides } from '@frank/wallet/monad-account-tx'
import {
  canonicalMonadStampClient,
  createEvmChain,
  loadMonadChainConfigFromEnv,
} from "@frank/wallet/chain/monad-chain";
import type { EvmChainConfig } from "@frank/wallet/chain/evm-chain-config";
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import { computeAddress } from 'ethers'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { Current } from '@frank/directory-admission'
import type { DirectoryFetch } from '@frank/cashweb/relay/directory-client'
import { directoryAddress } from '@frank/cashweb/relay/open-directory'
import {
  isOpenDirectoryError,
  openBotDirectory,
  publishBotDirectoryEntry,
} from './bot-open-directory'
import {
  fetchCanonicalInboxPage,
  type CanonicalMailboxAuthParams,
} from '@frank/cashweb/relay/monad-mailbox-client'
import {
  createCanonicalMessageRoles,
  prepareCanonicalStampInventory,
} from "@frank/wallet/chain/monad-chain";
import type { EvmChainWalletHandle } from "@frank/wallet/evm-wallet-handle";
export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var ${name}`)
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Loads an already-persisted identity and NEVER creates one: for read-only tooling (e.g.
 * `print-curated-defaults.ts`) that must not leave key files behind. */
export function loadExistingIdentity(
  identityJsonPath: string,
  label: string,
): MonadIdentity {
  if (!existsSync(identityJsonPath)) {
    throw new Error(
      `[${label}] no identity file at ${identityJsonPath} (start that bot once to create it)`,
    )
  }
  const saved = JSON.parse(readFileSync(identityJsonPath, 'utf8')) as {
    privateKeyHex: string
  }
  const identity = MonadIdentity.fromPrivateKeyHex(saved.privateKeyHex)
  console.log(`[${label}] loaded existing identity ${identity.displayAddress}`)
  return identity
}

/** Loads a `MonadIdentity` persisted (as `{ privateKeyHex }`) at `identityJsonPath`, or generates
 * and persists a fresh one if the file doesn't exist yet -- so re-running either script keeps
 * addressing the same identity (needed for the bot: the sender script has to know a stable
 * address to send its first message to) instead of registering a brand-new one every run.
 *
 * Ported from the original `FrankIdentity`/`lotus-identity.ts` version (ticket #9's original,
 * still-documented run in `QWEN_BOT_README.md` used that) to `MonadIdentity`/`monad-identity.ts`
 * once the real Frank UI's own identity/messaging stack (`ActiveChain`, tickets #41-#45) landed:
 * the UI's `MonadChain.directMessages` resolves a sender/recipient's pubkey via
 * `fetchMonadProfile`/`GET /metadata/monad/:addr`-or-dispatch, which only ever finds a
 * `MonadIdentity`-registered profile -- a Lotus-registered bot identity was invisible to, and
 * couldn't message, any real Monad wallet created through the app. See this file's own module docs
 * update and `QWEN_BOT_README.md` for the full before/after. */
export function loadOrCreateIdentity(
  identityJsonPath: string,
  label: string,
): MonadIdentity {
  if (existsSync(identityJsonPath)) {
    return loadExistingIdentity(identityJsonPath, label)
  }
  const identity = MonadIdentity.generate()
  writeFileSync(
    identityJsonPath,
    JSON.stringify({ privateKeyHex: identity.toPrivateKeyHex() }, null, 2),
    { mode: 0o600 }, // a private key: owner-only
  )
  console.log(
    `[${label}] generated fresh identity ${identity.displayAddress} (saved to ${identityJsonPath})`,
  )
  return identity
}

/** `PUT /metadata/:addr` for `identity`, logging the result -- registration is idempotent enough
 * to call on every run (`Registry::put_monad_profile`'s monotonic-timestamp check, ticket #45,
 * accepts a re-PUT as long as the new payload's timestamp is strictly greater than any existing
 * one, which `Date.now()` always is on a later run). */
export async function registerAndLog(params: {
  relayBaseUrl: string
  identity: MonadIdentity
  label: string
  /** Registers the self-declared bot marker (#311) so other bots skip this account. Defaults to
   * true -- every caller in this package except the human-simulating send demo is a bot. */
  bot?: boolean
  /** Public name/bio/avatar (#317), e.g. `botProfileFields('vendor')`. */
  profile?: MonadProfileFields
}): Promise<void> {
  const wanted: MonadProfileFields = {
    ...params.profile,
    bot: params.bot ?? true,
  }
  // Idempotent (#317): every re-PUT bumps the profile's registration timestamp, which shows up as
  // a "new registration" to anything watching the profile feed. Skip it when the relay already
  // holds exactly this profile.
  const existing = await fetchMonadProfile({
    relayBaseUrl: params.relayBaseUrl,
    address: params.identity.address,
  })
  if (existing && profileMatches(existing, wanted)) {
    console.log(
      `[${params.label}] profile for ${params.identity.displayAddress} already registered and unchanged`,
    )
    return
  }
  await registerMonadIdentityCbor({
    relayBaseUrl: params.relayBaseUrl,
    identity: params.identity,
    profile: wanted,
  })
  console.log(
    `[${params.label}] registered identity ${
      params.identity.displayAddress
    } as "${wanted.name ?? ''}" (PUT /metadata, no payment -- POP disabled)`,
  )
}

/** Whether the relay's stored profile already carries exactly the fields `wanted` would sign.
 * An unset wanted field must be absent remotely too, so removing a field re-registers. */
export function profileMatches(
  existing: ProfileInfo,
  wanted: MonadProfileFields,
): boolean {
  return (
    (existing.name ?? '') === (wanted.name ?? '') &&
    (existing.bio ?? '') === (wanted.bio ?? '') &&
    (existing.avatar ?? '') === (wanted.avatar ?? '') &&
    (existing.bot ?? false) === (wanted.bot ?? false)
  )
}

/** Waits (polling `getStatus`) for `txHash` to reach a terminal state, throwing if it fails or
 * never confirms within the poll budget -- same pattern `monad-e2e-demo.livecheck.ts` (#8) uses. */
export async function waitForConfirmation(
  signer: MonadAccountTxSigner,
  txHash: string,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await signer.getStatus(txHash)
    if (status === 'confirmed') return
    if (status === 'failed') {
      throw new Error(`${label} (${txHash}) failed on-chain`)
    }
    await sleep(2000)
  }
  throw new Error(`${label} (${txHash}) did not confirm within the poll budget`)
}

/** Loads the operator-supplied main wallet (`{address, privateKey}` JSON at `mainWalletJsonPath`)
 * as a transfer signer. The key is only ever passed to the signer, never logged. Shared by the
 * stamp-funded bots and the faucet (#316), which needs no stamp pool. */
export function loadMainAccountSigner(params: {
  rpcUrl: string
  mainWalletJsonPath: string
  httpClient?: MonadHttpClient
}): { provider: JsonRpcProvider; mainAccountSigner: MonadAccountTxSigner } {
  const provider = new JsonRpcProvider(params.rpcUrl)
  const httpClient =
    params.httpClient ?? new MonadHttpClient({ rpcUrl: params.rpcUrl })
  const mainWallet = JSON.parse(
    readFileSync(params.mainWalletJsonPath, 'utf8'),
  ) as { address: string; privateKey: string }
  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: mainWallet.privateKey,
    provider,
    httpClient,
  })
  return { provider, mainAccountSigner }
}

/** Open-directory view for the canonical bot. Every account signs its own entry and nobody
 * approves it, so a peer is any key whose published entry verifies: signed by the key that
 * hashes to its address, unexpired, and on the chain first seen for that address. */
export interface QwenCanonicalDirectory {
  /** Canonical network identifier of every entry, e.g. `monad-testnet`. */
  readonly network: string
  /** HTTPS root of the relay this bot is configured to use, with a trailing slash. */
  readonly homeEndpoint: string
  /** The bot's own compressed identity point P, lowercase hex. */
  readonly selfSubject: string
  selfCurrent(): Promise<Current>
  /** `undefined` when that key has no published entry, or its entry is refused or cannot be
   * read now. `refresh` asks for an answer the relay gave just now, not a remembered one. */
  peerCurrent(subject: string, refresh?: boolean): Promise<Current | undefined>
}

/** The one live typed wallet owner, opened through the public chain factory. Opening signs,
 * funds, replays and sends nothing. */
export interface QwenCanonicalWallet {
  readonly handle: EvmChainWalletHandle
  /** The typed economic account that funds and pays reply stamps. Public; safe to log. */
  readonly accountAddress: string
  /** The bot's compressed identity point P and the mailbox address derived from it. */
  readonly subject: string
  readonly identityAddress: string
  close(): Promise<void>
}

/** The env-configured chain row with Qwen's own relay and a durable canonical wallet root. */
export function qwenCanonicalChainConfig(params: {
  relayBaseUrl: string
  walletStorageLocation: string
  stampValueWei: bigint
}): EvmChainConfig {
  return {
    ...loadMonadChainConfigFromEnv(),
    relayBaseUrl: params.relayBaseUrl,
    walletStorageLocation: params.walletStorageLocation,
    defaultStampValueWei: params.stampValueWei,
  }
}

const ROOT_PURPOSES = {
  evm: 'evm-wallet',
  authentication: 'identity-authentication',
  messaging: 'messaging-encryption',
} as const

/** First run only: three distinct random roots in the shape the loader reads, owner-only,
 * created exclusively so a file that already exists is never replaced. Returns false when the
 * file turned out to exist. */
function createQwenCanonicalRoots(rootsJsonPath: string): boolean {
  let roots: string[]
  do {
    roots = [0, 1, 2].map(() => randomBytes(32).toString('hex'))
  } while (new Set(roots).size !== 3)
  mkdirSync(dirname(rootsJsonPath), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(
      rootsJsonPath,
      JSON.stringify({
        registry: 'frank-domain-roots-v1',
        roots: {
          [ROOT_PURPOSES.evm]: roots[0],
          [ROOT_PURPOSES.authentication]: roots[1],
          [ROOT_PURPOSES.messaging]: roots[2],
        },
      }) + '\n',
      { mode: 0o600, flag: 'wx' },
    )
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') return false
    throw new Error(
      `Qwen canonical roots could not be created at ${rootsJsonPath}`,
    )
  }
  return true
}

/** Loads the bot's typed root bundle. When nothing exists at the path, disposable roots are
 * created there first (mode 0600) and only that fact and the path are logged. An existing file
 * is never replaced: one that others can read, or that is not a roots bundle, is refused.
 * Failures name only the path, never file contents. */
export function loadQwenCanonicalRoots(rootsJsonPath: string): MonadRootBundle {
  const invalid = () =>
    new Error(
      `Qwen canonical roots at ${rootsJsonPath} are unreadable or not a frank-domain-roots-v1 bundle`,
    )
  const modeOf = (): number | undefined => {
    try {
      return statSync(rootsJsonPath).mode
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT')
        return undefined
      throw invalid()
    }
  }
  let saved: { registry?: unknown; roots?: Record<string, unknown> }
  let mode = modeOf()
  if (mode === undefined) {
    if (createQwenCanonicalRoots(rootsJsonPath))
      console.log(`[bot] created canonical roots file at ${rootsJsonPath}`)
    mode = modeOf()
    if (mode === undefined) throw invalid()
  }
  // Secret material: readable or writable by the owner only.
  if (process.platform !== 'win32' && (mode & 0o077) !== 0)
    throw new QwenStartRefusal('roots-file-permissions')
  try {
    saved = JSON.parse(readFileSync(rootsJsonPath, 'utf8'))
  } catch {
    throw invalid()
  }
  if (
    !saved ||
    saved.registry !== 'frank-domain-roots-v1' ||
    !saved.roots ||
    typeof saved.roots !== 'object'
  )
    throw invalid()
  const root = <P extends (typeof ROOT_PURPOSES)[keyof typeof ROOT_PURPOSES]>(
    purpose: P,
  ) => {
    const hex = saved.roots![purpose]
    if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw invalid()
    return {
      registry: 'frank-domain-roots-v1' as const,
      purpose,
      bytes: new Uint8Array(Buffer.from(hex, 'hex')),
    }
  }
  return {
    evm: root(ROOT_PURPOSES.evm),
    authentication: root(ROOT_PURPOSES.authentication),
    messaging: root(ROOT_PURPOSES.messaging),
  }
}

/** A configuration the bot will not start with. `code` is a fixed public word list, safe to
 * print; it never carries file contents, keys or provider text. */
export class QwenStartRefusal extends Error {
  constructor(readonly code: string) {
    super(`Qwen bot refusing to start: ${code}`)
    this.name = 'QwenStartRefusal'
  }
}

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

export async function openQwenCanonicalWallet(params: {
  chain: EvmChainConfig
  roots: MonadRootBundle
}): Promise<QwenCanonicalWallet> {
  if (params.chain.networkTag !== 'MONT' && params.chain.networkTag !== 'MON1')
    throw new QwenStartRefusal('network-not-monad')
  if (params.chain.walletStorageLocation === false)
    throw new QwenStartRefusal('wallet-storage-not-durable')
  const handle = (await createEvmChain(params.chain).createWallet(
    params.roots,
  )) as unknown as EvmChainWalletHandle
  try {
    const subject = hexOf(handle.identity.compressedPubKey)
    return {
      handle,
      accountAddress: (await handle.getReceiveAddress()).raw,
      subject,
      identityAddress: computeAddress('0x' + subject).toLowerCase(),
      close: () => handle.close(),
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export interface QwenOpenDirectory extends QwenCanonicalDirectory {
  /** Make sure this bot's own entry is current on its relay: adopt the one the relay already
   * holds for this key, sign and publish revision zero when it holds none, renew or move it
   * when needed. Throws a typed `OpenDirectoryError` when that is not possible now. */
  publish(): Promise<void>
  close(): Promise<void>
}

/** A forced peer read counts as fresh when the relay answered for that key this recently. */
const PEER_FRESH_MS = 5_000
const REFUSAL_LOG_LIMIT = 1024

/**
 * The bot's open directory over Node storage: the shared `openDirectory` with Level admission
 * stores under `location` (public evidence only), signing the bot's own entry with its live typed
 * wallet. Nothing is requested, signed or published until `publish()` or a peer read.
 *
 * A peer is any sender key. Its entry is fetched from the bot's relay, accepted only when the
 * key that signed it hashes to the sender's address, pinned to the first chain seen, and reused
 * for about 30 seconds. No sender is configured anywhere.
 */
export function openQwenDirectory(params: {
  wallet: Pick<QwenCanonicalWallet, 'handle' | 'subject'>
  networkTag: 'MONT' | 'MON1'
  /** The relay this bot lives on. Its entry is published to and peers are read from it. */
  relayBaseUrl: string
  /** Durable directory root, separate from wallet and bot state. */
  location: string
  fetch: DirectoryFetch
  nowNs?: () => bigint
}): QwenOpenDirectory {
  // When the relay last answered a head read for a key, so a forced read can tell an answer the
  // relay gave just now from one the shared directory remembered.
  const answeredAt = new Map<string, number>()
  const headRead = /\/directory\/v1\/[^/]+\/((?:02|03)[0-9a-f]{64})\/head$/
  const directory = openBotDirectory({
    handle: params.wallet.handle,
    subject: params.wallet.subject,
    networkTag: params.networkTag,
    relayBaseUrl: params.relayBaseUrl,
    location: params.location,
    nowNs: params.nowNs,
    fetch: async (url, init) => {
      const response = await params.fetch(url, init)
      const read = init.method === 'GET' ? headRead.exec(url) : null
      if (read && (response.status === 200 || response.status === 404))
        answeredAt.set(read[1], Date.now())
      return response
    },
  })
  const refusals = new Map<string, string>()
  return {
    network: directory.network,
    homeEndpoint: directory.homeEndpoint,
    selfSubject: params.wallet.subject,
    async publish() {
      await directory.publish()
    },
    selfCurrent: () => directory.selfCurrent(),
    async peerCurrent(subject, refresh = false) {
      const key = subject.toLowerCase()
      try {
        const entry = await directory.peerCurrent({ subject: key })
        if (!entry) return undefined
        refusals.delete(key)
        // The shared directory reuses a recent entry. A forced read is only satisfied by one
        // the relay served just now; otherwise there is nothing fresh to decide against yet.
        if (refresh && Date.now() - (answeredAt.get(key) ?? 0) > PEER_FRESH_MS)
          return undefined
        return entry.current
      } catch (error) {
        // Refused (not signed by that address, expired, rolled back, forked) or not readable
        // now: not usable. Logged once per change, with the fixed reason word only.
        const code = isOpenDirectoryError(error) ? error.code : 'storage'
        if (refusals.get(key) !== code) {
          if (refusals.size >= REFUSAL_LOG_LIMIT) refusals.clear()
          refusals.set(key, code)
          console.warn(
            `[bot] directory entry of ${
              directoryAddress(key) ?? 'a malformed sender key'
            } not usable: ${code}`,
          )
        }
        return undefined
      }
    },
    close: () => directory.close(),
  }
}

/**
 * Publishes the bot's own directory entry and returns only once the relay holds it; see
 * `publishBotDirectoryEntry`, the one implementation every bot uses.
 */
export const publishQwenDirectoryEntry = publishBotDirectoryEntry
