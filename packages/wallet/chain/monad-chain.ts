/**
 * `MonadChain`: the real `ActiveChain` implementation (ticket #41 -- see `PLAN.md`'s M9 section)
 * over the already-merged Monad wallet clients (`../wallet/monad-stamp-client.ts`,
 * `monad-topic-post-client.ts`, `monad-topic-vote-client.ts`, `monad-topic-tally-client.ts`,
 * `monad-message-feed.ts`, `monad-message-envelope.ts`, `monad-identity.ts`). See
 * `./active-chain.ts`'s header for the interface-level design notes and deviations from issue
 * #41's own sketch; this file's header covers implementation-level judgment calls only.
 *
 * ## Configuration: why this file reads `process.env`, unlike the wallet client modules it wires
 *
 * Every wallet-client module this file composes (`../wallet/monad-http.ts`,
 * `../wallet/monad-stamp-client.ts`, ...) deliberately never reads `process.env` itself -- config
 * is always a caller-supplied constructor param, so those modules stay composable/testable
 * regardless of how a caller sources config (see `monad-stamp-client.ts`'s header: "Passed
 * explicitly rather than read from `process.env` here, matching `monad-http.ts`'s established
 * convention"). This file *is* that caller: it's the composition root the whole app imports
 * through (`./index.ts`'s `activeChain`), the same role `qwen-bot-common.ts`/the
 * `*.livecheck.ts` scripts already play for their own one-off demos, just wired once for the whole
 * app instead of per script. `loadMonadChainConfigFromEnv` reads env under the same names those
 * scripts already established (`MONAD_TESTNET_HTTP_RPC_URL`, `MONAD_STAMP_BURN_ADDRESS`,
 * `CASHWEB_STAMP_MIN_BURN_VALUE_WEI`), falling back to permissive localhost/testnet-adjacent
 * defaults (matching `qwen-bot.livecheck.ts`'s own `E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'`
 * precedent) rather than hard-failing on a missing var, so importing this module (e.g. from a jest
 * test, or from `chain/index.ts` in a dev environment with no `.env` configured yet) never throws
 * at import time. `createMonadChain` itself is a pure factory taking an explicit
 * `MonadChainConfig` -- this ticket's own tests build chains against a fixed test config, never
 * against env, and mock every wallet client `MonadChain` composes rather than hitting real HTTP.
 *
 * ## `directMessages`: wiring `monad-message-envelope.ts` for real
 *
 * `send()` resolves the recipient's registered pubkey via `../wallet/monad-identity.ts`'s
 * `fetchMonadProfile` (itself `GET /metadata/:addr` -- see that file's header for the live
 * Lotus-address-only backend gap this inherits), builds a real encrypted envelope
 * (`buildEnvelope`) keyed on both parties' addresses, and submits it via a fresh `MonadStampClient`
 * built from the sending wallet's own `MonadWalletHandle` bundle. `items: MessageItem[]` is
 * JSON-serialized into the envelope's plaintext (`serializeMessageItems` below) -- deliberately
 * only for the item kinds that have a real Monad-side meaning (`text`/`reply`/`image`);
 * `stealth`/`p2pkh` (Lotus on-chain-payment-embedded-in-message kinds) have no Monad equivalent to
 * build here (`PLAN.md`'s own M9 notes: the old `Wallet` class's ~400 lines of UTXO coin-selection
 * this would need "have no Monad equivalent to port -- not a gap, a simplification"), so `send()`
 * throws a clear error if asked to send one rather than silently dropping it.
 *
 * `fetchSince()` pages `monad-message-feed.ts`'s `fetchMonadMessagesSince`, parses every stored
 * message's `encrypted_payload` as a `MonadMessageEnvelope` (`parseEnvelope` -- silently skipping
 * anything that doesn't parse as one, e.g. pre-#9 demo messages with no envelope at all, exactly
 * the behavior that function's own doc comment describes), keeps only envelopes addressed to the
 * wallet's own identity address (`envelope.to`, compared case-insensitively -- EIP-55 checksums
 * differ only in letter case), resolves each sender's pubkey the same way `send()` resolves the
 * recipient's, and decrypts. The `stampValueWei` field on the returned
 * `DirectMessageReceived` is summed from the message's own signed stamp transactions
 * (`ethers.Transaction.from(...).value`), not merely echoed from config -- it is the actual
 * recipient-payment value, even if it ever diverges from `defaultStampValueWei`.
 *
 * ## `topics`: wiring the topic-post/vote/tally clients
 *
 * `post`/`vote` build a fresh `MonadTopicPostClient`/`MonadTopicVoteClient` per call from the
 * wallet's `MonadWalletHandle` bundle (same one-per-call pattern `directMessages` uses -- these
 * clients are cheap to construct and hold no state beyond the bundle itself, so there's no need to
 * cache one per wallet). `fetchByTopic` reads via the wallet's own `relayBaseUrl`; `fetchOne` reads
 * via this chain's own config `relayBaseUrl`, since -- per issue #41's own interface sketch --
 * `fetchOne` takes no `wallet` param at all (reading someone else's public topic post never needed
 * a sender identity to begin with). `viewToForumMessage` adapts `MonadTopicPostViewProto` into the
 * pre-existing `ForumMessage` shape (`../types/forum.ts`), mirroring `../registry/index.ts`'s
 * `parseWrapper` field-for-field (see that function for the Lotus-side precedent this deliberately
 * matches): `poster` <- the burn tx's EIP-55-checksummed sender address (decoded from
 * `senderAddress`'s raw 20 bytes -- `ecrecover`'d server-side, never self-asserted); `satoshis` <-
 * the relay's already-tallied `voteWeight` (wei, despite the pre-existing field's stale
 * UTXO-flavored name -- `PLAN.md`'s own M9 notes flag this exact field as needing a real
 * Monad-side rename, an explicit decision left to #42/#43, not silently made here; this ticket just
 * needs a real number in that slot to produce a working `ForumMessage`, and `voteWeight` already
 * decodes as a plain `number`, not `bigint`, so no precision loss is introduced by reusing it
 * as-is).
 */
import {
  JsonRpcProvider,
  Transaction,
  computeAddress,
  formatEther,
  getAddress,
  getBytes,
  hexlify,
  parseEther,
} from 'ethers'
import axios from 'axios'

import {
  ActiveChain,
  ChainAddress,
  DirectMessageClient,
  DirectMessageReceived,
  DirectMessageSendResult,
  ProfileInfo,
  TopicBroadcastClient,
  WalletHandle,
} from './active-chain'
import { MessageItem } from '@frank/cashweb/types/messages'
import { ForumMessage, ForumMessageEntry } from '@frank/cashweb/types/forum'
// See cashweb/wallet/monad-topic-post-client.ts's identical comment (ticket #51, Vite migration).
import __pb_broadcast_pb from '@frank/cashweb/registry/broadcast_pb'
const { BroadcastMessage, ForumPost: BroadcastForumPostPayload } =
  __pb_broadcast_pb

import { MonadHttpClient } from '../monad-http'
import { MonadAccountTxSigner } from '../monad-account-tx'
import {
  MonadWalletHandle,
  createMonadStampWalletHandle,
} from '../monad-wallet-handle'
import { MonadIdentity, fetchMonadProfile } from '../monad-identity'
import {
  assertMonadStampPaymentCount,
  decodeStoredMonadMessage,
  decodeMonadStampedMessage,
  MonadStampClient,
  quoteMonadStampPaymentGasReserve,
  recoverMonadStampPayments,
  sweepRecoveredMonadStampPayment,
} from '../monad-stamp-client'
import { deriveMonadStampChildPrivate } from '../monad-stamp-stealth'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import {
  buildEnvelope,
  decryptEnvelope,
  parseEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import {
  MonadTopicPostClient,
  MonadTopicPostViewProto,
} from '../monad-topic-post-client'
import { MonadTopicVoteClient } from '../monad-topic-vote-client'
import {
  fetchDiscoveredTopics,
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from '../monad-topic-tally-client'
import { readViteEnv } from './vite-env'
import {
  createInMemoryMonadWalletBundle,
  openMonadWalletBundle,
  restoreMonadWalletBundleFromSeed,
  type MonadWalletOperationAdmission,
} from '../storage/monad-wallet-bundle'
import { MonadRpcError } from '../monad-http'

export interface MonadChainConfig {
  /** Monad JSON-RPC HTTP endpoint, e.g. `MONAD_TESTNET_HTTP_RPC_URL`. */
  rpcUrl: string
  /** Base URL of the `cashweb-registry` relay. */
  relayBaseUrl: string
  /** Frank network tag included in every DM envelope before hashing. */
  networkTag: string
  /** `0x`-prefixed Monad burn address Stamp/topic-vote burns are sent to (see
   * `frank/.env.example`'s `MONAD_STAMP_BURN_ADDRESS`). */
  stampBurnAddress: string
  /** Default aggregate value, in wei, `directMessages.send` pays per Stamp message. */
  defaultStampValueWei: bigint
  /** Default value, in wei, burned for a topic post or vote. */
  defaultTopicVoteValueWei: bigint
  /** How many single-use funding sub-accounts `createWallet` pre-derives into the pool. */
  subAccountPoolSize: number
  /** Parent LevelDB location for durable sender-account and change state. `false` is reserved for
   * isolated tests; production must persist these records so recreating a wallet cannot reuse a
   * sender account or rewind the change derivation path. */
  walletStorageLocation: string | false
}

// Ticket #54 (found live doing real end-to-end GUI testing against a real relay + real Alchemy
// RPC -- the app silently fell back to `http://127.0.0.1:8545`, breaking every real chain call):
// `process.env.KEY` is silently always `undefined` in the browser bundle in this
// `@quasar/app-vite`/Vite 8/Rolldown toolchain -- confirmed a genuine, generic gap (even Vite's
// own built-in `process.env.NODE_ENV` has it), not something fixable with a `define` tweak (see
// `app/quasar.config.js`'s own investigation). `import.meta.env.QCLI_KEY` is the mechanism that
// actually works under this toolchain (Quasar's own `QCLI_` env-var-prefix convention, confirmed
// live) -- see `./vite-env.ts` for why that logic isn't written directly in this file, and
// `jest.config.js`'s `moduleNameMapper` for how this package's own tests avoid it entirely.
function readEnv(key: string): string | undefined {
  return readViteEnv(`QCLI_${key}`) ?? process.env[key]
}

/** Reads `MonadChainConfig` from the environment (see `readEnv` just above for exactly where
 * from, and why two places), with permissive fallbacks -- see this file's header,
 * "Configuration", for why this (unlike the wallet client modules it configures) reads env
 * directly, and why it never throws on a missing var. */
export function loadMonadChainConfigFromEnv(): MonadChainConfig {
  return {
    rpcUrl: readEnv('MONAD_TESTNET_HTTP_RPC_URL') ?? 'http://127.0.0.1:8545',
    relayBaseUrl:
      readEnv('MONAD_RELAY_BASE_URL') ??
      readEnv('E2E_DEMO_RELAY_URL') ??
      'http://127.0.0.1:8098',
    networkTag: readEnv('FRANK_NETWORK_TAG') ?? 'MONT',
    stampBurnAddress:
      readEnv('MONAD_STAMP_BURN_ADDRESS') ??
      '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: BigInt(
      readEnv('FRANK_DM_DEFAULT_STAMP_VALUE_WEI') ?? '10000000000000000'
    ),
    defaultTopicVoteValueWei: BigInt(
      readEnv('FRANK_TOPIC_DEFAULT_VOTE_VALUE_WEI') ??
        readEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI') ??
        '1000000000000'
    ),
    subAccountPoolSize: Number(readEnv('MONAD_SUB_ACCOUNT_POOL_SIZE') ?? '8'),
    walletStorageLocation:
      readEnv('MONAD_WALLET_STORAGE_LOCATION') ?? 'frank-monad-wallet-state',
  }
}

/** Concrete Monad `WalletHandle`: the formalized wallet-client bundle (`MonadWalletHandle`,
 * `../wallet/monad-wallet-handle.ts`) plus the `identity` the generic `ActiveChain` interface
 * requires. See `./active-chain.ts`'s header, deviation 1, for why `WalletHandle` itself stays
 * `{ identity }`-only while this concrete type carries more. */
export interface MonadChainWalletHandle
  extends MonadWalletHandle,
    WalletHandle {
  readonly identity: MonadIdentity
}

/** Narrows a generic `WalletHandle` to `MonadChainWalletHandle`. Safe under this ticket's
 * compile-time single-chain seam (see `./active-chain.ts`'s header) -- `MonadChain.createWallet`
 * is the only producer of `WalletHandle` values in a Monad-only build, so every handle reaching
 * `MonadChain`'s other methods already is one; this throws instead of silently misbehaving if that
 * invariant is ever broken. */
function asMonadWallet(wallet: WalletHandle): MonadChainWalletHandle {
  const candidate = wallet as Partial<MonadChainWalletHandle>
  if (
    candidate.pool === undefined ||
    candidate.leaseManager === undefined ||
    candidate.provider === undefined ||
    candidate.httpClient === undefined ||
    candidate.relayBaseUrl === undefined
  ) {
    throw new Error(
      'Expected a MonadChainWalletHandle (produced by MonadChain.createWallet), got a ' +
        'WalletHandle missing the Monad wallet-client bundle'
    )
  }
  return candidate as MonadChainWalletHandle
}

function toChainAddress(raw: string): ChainAddress {
  return { raw: getAddress(raw) }
}

function bareHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2)
}

function assertCompressedSecp256k1PublicKey(
  publicKey: Uint8Array,
  label: string
): void {
  if (
    publicKey.length !== 33 ||
    (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)
  ) {
    throw new Error(`${label} must be a compressed 33-byte secp256k1 key`)
  }
}

/** JSON-serializes `items` for use as a direct message's plaintext -- only the item kinds that
 * have a real Monad-side meaning (see this file's header). Throws on `'stealth'`/`'p2pkh'` items,
 * which have no Monad equivalent to build (no UTXO coin selection exists on this chain -- see
 * `PLAN.md`'s M9 notes). */
export function serializeMessageItems(items: MessageItem[]): string {
  for (const item of items) {
    if (item.type === 'stealth' || item.type === 'p2pkh') {
      throw new Error(
        `MonadChain direct messages don't support '${item.type}' items: on-chain-payment-` +
          "embedded-in-message has no Monad equivalent (see PLAN.md's M9 notes)"
      )
    }
  }
  return JSON.stringify(items)
}

/** Inverse of {@link serializeMessageItems}. Throws if `plaintext` doesn't decode to a JSON
 * array. */
export function deserializeMessageItems(plaintext: string): MessageItem[] {
  const parsed: unknown = JSON.parse(plaintext)
  if (!Array.isArray(parsed)) {
    throw new Error('Decrypted direct-message plaintext was not a JSON array')
  }
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Decrypted direct-message item was not an object')
    }
    const candidate = item as Record<string, unknown>
    if (typeof candidate.type !== 'string') {
      throw new Error('Invalid direct-message item type')
    }
    switch (candidate.type) {
      case 'text':
        if (typeof candidate.text !== 'string') {
          throw new Error('Invalid text direct-message item')
        }
        break
      case 'reply':
        if (
          typeof candidate.payloadDigest !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(candidate.payloadDigest)
        ) {
          throw new Error('Invalid reply direct-message item')
        }
        break
      case 'image':
        if (typeof candidate.image !== 'string') {
          throw new Error('Invalid image direct-message item')
        }
        break
      case 'blackjack-move':
        if (
          typeof candidate.gameId !== 'string' ||
          candidate.gameId.length === 0 ||
          typeof candidate.action !== 'string' ||
          !['bet', 'deal', 'hit', 'stand', 'reveal'].includes(
            candidate.action
          ) ||
          ['wagerTxHash', 'serverSeedHash', 'serverSeed'].some(
            (field) =>
              candidate[field] !== undefined &&
              typeof candidate[field] !== 'string'
          ) ||
          ['playerCards', 'dealerCards'].some((field) => {
            const cards = candidate[field]
            return (
              cards !== undefined &&
              (!Array.isArray(cards) ||
                cards.some(
                  (card) => !Number.isInteger(card) || card < 0 || card > 51
                ))
            )
          }) ||
          (candidate.dealerUpCard !== undefined &&
            (!Number.isInteger(candidate.dealerUpCard) ||
              Number(candidate.dealerUpCard) < 0 ||
              Number(candidate.dealerUpCard) > 51)) ||
          (candidate.outcome !== undefined &&
            (typeof candidate.outcome !== 'string' ||
              ![
                'player_win',
                'dealer_win',
                'push',
                'player_blackjack',
              ].includes(candidate.outcome)))
        ) {
          throw new Error('Invalid blackjack direct-message item')
        }
        break
      case 'digital-goods':
        if (
          typeof candidate.action !== 'string' ||
          !['catalog', 'request', 'fulfill', 'error'].includes(
            candidate.action
          ) ||
          (candidate.itemId !== undefined &&
            typeof candidate.itemId !== 'string') ||
          (candidate.message !== undefined &&
            typeof candidate.message !== 'string') ||
          (candidate.catalog !== undefined &&
            (!Array.isArray(candidate.catalog) ||
              candidate.catalog.some(
                (entry) =>
                  typeof entry !== 'object' ||
                  entry === null ||
                  Array.isArray(entry) ||
                  typeof (entry as Record<string, unknown>).itemId !==
                    'string' ||
                  typeof (entry as Record<string, unknown>).description !==
                    'string' ||
                  typeof (entry as Record<string, unknown>).priceWei !==
                    'string' ||
                  !/^\d+$/.test(
                    (entry as Record<string, unknown>).priceWei as string
                  )
              )))
        ) {
          throw new Error('Invalid digital-goods direct-message item')
        }
        break
      default:
        throw new Error('Unsupported direct-message item type')
    }
  }
  return parsed as MessageItem[]
}

export async function resolveLegacyAttemptRecipientFromEnvelope(params: {
  relayBaseUrl: string
  messageBytes: readonly number[]
}): Promise<Uint8Array> {
  const message = decodeMonadStampedMessage(
    Uint8Array.from(params.messageBytes)
  )
  const envelope = parseEnvelope(message.encryptedPayload)
  if (envelope === undefined) {
    throw new Error('Legacy stamp attempt has no retained recipient envelope')
  }
  const profile = await fetchMonadProfile({
    relayBaseUrl: params.relayBaseUrl,
    address: { raw: getAddress(envelope.to) },
  })
  if (profile === undefined) {
    throw new Error(
      'Legacy stamp attempt recipient profile does not match its retained envelope'
    )
  }
  assertCompressedSecp256k1PublicKey(
    profile.pubKey,
    'Legacy stamp attempt recipient profile'
  )
  if (
    getAddress(computeAddress(hexlify(profile.pubKey))) !==
    getAddress(envelope.to)
  ) {
    throw new Error(
      'Legacy stamp attempt recipient profile does not match its retained envelope'
    )
  }
  return profile.pubKey
}

/** Adapts a `MonadTopicPostViewProto` (`../wallet/monad-topic-tally-client.ts`) into the
 * pre-existing `ForumMessage` shape (`../types/forum.ts`) -- mirrors `../registry/index.ts`'s
 * `parseWrapper` field-for-field; see this file's header for the per-field reasoning. Returns
 * `undefined` if `view` doesn't carry a stored post (shouldn't happen for a view actually returned
 * by the relay, but keeps this function total). */
export function viewToForumMessage(
  view: MonadTopicPostViewProto
): ForumMessage | undefined {
  const stored = view.post
  const post = stored?.post
  if (stored === undefined || post === undefined) return undefined

  const entries: ForumMessageEntry[] = []
  const broadcastMessage = BroadcastMessage.deserializeBinary(
    post.encryptedPayload
  )
  for (const entry of broadcastMessage.getEntriesList()) {
    const kind = entry.getKind()
    const payload = entry.getPayload()
    if (typeof payload === 'string') continue
    if (kind === 'post') {
      const forumPost = BroadcastForumPostPayload.deserializeBinary(payload)
      entries.push({
        kind: 'post',
        title: forumPost.getTitle(),
        url: forumPost.getUrl(),
        message: forumPost.getMessage(),
      })
    }
  }

  const senderAddress =
    stored.senderAddress.length === 20
      ? getAddress(hexlify(stored.senderAddress))
      : hexlify(stored.senderAddress)

  return {
    poster: senderAddress,
    topic: post.topic,
    satoshis: view.voteWeight,
    entries,
    payloadDigest: bareHex(post.payloadHash),
    parentDigest:
      post.parentPostHash.length > 0 ? bareHex(post.parentPostHash) : undefined,
    timestamp: new Date(stored.timestamp),
  }
}

/** Pure factory: builds an `ActiveChain` from an explicit `MonadChainConfig`. See this file's
 * header, "Configuration", for why config is a param here (unlike the `MonadChain` singleton
 * below, which reads it from env). */
export function createMonadChain(config: MonadChainConfig): ActiveChain {
  const walletsByIdentity = new Map<string, Promise<MonadChainWalletHandle>>()
  const directMessageSendQueues = new WeakMap<
    MonadChainWalletHandle,
    Promise<void>
  >()
  const sendDirectMessageExclusive = async (
    params: Parameters<DirectMessageClient['send']>[0],
    wallet: MonadChainWalletHandle,
    admission: MonadWalletOperationAdmission
  ): Promise<DirectMessageSendResult> => {
    if (wallet.walletState === undefined) {
      throw new Error('Monad stamped sends require a complete wallet bundle')
    }
    const stampClient = new MonadStampClient(
      createMonadStampWalletHandle({
        walletState: wallet.walletState,
        provider: wallet.provider,
        httpClient: wallet.httpClient,
        relayBaseUrl: wallet.relayBaseUrl,
      })
    )
    await stampClient.reconcileOrThrow(admission)
    const plaintext = serializeMessageItems(params.items)

    const recipientProfile = await fetchMonadProfile({
      relayBaseUrl: wallet.relayBaseUrl,
      address: params.recipient,
    })
    if (recipientProfile === undefined) {
      throw new Error(
        `No registered profile/pubkey found for ${params.recipient.raw}`
      )
    }
    assertCompressedSecp256k1PublicKey(
      recipientProfile.pubKey,
      'Monad recipient profile'
    )
    if (
      getAddress(computeAddress(hexlify(recipientProfile.pubKey))) !==
      getAddress(params.recipient.raw)
    ) {
      throw new Error(
        `Registered profile key does not match recipient ${params.recipient.raw}`
      )
    }

    const envelopeBytes = buildEnvelope({
      fromAddress: wallet.identity.address.raw,
      fromPrivateKey: wallet.identity.toBitcorePrivateKey(),
      toAddress: params.recipient.raw,
      toPubKey: Buffer.from(recipientProfile.pubKey),
      plaintext,
      networkTag: config.networkTag,
    })

    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: wallet.identity.toPrivateKeyHex(),
      provider: wallet.provider,
      httpClient: wallet.httpClient,
    })
    const gasReserveWei = await quoteMonadStampPaymentGasReserve({
      signer: mainAccountSigner,
      recipientPublicKey: recipientProfile.pubKey,
    })
    const preparationParams = {
      mainAccountSigner,
      provider: wallet.provider,
      stampValueWei: params.stampValue ?? config.defaultStampValueWei,
      gasReserveWei,
      onProgress: params.onPreparationProgress,
    }
    const preparation =
      admission === undefined
        ? await wallet.pool.prepareStampInventory(preparationParams)
        : await wallet.pool.prepareStampInventory(preparationParams, admission)

    const submissionParams = {
      encryptedPayload: envelopeBytes,
      // Ticket #57: a DM's stamp is a real payment to the recipient (mirroring Lotus's
      // `constructStampTransactions`, which derives the stamp output address from the
      // recipient's own pubkey), not a burn to the fixed dead address -- that's `topics`'
      // `post`/`vote` below, where there's no single recipient to pay.
      recipientPublicKey: recipientProfile.pubKey,
      stampValueWei: params.stampValue ?? config.defaultStampValueWei,
    }
    const result =
      admission === undefined
        ? await stampClient.submitStampedMessage(submissionParams)
        : await stampClient.submitStampedMessage(submissionParams, admission)

    const stampPayments =
      result.stored?.message?.stampPayments.flatMap((payment) => {
        const tx = Transaction.from(hexlify(payment.rawTx))
        return tx.hash === null || tx.to === null
          ? []
          : [
              {
                txHash: tx.hash,
                destinationAddress: tx.to,
                valueWei: tx.value,
              },
            ]
      }) ?? []
    return {
      payloadDigest: result.payloadHashHex,
      stampValueWei: params.stampValue ?? config.defaultStampValueWei,
      stampPayments,
      preparationTxHashes: preparation.fundingTxHashes,
    }
  }

  const directMessages: DirectMessageClient = {
    async send(params): Promise<DirectMessageSendResult> {
      const wallet = asMonadWallet(params.wallet)
      if (wallet.walletState === undefined) {
        throw new Error('Monad stamped sends require a complete wallet bundle')
      }
      return wallet.walletState.runOperation(async (admission) => {
        const run = (
          directMessageSendQueues.get(wallet) ?? Promise.resolve()
        ).then(() => sendDirectMessageExclusive(params, wallet, admission))
        directMessageSendQueues.set(
          wallet,
          run.then(
            () => undefined,
            () => undefined
          )
        )
        return run
      })
    },

    async fetchSince(params): Promise<DirectMessageReceived[]> {
      const wallet = asMonadWallet(params.wallet)
      const run = async (): Promise<DirectMessageReceived[]> => {
        const stored = await fetchMonadMessagesSince({
          relayBaseUrl: wallet.relayBaseUrl,
          sinceMs: params.sinceMs,
        })

        const myAddress = wallet.identity.address.raw.toLowerCase()
        const received: DirectMessageReceived[] = []

        for (const record of stored) {
          if (record.message === undefined) continue
          let envelope: NonNullable<ReturnType<typeof parseEnvelope>>
          let recovered: ReturnType<typeof recoverMonadStampPayments>
          let payloadHashHex: string
          try {
            assertMonadStampPaymentCount(record.message.stampPayments.length)
            const parsedEnvelope = parseEnvelope(
              record.message.encryptedPayload
            )
            if (parsedEnvelope === undefined) {
              continue
            }
            // Both untrusted envelope addresses must be canonical before the payment set is
            // journaled or either address is used for a profile lookup. A malformed paid row is
            // isolated like every other malformed feed row and cannot poison later valid rows.
            getAddress(parsedEnvelope.from)
            const canonicalTo = getAddress(parsedEnvelope.to)
            if (canonicalTo.toLowerCase() !== myAddress) continue
            // GCM authenticates the exact serialized envelope fields. Canonical addresses are
            // comparison authority only; preserve the retained casing for decryption/display.
            envelope = parsedEnvelope
            payloadHashHex = bareHex(record.message.payloadHash)
            recovered = recoverMonadStampPayments({
              message: record.message,
              recipientPrivateKey: getBytes(wallet.identity.toPrivateKeyHex()),
              envelopeRecipientAddress: envelope.to,
            })
          } catch {
            // Malformed relay rows are isolated. Transport failures occur outside this block and
            // journal failures occur only after the complete row has been preflighted.
            continue
          }

          const discovered = recovered.map((payment) => ({
            payloadHashHex,
            childIndex: payment.childIndex,
            txHash: payment.txHash,
            rawTx: payment.rawTx,
            recipientPublicKeyHex: payment.recipientPublicKeyHex,
            envelopeRecipientAddress: payment.envelopeRecipientAddress,
            address: payment.address,
            valueWei: payment.valueWei.toString(),
            status: 'discovered' as const,
          }))
          wallet.stampPaymentJournal?.assertDiscovered(discovered)

          const senderProfile = await fetchMonadProfile({
            relayBaseUrl: wallet.relayBaseUrl,
            address: toChainAddress(envelope.from),
          })
          if (senderProfile === undefined) continue

          let plaintext: string
          let items: MessageItem[]
          try {
            assertCompressedSecp256k1PublicKey(
              senderProfile.pubKey,
              'Monad sender profile'
            )
            if (
              getAddress(computeAddress(hexlify(senderProfile.pubKey))) !==
              getAddress(envelope.from)
            ) {
              throw new Error(
                'Monad sender profile does not match the retained envelope sender'
              )
            }
            plaintext = decryptEnvelope({
              envelope,
              myPrivateKey: wallet.identity.toBitcorePrivateKey(),
              senderPubKey: Buffer.from(senderProfile.pubKey),
            })
            items = deserializeMessageItems(plaintext)
          } catch {
            // Wrong/stale key, corrupted ciphertext, etc. -- skip rather than surface a parse error
            // for one bad message out of a whole page.
            continue
          }

          await wallet.stampPaymentJournal?.putDiscovered(discovered)

          const stampValueWei = recovered.reduce(
            (sum, payment) => sum + payment.valueWei,
            BigInt(0)
          )
          const stampPayments = recovered.map((payment) => ({
            txHash: payment.txHash,
            destinationAddress: payment.address,
            valueWei: payment.valueWei,
          }))

          received.push({
            senderAddress: toChainAddress(envelope.from),
            recipientAddress: toChainAddress(envelope.to),
            items,
            payloadDigest: payloadHashHex,
            stampValueWei,
            stampPayments,
            receivedTime: record.timestamp,
          })
        }
        return received
      }
      return typeof wallet.walletState?.runOperation === 'function'
        ? wallet.walletState.runOperation(run)
        : run()
    },

    async listRecoveredStampPayments({ wallet }) {
      const monadWallet = asMonadWallet(wallet)
      return (monadWallet.stampPaymentJournal?.getAll() ?? []).map(
        (record) => ({
          payloadDigest: record.payloadHashHex,
          childIndex: record.childIndex,
          txHash: record.txHash,
          address: toChainAddress(record.address),
          valueWei: BigInt(record.valueWei),
          status: record.status,
          sweepTxHash: record.sweepTxHash,
        })
      )
    },

    async sweepRecoveredStampPayment({
      wallet,
      payloadDigest,
      childIndex,
      destination,
    }) {
      const monadWallet = asMonadWallet(wallet)
      const journal = monadWallet.stampPaymentJournal
      if (journal === undefined) {
        throw new Error('Stamp-payment recovery journal is not configured')
      }
      const run = async () => {
        journal.assertOpen()
        const withPaymentLock = journal.withPaymentLock.bind(journal)
        return withPaymentLock(payloadDigest, childIndex, async (locked) => {
          let record = locked.get()
          if (record === undefined) {
            throw new Error(
              `No recovered stamp payment ${payloadDigest}:${childIndex}`
            )
          }
          if (record.status === 'swept') {
            throw new Error(
              `Stamp payment ${payloadDigest}:${childIndex} was already swept`
            )
          }
          const child = deriveMonadStampChildPrivate({
            payloadHash: getBytes(`0x${payloadDigest}`),
            recipientPrivateKey: getBytes(
              monadWallet.identity.toPrivateKeyHex()
            ),
            paymentIndex: childIndex,
          })
          if (child.address.toLowerCase() !== record.address.toLowerCase()) {
            throw new Error(
              `Recovered stamp-payment address ${record.address} does not match derived child ${child.address}`
            )
          }
          const childSigner = new MonadAccountTxSigner({
            privateKey: hexlify(child.privateKey),
            provider: monadWallet.provider,
            httpClient: monadWallet.httpClient,
          })

          const retainFailedSweep = async (
            pending: typeof record
          ): Promise<NonNullable<typeof record>> => {
            if (
              pending === undefined ||
              pending.sweepTxHash === undefined ||
              pending.sweepRawTx === undefined ||
              pending.sweepValueWei === undefined ||
              pending.sweepDestinationAddress === undefined
            ) {
              throw new Error(
                `Failed stamp-payment sweep ${payloadDigest}:${childIndex} is missing its signed intent`
              )
            }
            const failed = {
              ...pending,
              status: 'sweep-failed' as const,
              failedSweeps: [
                ...(pending.failedSweeps ?? []),
                {
                  txHash: pending.sweepTxHash,
                  rawTx: pending.sweepRawTx,
                  valueWei: pending.sweepValueWei,
                  destinationAddress: pending.sweepDestinationAddress,
                },
              ],
            }
            await locked.put(failed)
            return failed
          }

          const signFresh = async (
            base: NonNullable<typeof record>,
            retryAfterImmediateFailure: boolean
          ): Promise<
            Awaited<
              ReturnType<DirectMessageClient['sweepRecoveredStampPayment']>
            >
          > => {
            let signedSweepRawTx: string | undefined
            const outcome = await sweepRecoveredMonadStampPayment({
              payment: {
                childIndex,
                address: child.address,
                privateKey: child.privateKey,
                txHash: base.txHash,
                rawTx: base.rawTx,
                recipientPublicKeyHex: base.recipientPublicKeyHex,
                envelopeRecipientAddress: base.envelopeRecipientAddress,
                valueWei: BigInt(base.valueWei),
              },
              destinationAddress: destination.raw,
              provider: monadWallet.provider,
              httpClient: monadWallet.httpClient,
              signer: childSigner,
              onSigned: async (signedTx) => {
                signedSweepRawTx = signedTx.rawTx
                await locked.put({
                  ...base,
                  status: 'sweep-pending',
                  sweepTxHash: signedTx.txHash,
                  sweepRawTx: signedTx.rawTx,
                  sweepValueWei: signedTx.value.toString(),
                  sweepDestinationAddress: signedTx.to,
                })
              },
            })
            if (outcome.swept) {
              await locked.put({
                ...base,
                status: 'swept',
                sweepTxHash: outcome.txHash,
                sweepRawTx: signedSweepRawTx,
                sweepValueWei: outcome.valueWei.toString(),
                sweepDestinationAddress: outcome.destinationAddress,
              })
              return {
                swept: true,
                txHash: outcome.txHash,
                valueWei: outcome.valueWei,
              }
            }
            if (outcome.reason === 'below-dust-threshold') {
              return {
                swept: false,
                reason: 'below-dust-threshold',
                balanceWei: outcome.balanceWei,
                dustThresholdWei: outcome.dustThresholdWei,
              }
            }
            if (outcome.reason === 'pending') {
              return {
                swept: false,
                reason: 'pending',
                txHash: outcome.txHash,
                valueWei: outcome.valueWei,
                destinationAddress: outcome.destinationAddress,
              }
            }
            const failed = await retainFailedSweep(locked.get())
            if (!retryAfterImmediateFailure) {
              throw new Error(
                `Recipient stamp-payment sweep ${outcome.txHash} failed on-chain`
              )
            }
            return signFresh(failed, false)
          }

          if (record.status === 'sweep-pending') {
            if (
              record.sweepTxHash === undefined ||
              record.sweepRawTx === undefined ||
              record.sweepValueWei === undefined
            ) {
              throw new Error(
                `Pending stamp-payment sweep ${payloadDigest}:${childIndex} is missing its signed intent`
              )
            }
            let status = await childSigner.getStatus(record.sweepTxHash)
            if (status === 'confirmed') {
              await locked.put({
                ...record,
                status: 'swept',
              })
              return {
                swept: true as const,
                txHash: record.sweepTxHash,
                valueWei: BigInt(record.sweepValueWei),
              }
            }
            if (status === 'pending') {
              // No receipt is ambiguous with a crash immediately before submission. Rebroadcast
              // the exact journaled bytes, then reconcile again before returning.
              try {
                await childSigner.submitRaw(
                  record.sweepRawTx,
                  record.sweepTxHash
                )
              } catch (error) {
                if (
                  !(error instanceof MonadRpcError) ||
                  (error.kind !== 'already-known' &&
                    error.kind !== 'nonce-too-low')
                ) {
                  throw error
                }
                // These two responses can describe an earlier exact broadcast, but never prove
                // which transaction consumed the nonce. Only the exact hash's receipt below may
                // authorize completion or a fresh nonce.
              }
              status = await childSigner.getStatus(record.sweepTxHash)
              if (status === 'confirmed') {
                await locked.put({ ...record, status: 'swept' })
                return {
                  swept: true as const,
                  txHash: record.sweepTxHash,
                  valueWei: BigInt(record.sweepValueWei),
                }
              }
              if (status === 'pending') {
                return {
                  swept: false as const,
                  reason: 'pending' as const,
                  txHash: record.sweepTxHash,
                  valueWei: BigInt(record.sweepValueWei),
                  destinationAddress: record.sweepDestinationAddress,
                }
              }
            }
            record = await retainFailedSweep(record)
          }
          return signFresh(record, true)
        })
      }
      return typeof monadWallet.walletState?.runOperation === 'function'
        ? monadWallet.walletState.runOperation(run)
        : run()
    },
  }

  const nativeTransfers: ActiveChain['nativeTransfers'] = {
    async getBalance({ wallet }): Promise<bigint> {
      const monadWallet = asMonadWallet(wallet)
      return monadWallet.provider.getBalance(monadWallet.identity.address.raw)
    },

    async send({ wallet, recipient, value }): Promise<{ txHash: string }> {
      if (value <= 0n) {
        throw new Error('Transfer value must be greater than zero')
      }
      const monadWallet = asMonadWallet(wallet)
      const run = async (): Promise<{ txHash: string }> => {
        const signer = new MonadAccountTxSigner({
          privateKey: monadWallet.identity.toPrivateKeyHex(),
          provider: monadWallet.provider,
          httpClient: monadWallet.httpClient,
        })
        const signed = await signer.buildAndSignTransfer(recipient.raw, value)
        return { txHash: await signer.submit(signed) }
      }
      return typeof monadWallet.walletState?.runOperation === 'function'
        ? monadWallet.walletState.runOperation(run)
        : run()
    },
  }

  const topics: TopicBroadcastClient = {
    async post(params): Promise<{ payloadDigest: string }> {
      const wallet = asMonadWallet(params.wallet)
      const run = async (
        admission?: MonadWalletOperationAdmission
      ): Promise<{ payloadDigest: string }> => {
        const client = new MonadTopicPostClient(wallet)
        const result = await client.submitTopicPost(
          {
            topic: params.topic,
            entries: params.entries,
            parentPostHash: params.parentDigest
              ? getBytes(`0x${params.parentDigest}`)
              : undefined,
            direction: params.direction,
            burnAddress: config.stampBurnAddress,
            voteWeightWei: params.voteWeightWei,
          },
          admission
        )
        return { payloadDigest: result.payloadHashHex }
      }
      return typeof wallet.walletState?.runOperation === 'function'
        ? wallet.walletState.runOperation(run)
        : run()
    },

    async vote(params): Promise<void> {
      const wallet = asMonadWallet(params.wallet)
      const run = async (
        admission?: MonadWalletOperationAdmission
      ): Promise<void> => {
        const client = new MonadTopicVoteClient(wallet)
        await client.castVote(
          {
            targetPayloadHash: getBytes(`0x${params.payloadDigest}`),
            direction: params.direction,
            burnAddress: config.stampBurnAddress,
            voteWeightWei: params.voteWeightWei,
          },
          admission
        )
      }
      return typeof wallet.walletState?.runOperation === 'function'
        ? wallet.walletState.runOperation(run)
        : run()
    },

    async fetchByTopic(params): Promise<ForumMessage[]> {
      const wallet = asMonadWallet(params.wallet)
      const views = await fetchMonadTopicPostsSince({
        relayBaseUrl: wallet.relayBaseUrl,
        topic: params.topic,
        sinceMs: params.sinceMs,
      })
      const messages: ForumMessage[] = []
      for (const view of views) {
        const message = viewToForumMessage(view)
        if (message !== undefined) messages.push(message)
      }
      return messages
    },

    async fetchOne(payloadDigest): Promise<ForumMessage | undefined> {
      const view = await fetchMonadTopicPostView({
        relayBaseUrl: config.relayBaseUrl,
        payloadHashHex: payloadDigest,
      })
      return view ? viewToForumMessage(view) : undefined
    },

    async discoverTopics() {
      // No wallet needed -- same "read via the chain's own configured relayBaseUrl" shape as
      // `fetchOne` above. `fetchDiscoveredTopics` itself already fails soft (`[]`), so there's
      // nothing further to catch here.
      return fetchDiscoveredTopics({ relayBaseUrl: config.relayBaseUrl })
    },
  }

  return {
    name: 'monad',
    unit: 'MON',
    defaultStampValue: config.defaultStampValueWei,
    defaultTopicVoteValue: config.defaultTopicVoteValueWei,

    toDisplayAmount(raw: bigint): string {
      return formatEther(raw)
    },

    fromDisplayAmount(display: string): bigint {
      return parseEther(display)
    },

    formatAddress(addr: ChainAddress): string {
      return addr.raw
    },

    parseAddress(input: string): ChainAddress | undefined {
      try {
        return { raw: getAddress(input) }
      } catch {
        return undefined
      }
    },

    async createWallet(seed): Promise<WalletHandle> {
      const identity = MonadIdentity.fromSeed(seed)
      const identityKey = identity.address.raw.toLowerCase()
      const existing = walletsByIdentity.get(identityKey)
      if (existing !== undefined) return existing

      const pending = (async (): Promise<MonadChainWalletHandle> => {
        const storageLocation =
          config.walletStorageLocation === false
            ? undefined
            : `${config.walletStorageLocation}-${identityKey}`
        const provider = new JsonRpcProvider(config.rpcUrl)
        const httpClient = new MonadHttpClient({ rpcUrl: config.rpcUrl })
        const walletState =
          storageLocation === undefined
            ? createInMemoryMonadWalletBundle({
                mnemonic: seed.mnemonic,
                passphrase: seed.passphrase,
              })
            : await openMonadWalletBundle({
                location: storageLocation,
                seed: {
                  mnemonic: seed.mnemonic,
                  passphrase: seed.passphrase,
                },
                mode: 'create',
                recovery: {
                  provider,
                  assertRelayAvailable: async () => {
                    try {
                      await axios({
                        method: 'get',
                        url: `${config.relayBaseUrl.replace(
                          /\/+$/,
                          ''
                        )}/message/monad/${'00'.repeat(32)}`,
                      })
                    } catch (error) {
                      if (
                        !axios.isAxiosError(error) ||
                        error.response?.status !== 404
                      ) {
                        throw error
                      }
                    }
                  },
                  // Standard EVM RPC cannot enumerate complete signed history by sender. A used
                  // index with no local state therefore remains ambiguous and fails closed.
                  recoverSenderEvidence: async () => undefined,
                },
                resolveLegacyAttemptRecipientPublicKey: async (attempt) => {
                  return resolveLegacyAttemptRecipientFromEnvelope({
                    relayBaseUrl: config.relayBaseUrl,
                    messageBytes: attempt.messageBytes,
                  })
                },
                resolveLegacyChangeRawTransaction: async (record) => {
                  const rawTx = await provider.send(
                    'eth_getRawTransactionByHash',
                    [record.txHash]
                  )
                  if (typeof rawTx !== 'string') {
                    throw new Error(
                      `Missing authoritative change transaction ${record.txHash}`
                    )
                  }
                  return rawTx
                },
                resolveLegacyPaymentAuthority: async (record) => {
                  const response = await axios({
                    method: 'get',
                    url: `${config.relayBaseUrl.replace(
                      /\/+$/,
                      ''
                    )}/message/monad/${record.payloadHashHex}`,
                    responseType: 'arraybuffer',
                  })
                  const retained = decodeStoredMonadMessage(
                    new Uint8Array(response.data)
                  ).message
                  if (
                    retained === undefined ||
                    bareHex(retained.payloadHash) !== record.payloadHashHex
                  ) {
                    throw new Error('Retained legacy payment message mismatch')
                  }
                  const envelope = parseEnvelope(retained.encryptedPayload)
                  if (
                    envelope === undefined ||
                    getAddress(envelope.to) !== getAddress(identity.address.raw)
                  ) {
                    throw new Error('Retained legacy payment envelope mismatch')
                  }
                  const recovered = recoverMonadStampPayments({
                    message: retained,
                    recipientPrivateKey: getBytes(identity.toPrivateKeyHex()),
                    envelopeRecipientAddress: envelope.to,
                  }).find((payment) => payment.childIndex === record.childIndex)
                  if (recovered === undefined) {
                    throw new Error('Retained legacy payment child is missing')
                  }
                  return {
                    rawTx: recovered.rawTx,
                    recipientPublicKeyHex: recovered.recipientPublicKeyHex,
                    envelopeRecipientAddress:
                      recovered.envelopeRecipientAddress,
                  }
                },
              })
        try {
          const {
            pool,
            changePool,
            leaseManager,
            stampPaymentJournal,
            stampAttemptJournal,
          } = walletState
          const wallet: MonadChainWalletHandle = {
            identity,
            pool,
            leaseManager,
            provider,
            httpClient,
            changePool,
            stampPaymentJournal,
            stampAttemptJournal,
            topicOperationJournal: walletState.topicOperationJournal,
            walletState,
            relayBaseUrl: config.relayBaseUrl,
          }
          if (walletState.durability === 'persistent') {
            const stampClient = new MonadStampClient(
              createMonadStampWalletHandle({
                walletState,
                provider,
                httpClient,
                relayBaseUrl: config.relayBaseUrl,
              })
            )
            if (typeof stampClient.reconcileStartupOrThrow === 'function') {
              await stampClient.reconcileStartupOrThrow()
            } else {
              await stampClient.reconcileOrThrow()
            }
            const postClient = new MonadTopicPostClient(wallet)
            if (typeof postClient.resumePendingOperations === 'function') {
              await postClient.resumePendingOperations()
            }
            const voteClient = new MonadTopicVoteClient(wallet)
            if (typeof voteClient.resumePendingOperations === 'function') {
              await voteClient.resumePendingOperations()
            }
          }
          pool.ensureUnfundedSize(config.subAccountPoolSize)
          await pool.flush()
          return wallet
        } catch (error) {
          await walletState.close().catch(() => undefined)
          throw error
        }
      })()
      walletsByIdentity.set(identityKey, pending)
      try {
        return await pending
      } catch (err) {
        walletsByIdentity.delete(identityKey)
        throw err
      }
    },

    async restoreWallet(seed, options): Promise<WalletHandle> {
      if (config.walletStorageLocation === false) {
        throw new Error('Seed restore requires persistent wallet storage')
      }
      const identity = MonadIdentity.fromSeed(seed)
      const identityKey = identity.address.raw.toLowerCase()
      if (walletsByIdentity.has(identityKey)) {
        throw new Error('Wallet is already open; close it before seed restore')
      }
      const pending = (async (): Promise<MonadChainWalletHandle> => {
        const provider = new JsonRpcProvider(config.rpcUrl)
        const httpClient = new MonadHttpClient({ rpcUrl: config.rpcUrl })
        const walletState = await restoreMonadWalletBundleFromSeed({
          location: `${config.walletStorageLocation}-${identityKey}`,
          seed: {
            mnemonic: seed.mnemonic,
            passphrase: seed.passphrase,
          },
          provider,
          senderIndexCap: options.senderIndexCap,
          changeIndexCap: options.changeIndexCap,
          scanBatchSize: options.scanBatchSize,
        })
        try {
          const wallet: MonadChainWalletHandle = {
            identity,
            pool: walletState.pool,
            leaseManager: walletState.leaseManager,
            provider,
            httpClient,
            changePool: walletState.changePool,
            stampPaymentJournal: walletState.stampPaymentJournal,
            stampAttemptJournal: walletState.stampAttemptJournal,
            topicOperationJournal: walletState.topicOperationJournal,
            walletState,
            relayBaseUrl: config.relayBaseUrl,
          }
          const stampClient = new MonadStampClient(
            createMonadStampWalletHandle({
              walletState,
              provider,
              httpClient,
              relayBaseUrl: config.relayBaseUrl,
            })
          )
          if (typeof stampClient.reconcileStartupOrThrow === 'function') {
            await stampClient.reconcileStartupOrThrow()
          } else {
            await stampClient.reconcileOrThrow()
          }
          const postClient = new MonadTopicPostClient(wallet)
          if (typeof postClient.resumePendingOperations === 'function') {
            await postClient.resumePendingOperations()
          }
          const voteClient = new MonadTopicVoteClient(wallet)
          if (typeof voteClient.resumePendingOperations === 'function') {
            await voteClient.resumePendingOperations()
          }
          for (let index = 0; index < config.subAccountPoolSize; index++) {
            walletState.pool.deriveNextUnfunded()
          }
          await walletState.pool.flush()
          return wallet
        } catch (error) {
          await walletState.close().catch(() => undefined)
          throw error
        }
      })()
      walletsByIdentity.set(identityKey, pending)
      try {
        return await pending
      } catch (error) {
        walletsByIdentity.delete(identityKey)
        throw error
      }
    },

    nativeTransfers,

    async fetchProfile(
      addr: ChainAddress,
      opts?: { relayBaseUrl?: string }
    ): Promise<ProfileInfo | undefined> {
      return fetchMonadProfile({
        relayBaseUrl: opts?.relayBaseUrl ?? config.relayBaseUrl,
        address: addr,
      })
    },

    directMessages,
    topics,
  }
}

/** The default, env-configured `MonadChain` singleton -- `./index.ts`'s `activeChain` is exactly
 * this. See this file's header, "Configuration", for why reading env here (rather than in every
 * wallet client) is the right composition point. */
export const MonadChain: ActiveChain = createMonadChain(
  loadMonadChainConfigFromEnv()
)
