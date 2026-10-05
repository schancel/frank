/**
 * The open directory for a headless bot: one implementation used by every bot.
 *
 * A bot is an ordinary account. It signs its own directory entry with its live typed wallet,
 * publishes it to the relay it lives on, and can then message any address that has published an
 * entry of its own. Nothing about another account is configured anywhere.
 *
 * Storage is `nodeDirectoryStorage` (Level admission stores plus small pin and checkpoint files)
 * under a directory the caller chooses; it holds public evidence only.
 */
import type { DirectoryFetch } from '@frank/cashweb/relay/directory-client'
import { canonicalNetworkDescriptor } from '@frank/cashweb/relay/canonical-dm-transport'
import {
  OpenDirectoryError,
  openDirectory,
  type OpenDirectory,
  type OpenDirectoryErrorCode,
} from '@frank/cashweb/relay/open-directory'
import { nodeDirectoryStorage } from '@frank/cashweb/relay/open-directory-node'
import {
  prepareMonadNextRevisionExport,
  prepareMonadRevisionZeroExport,
  type MonadChainWalletHandle,
} from '@frank/wallet/chain/monad-chain'

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/** The compressed signing key (66 hex characters) of a live typed wallet. */
export function botDirectorySubject(handle: MonadChainWalletHandle): string {
  return hexOf(handle.identity.compressedPubKey)
}

/**
 * Opens the shared `openDirectory` over Node storage for one bot wallet. Nothing is requested,
 * signed or published until `publish()` or a peer read.
 */
export function openBotDirectory(params: {
  /** The bot's live typed wallet; it signs the bot's own entry. */
  handle: MonadChainWalletHandle
  /** The wallet's compressed signing key, when the caller already holds it. */
  subject?: string
  networkTag: 'MONT' | 'MON1'
  /** The relay this bot lives on. Its entry is published to and peers are read from it. */
  relayBaseUrl: string
  /** Durable directory root, separate from wallet and bot state. */
  location: string
  /** Defaults to the global `fetch`. */
  fetch?: DirectoryFetch
  nowNs?: () => bigint
}): OpenDirectory {
  const { tag, network, chainId } = canonicalNetworkDescriptor(
    params.networkTag,
  )
  const descriptor = { networkTag: tag, network, chainId }
  const handle = params.handle
  return openDirectory({
    network,
    relayBaseUrl: params.relayBaseUrl,
    nowNs: params.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n),
    fetch:
      params.fetch ??
      ((url, init) =>
        (globalThis as unknown as { fetch: DirectoryFetch }).fetch(url, init)),
    ...nodeDirectoryStorage(params.location),
    self: {
      subject: params.subject ?? botDirectorySubject(handle),
      signRevisionZero: input =>
        prepareMonadRevisionZeroExport(handle, { ...descriptor, ...input })
          .attestation,
      signNextRevision: input =>
        prepareMonadNextRevisionExport(handle, { ...descriptor, ...input })
          .attestation,
    },
  })
}

const DIRECTORY_CODES: readonly OpenDirectoryErrorCode[] = [
  'not-published',
  'unreachable',
  'invalid',
  'expired',
  'rollback',
  'fork',
  'rejected',
  'relay-info',
  'storage',
  'history-too-long',
  'clock',
  'unpublished',
]
export function isOpenDirectoryError(
  error: unknown,
): error is OpenDirectoryError {
  const candidate = error as { name?: unknown; code?: unknown } | null
  return (
    error instanceof OpenDirectoryError ||
    (candidate?.name === 'OpenDirectoryError' &&
      DIRECTORY_CODES.includes(candidate.code as OpenDirectoryErrorCode))
  )
}

/** Fixed words only: safe to log. */
const PUBLISH_REASONS: Record<OpenDirectoryErrorCode, string> = {
  'unreachable': 'the relay could not be reached',
  'relay-info': 'the relay did not describe itself for this network',
  'rejected': 'the relay refused to store the entry',
  'invalid': 'the relay holds an entry for this account that does not verify',
  'expired': 'the entry for this account has expired and was not renewed',
  'rollback': 'the relay served an older entry than one already accepted',
  'fork': 'two conflicting entries exist for this account',
  'storage': 'local directory storage is unavailable',
  'history-too-long':
    'the account has more directory history than is read at once',
  'clock': "this machine's clock is behind the entry or went backwards",
  'not-published': 'the entry is not published',
  'unpublished': 'the entry is not published',
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Publishes the bot's own directory entry and returns only once the relay holds it. Every
 * directory failure is retried with doubling backoff and logged with a fixed reason; the caller
 * must not import or answer anything before this returns. Anything that is not a directory
 * failure (for example wallet custody) is thrown.
 */
export async function publishBotDirectoryEntry(params: {
  directory: { publish(): Promise<unknown> }
  label: string
  firstDelayMs?: number
  maxDelayMs?: number
  /** Stops the retries (the promise then rejects with the abort reason). */
  signal?: AbortSignal
  /** Test seam. Production callers omit it. */
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const wait = params.sleep ?? sleep
  const maxDelayMs = params.maxDelayMs ?? 60_000
  let delayMs = Math.min(params.firstDelayMs ?? 1_000, maxDelayMs)
  for (;;) {
    params.signal?.throwIfAborted()
    try {
      await params.directory.publish()
      console.log(`[${params.label}] directory entry published`)
      return
    } catch (error) {
      if (!isOpenDirectoryError(error)) throw error
      console.warn(
        `[${params.label}] directory entry not published: ${
          PUBLISH_REASONS[error.code]
        } (${error.code}); retrying in ${delayMs} ms`,
      )
      await wait(delayMs)
      delayMs = Math.min(delayMs * 2, maxDelayMs)
    }
  }
}
