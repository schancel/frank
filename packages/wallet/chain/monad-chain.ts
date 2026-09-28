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
  formatEther,
  getAddress,
  getBytes,
  hexlify,
  parseEther,
} from 'ethers'

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

import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadChangeKeyring } from '../monad-change-keyring'
import { MonadChangePool } from '../monad-change-pool'
import { MonadSubAccountPool } from '../monad-account-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { MonadHttpClient } from '../monad-http'
import { MonadAccountTxSigner } from '../monad-account-tx'
import { MonadWalletHandle } from '../monad-wallet-handle'
import { MonadIdentity, fetchMonadProfile } from '../monad-identity'
import {
  MonadStampClient,
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
import { LevelSubAccountPoolStore } from '../storage/level-sub-account-pool-store'
import { LevelChangePoolStore } from '../storage/level-change-pool-store'
import {
  InMemoryStampPaymentJournal,
  LevelStampPaymentJournal,
} from '../storage/stamp-payment-journal'
import {
  InMemoryStampAttemptJournal,
  LevelStampAttemptJournal,
} from '../storage/stamp-attempt-journal'

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
      readEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI') ?? '1000000000000',
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
        'WalletHandle missing the Monad wallet-client bundle',
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

/** JSON-serializes `items` for use as a direct message's plaintext -- only the item kinds that
 * have a real Monad-side meaning (see this file's header). Throws on `'stealth'`/`'p2pkh'` items,
 * which have no Monad equivalent to build (no UTXO coin selection exists on this chain -- see
 * `PLAN.md`'s M9 notes). */
export function serializeMessageItems(items: MessageItem[]): string {
  for (const item of items) {
    if (item.type === 'stealth' || item.type === 'p2pkh') {
      throw new Error(
        `MonadChain direct messages don't support '${item.type}' items: on-chain-payment-` +
          "embedded-in-message has no Monad equivalent (see PLAN.md's M9 notes)",
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
  return parsed as MessageItem[]
}

/** Adapts a `MonadTopicPostViewProto` (`../wallet/monad-topic-tally-client.ts`) into the
 * pre-existing `ForumMessage` shape (`../types/forum.ts`) -- mirrors `../registry/index.ts`'s
 * `parseWrapper` field-for-field; see this file's header for the per-field reasoning. Returns
 * `undefined` if `view` doesn't carry a stored post (shouldn't happen for a view actually returned
 * by the relay, but keeps this function total). */
export function viewToForumMessage(
  view: MonadTopicPostViewProto,
): ForumMessage | undefined {
  const stored = view.post
  const post = stored?.post
  if (stored === undefined || post === undefined) return undefined

  const entries: ForumMessageEntry[] = []
  const broadcastMessage = BroadcastMessage.deserializeBinary(
    post.encryptedPayload,
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
  const directMessages: DirectMessageClient = {
    async send(params): Promise<DirectMessageSendResult> {
      const wallet = asMonadWallet(params.wallet)
      const plaintext = serializeMessageItems(params.items)

      const recipientProfile = await fetchMonadProfile({
        relayBaseUrl: wallet.relayBaseUrl,
        address: params.recipient,
      })
      if (recipientProfile === undefined) {
        throw new Error(
          `No registered profile/pubkey found for ${params.recipient.raw}`,
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

      const stampClient = new MonadStampClient(wallet)
      const result = await stampClient.submitStampedMessage({
        encryptedPayload: envelopeBytes,
        // Ticket #57: a DM's stamp is a real payment to the recipient (mirroring Lotus's
        // `constructStampTransactions`, which derives the stamp output address from the
        // recipient's own pubkey), not a burn to the fixed dead address -- that's `topics`'
        // `post`/`vote` below, where there's no single recipient to pay.
        recipientPublicKey: recipientProfile.pubKey,
        stampValueWei: config.defaultStampValueWei,
      })

      return {
        payloadDigest: result.payloadHashHex,
        stampValueWei: config.defaultStampValueWei,
      }
    },

    async fetchSince(params): Promise<DirectMessageReceived[]> {
      const wallet = asMonadWallet(params.wallet)
      const stored = await fetchMonadMessagesSince({
        relayBaseUrl: wallet.relayBaseUrl,
        sinceMs: params.sinceMs,
      })

      const myAddress = wallet.identity.address.raw.toLowerCase()
      const received: DirectMessageReceived[] = []

      for (const record of stored) {
        if (record.message === undefined) continue
        const envelope = parseEnvelope(record.message.encryptedPayload)
        if (envelope === undefined) continue
        if (envelope.to.toLowerCase() !== myAddress) continue

        const payloadHashHex = bareHex(record.message.payloadHash)
        if (wallet.stampPaymentJournal !== undefined) {
          const recovered = recoverMonadStampPayments({
            message: record.message,
            recipientPrivateKey: getBytes(wallet.identity.toPrivateKeyHex()),
          })
          for (const payment of recovered) {
            const existing = wallet.stampPaymentJournal.get(
              payloadHashHex,
              payment.childIndex,
            )
            if (existing !== undefined) continue
            await wallet.stampPaymentJournal.put({
              payloadHashHex,
              childIndex: payment.childIndex,
              txHash: payment.txHash,
              address: payment.address,
              valueWei: payment.valueWei.toString(),
              status: 'discovered',
            })
          }
        }

        const senderProfile = await fetchMonadProfile({
          relayBaseUrl: wallet.relayBaseUrl,
          address: toChainAddress(envelope.from),
        })
        if (senderProfile === undefined) continue

        let plaintext: string
        try {
          plaintext = decryptEnvelope({
            envelope,
            myPrivateKey: wallet.identity.toBitcorePrivateKey(),
            senderPubKey: Buffer.from(senderProfile.pubKey),
          })
        } catch {
          // Wrong/stale key, corrupted ciphertext, etc. -- skip rather than surface a parse error
          // for one bad message out of a whole page.
          continue
        }

        const stampValueWei = record.message.stampPayments.reduce(
          (sum, payment) =>
            sum + Transaction.from(hexlify(payment.rawTx)).value,
          BigInt(0),
        )

        received.push({
          senderAddress: toChainAddress(envelope.from),
          recipientAddress: toChainAddress(envelope.to),
          items: deserializeMessageItems(plaintext),
          payloadDigest: payloadHashHex,
          stampValueWei,
          receivedTime: record.timestamp,
        })
      }
      return received
    },

    async listRecoveredStampPayments({ wallet }) {
      const monadWallet = asMonadWallet(wallet)
      return (monadWallet.stampPaymentJournal?.getAll() ?? []).map(record => ({
        payloadDigest: record.payloadHashHex,
        childIndex: record.childIndex,
        txHash: record.txHash,
        address: toChainAddress(record.address),
        valueWei: BigInt(record.valueWei),
        status: record.status,
        sweepTxHash: record.sweepTxHash,
      }))
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
      const record = journal.get(payloadDigest, childIndex)
      if (record === undefined) {
        throw new Error(
          `No recovered stamp payment ${payloadDigest}:${childIndex}`,
        )
      }
      if (record.status === 'swept') {
        throw new Error(
          `Stamp payment ${payloadDigest}:${childIndex} was already swept`,
        )
      }
      const child = deriveMonadStampChildPrivate({
        payloadHash: getBytes(`0x${payloadDigest}`),
        recipientPrivateKey: getBytes(monadWallet.identity.toPrivateKeyHex()),
        paymentIndex: childIndex,
      })
      if (child.address.toLowerCase() !== record.address.toLowerCase()) {
        throw new Error(
          `Recovered stamp-payment address ${record.address} does not match derived child ${child.address}`,
        )
      }
      const outcome = await sweepRecoveredMonadStampPayment({
        payment: {
          childIndex,
          address: child.address,
          privateKey: child.privateKey,
          txHash: record.txHash,
          valueWei: BigInt(record.valueWei),
        },
        destinationAddress: destination.raw,
        provider: monadWallet.provider,
        httpClient: monadWallet.httpClient,
      })
      if (outcome.swept) {
        await journal.put({
          ...record,
          status: 'swept',
          sweepTxHash: outcome.txHash,
        })
        return {
          swept: true,
          txHash: outcome.txHash,
          valueWei: outcome.valueWei,
        }
      }
      return outcome
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
      const signer = new MonadAccountTxSigner({
        privateKey: monadWallet.identity.toPrivateKeyHex(),
        provider: monadWallet.provider,
        httpClient: monadWallet.httpClient,
      })
      const signed = await signer.buildAndSignTransfer(recipient.raw, value)
      return { txHash: await signer.submit(signed) }
    },
  }

  const topics: TopicBroadcastClient = {
    async post(params): Promise<{ payloadDigest: string }> {
      const wallet = asMonadWallet(params.wallet)
      const client = new MonadTopicPostClient(wallet)
      const result = await client.submitTopicPost({
        topic: params.topic,
        entries: params.entries,
        parentPostHash: params.parentDigest
          ? getBytes(`0x${params.parentDigest}`)
          : undefined,
        direction: params.direction,
        burnAddress: config.stampBurnAddress,
        voteWeightWei: params.voteWeightWei,
      })
      return { payloadDigest: result.payloadHashHex }
    },

    async vote(params): Promise<void> {
      const wallet = asMonadWallet(params.wallet)
      const client = new MonadTopicVoteClient(wallet)
      await client.castVote({
        targetPayloadHash: getBytes(`0x${params.payloadDigest}`),
        direction: params.direction,
        burnAddress: config.stampBurnAddress,
        voteWeightWei: params.voteWeightWei,
      })
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
        const keyring = MonadHdKeyring.fromMnemonic(
          seed.mnemonic,
          seed.passphrase,
        )
        const storageLocation =
          config.walletStorageLocation === false
            ? undefined
            : `${config.walletStorageLocation}-${identityKey}`
        const subAccountStore =
          storageLocation === undefined
            ? undefined
            : new LevelSubAccountPoolStore(storageLocation)
        const changeStore =
          storageLocation === undefined
            ? undefined
            : new LevelChangePoolStore(storageLocation)
        const stampPaymentJournal =
          storageLocation === undefined
            ? new InMemoryStampPaymentJournal()
            : new LevelStampPaymentJournal(storageLocation)
        const stampAttemptJournal =
          storageLocation === undefined
            ? new InMemoryStampAttemptJournal()
            : new LevelStampAttemptJournal(storageLocation)
        await Promise.all([
          subAccountStore?.Open(),
          changeStore?.Open(),
          stampPaymentJournal instanceof LevelStampPaymentJournal
            ? stampPaymentJournal.Open()
            : undefined,
          stampAttemptJournal instanceof LevelStampAttemptJournal
            ? stampAttemptJournal.Open()
            : undefined,
        ])

        const pool = new MonadSubAccountPool({
          keyring,
          store: subAccountStore,
        })
        pool.ensureSize(config.subAccountPoolSize)
        const pendingLeaseIndices = new Set(
          stampAttemptJournal.getAll().flatMap(attempt => attempt.leaseIndices),
        )
        for (const record of pool.records()) {
          if (
            record.status === 'in-use' &&
            !pendingLeaseIndices.has(record.index)
          ) {
            // A crash during signing can persist the lease before the exact raw set exists. No
            // relay broadcast is possible in that window, but the account is conservatively
            // retired rather than silently reused with an uncertain locally-signed nonce.
            pool.setStatus(record.index, 'retired')
          }
        }
        await pool.flush()
        const changePool = new MonadChangePool({
          keyring: MonadChangeKeyring.fromMnemonic(
            seed.mnemonic,
            seed.passphrase,
          ),
          store: changeStore,
        })
        const leaseManager = new SubAccountLeaseManager(pool)
        const provider = new JsonRpcProvider(config.rpcUrl)
        const httpClient = new MonadHttpClient({ rpcUrl: config.rpcUrl })
        const wallet: MonadChainWalletHandle = {
          identity,
          pool,
          leaseManager,
          provider,
          httpClient,
          changePool,
          stampPaymentJournal,
          stampAttemptJournal,
          relayBaseUrl: config.relayBaseUrl,
        }
        await new MonadStampClient(wallet).resumePendingAttempts()
        return wallet
      })()
      walletsByIdentity.set(identityKey, pending)
      try {
        return await pending
      } catch (err) {
        walletsByIdentity.delete(identityKey)
        throw err
      }
    },

    nativeTransfers,

    async fetchProfile(
      addr: ChainAddress,
      opts?: { relayBaseUrl?: string },
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
  loadMonadChainConfigFromEnv(),
)
