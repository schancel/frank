/**
 * The compile-time chain-selection seam (ticket #41 -- see `PLAN.md`'s M9 section, "Design: a
 * compile-time `ActiveChain` seam"). One interface, `ActiveChain`, is satisfied by exactly one real
 * implementation (`./monad-chain.ts`'s `MonadChain`), selected once at compile time via
 * `./index.ts`'s `activeChain` constant. Every store/component that needs address formatting, a
 * unit/denomination, a wallet factory, or direct-message/topic-broadcast operations is meant to
 * import through `activeChain` in follow-on tickets (#42/#43) rather than reaching into
 * chain-specific modules (`../wallet/monad-*`, or the old Lotus `../registry`/`../relay`) directly.
 *
 * Deliberately a compile-time constant, not a runtime multi-chain dispatch -- matches M8's own
 * deferred-cross-chain-schema reasoning (`PLAN.md`): only one chain (Monad) is real right now, and
 * a generic multi-chain abstraction designed from a single example risks guessing its shape wrong
 * and needing a rewrite anyway once a second chain actually exists. `LotusChain` is explicitly not
 * built here (see issue #41's "Non-goals") -- this interface is only proven against Monad's real
 * client signatures.
 *
 * ## Deviations from issue #41's own interface sketch, and why
 *
 * The issue's proposed interface is the starting point, not gospel, once real client signatures
 * (`../wallet/monad-*.ts`) are checked against it -- per the ticket's own instructions. Three real
 * deviations, each forced by an actual signature/type mismatch, not stylistic preference:
 *
 * 1. **`WalletHandle` needed to grow past `{ identity }`.** `directMessages.send`/`topics.post`/
 *    `.vote` all need a *sender-specific* signing/leasing/HTTP bundle to actually build and submit
 *    a burn transaction (`MonadStampClient`/`MonadTopicPostClient`/`MonadTopicVoteClient` all take
 *    the same `{ pool, leaseManager, provider, httpClient, relayBaseUrl }` shape, formalized as
 *    `MonadWalletHandle` in `../wallet/monad-wallet-handle.ts`). The generic `WalletHandle` below
 *    still only *promises* `identity` -- it's `MonadChain`'s own concrete `MonadChainWalletHandle`
 *    (`./monad-chain.ts`) that adds the rest. This is safe under the compile-time seam: in a
 *    Monad-only build, `MonadChain.createWallet` is the only producer of `WalletHandle` values, so
 *    every handle reaching `MonadChain`'s other methods already carries the extra fields (see
 *    `./monad-chain.ts`'s `asMonadWallet`).
 * 2. **`DirectMessageClient.fetchSince` returns `DirectMessageReceived[]`, not
 *    `ReceivedMessageWrapper[]`** (`../types/user-interface.ts`, the issue's own sketched return
 *    type). That type is UTXO/Lotus-pubkey-shaped (`outpoints: Utxo[]`, `copartyPubKey: PublicKey`
 *    from `bitcore-lib-xpi`, `stampValue: number`) -- and `PLAN.md`'s own M9 notes explicitly flag
 *    this exact situation: "`ChatMessage.outpoints: Utxo[]`/`ForumMessage.satoshis` are UTXO-shaped
 *    fields baked into stored message types -- #42/#43 need an explicit decision on the Monad-side
 *    replacement ..., not a silent type change." Forcing Monad's real fields (`burnValueWei:
 *    bigint`, no UTXOs, no bitcore pubkey) into `ReceivedMessageWrapper` here would be exactly the
 *    silent type change PLAN.md warns against, so this ticket introduces its own minimal, honestly
 *    Monad-shaped type instead and leaves folding it into (or replacing) `ReceivedMessageWrapper`
 *    to #42, which owns `stores/chats.ts` and can make that call with the UI's actual needs in
 *    view.
 * 3. **`TopicBroadcastClient.post` gained a required `direction` field**, absent from the issue's
 *    sketch. `MonadTopicPostClient.submitTopicPost` (`../wallet/monad-topic-post-client.ts`)
 *    requires a vote direction for a post's own initial vote -- "even a post's own first vote can
 *    be up or down" (that file's own doc comment) -- with no default, mirroring `PLAN.md`'s M8
 *    "Correction" note that Lotus's own `createBroadcast` has no code path for posting without a
 *    vote either. Omitting it here would force a silently-guessed default direction into every
 *    post, which is exactly the kind of unstated encoding choice issue #41 itself warns against
 *    (see the note on `direction` vs. signed `voteWeightWei` below).
 */
import { ForumMessage, ForumMessageEntry } from '@frank/cashweb/types/forum'
import { MessageItem } from '@frank/cashweb/types/messages'

/** Canonical string form of an on-chain address, for storage keys, API calls, and equality checks.
 * For `MonadChain`, this is an EIP-55 checksummed `0x...` string (`../wallet/monad-identity.ts`) --
 * there is deliberately no separate "API" vs. "display" encoding the way Lotus's
 * `toAPIAddress`/`toDisplayAddress` (`../../utils/address.ts`) need, since EVM has exactly one
 * canonical address representation. */
export interface ChainAddress {
  readonly raw: string
}

/** A chain-agnostic HD seed. Mirrors the only real seed-consuming primitive in this codebase today
 * (`../wallet/monad-hd-keyring.ts`'s `MonadHdKeyring.fromMnemonic(mnemonic, passphrase)`) rather
 * than inventing an abstract seed format with no real consumer yet. */
export interface HDSeed {
  /** BIP-39 mnemonic phrase. */
  mnemonic: string
  /** Optional BIP-39 25th-word passphrase. Defaults to none. */
  passphrase?: string
}

export interface FrankIdentityHandle {
  address: ChainAddress
  displayAddress: string
}

/** The generic per-user wallet handle every `ActiveChain` method that needs a sender identity
 * takes. See this file's header, deviation 1: concrete chain implementations (`MonadChain`) attach
 * more than `identity` to the object they actually hand back from `createWallet`; this interface
 * only promises what every chain implementation must have. */
export interface WalletHandle {
  readonly identity: FrankIdentityHandle
}

/** A looked-up identity's registered profile/pubkey -- `contacts.ts` (#42) needs this to resolve a
 * coparty's encryption key; the Lotus-side equivalent is `../wallet/lotus-identity.ts`'s
 * `fetchIdentityPubKey`, which Monad had no analog of before this ticket
 * (`../wallet/monad-identity.ts`'s `fetchMonadProfile`). */
export interface ProfileInfo {
  address: ChainAddress
  /** Raw registered public key bytes (secp256k1), if any -- needed to derive an ECDH shared key
   * for direct-message encryption (`../wallet/monad-message-envelope.ts`). */
  pubKey: Uint8Array
}

export interface DirectMessageSendResult {
  payloadDigest: string
  burnValueWei: bigint
}

/** A single decrypted, received direct message. See this file's header, deviation 2, for why this
 * isn't `ReceivedMessageWrapper` (`../types/user-interface.ts`). */
export interface DirectMessageReceived {
  senderAddress: ChainAddress
  recipientAddress: ChainAddress
  items: MessageItem[]
  /** Bare (no `0x`) hex `payload_hash` of the stamped message this was decoded from. */
  payloadDigest: string
  /** Wei actually burned in the message's stamp transaction (read back from the signed burn tx
   * itself, not merely echoing a configured constant -- see `./monad-chain.ts`). */
  burnValueWei: bigint
  /** Milliseconds since the Unix epoch, as recorded by the relay. */
  receivedTime: number
}

export interface DirectMessageClient {
  send(params: {
    wallet: WalletHandle
    recipient: ChainAddress
    items: MessageItem[]
  }): Promise<DirectMessageSendResult>
  fetchSince(params: {
    wallet: WalletHandle
    sinceMs: number
  }): Promise<DirectMessageReceived[]>
}

/** Standard native-asset wallet operations, independent of Frank's mandatory message stamps. */
export interface NativeTransferClient {
  getBalance(params: { wallet: WalletHandle }): Promise<bigint>
  send(params: {
    wallet: WalletHandle
    recipient: ChainAddress
    value: bigint
  }): Promise<{ txHash: string }>
}

export interface TopicBroadcastClient {
  post(params: {
    wallet: WalletHandle
    topic: string
    entries: ForumMessageEntry[]
    /** This post's own initial vote direction -- see this file's header, deviation 3, for why this
     * is required (no default), unlike the issue's own sketch. */
    direction: 'up' | 'down'
    voteWeightWei: bigint
    parentDigest?: string
  }): Promise<{ payloadDigest: string }>
  vote(params: {
    wallet: WalletHandle
    payloadDigest: string
    voteWeightWei: bigint
    direction: 'up' | 'down'
  }): Promise<void>
  fetchByTopic(params: {
    wallet: WalletHandle
    topic: string
    sinceMs?: number
  }): Promise<ForumMessage[]>
  fetchOne(payloadDigest: string): Promise<ForumMessage | undefined>
  /** Discover distinct topic names the relay has seen at least one (burn-gated) post for, each
   * with its post count and last-activity timestamp, ordered by last-activity descending (ticket
   * #72). No `wallet` needed -- like `fetchOne`, this is a plain read against the chain's own
   * configured relay. Fails soft (`[]`) on any error -- see `../monad-topic-tally-client.ts`'s
   * `fetchDiscoveredTopics` for why: this is purely additive discovery on top of
   * `app/src/stores/topics.ts`'s hardcoded default topic list. */
  discoverTopics(): Promise<
    { topic: string; postCount: number; lastActivityMs: number }[]
  >
}

export interface ActiveChain {
  readonly name: string
  /** Display denomination, e.g. `'MON'`. */
  readonly unit: string
  toDisplayAmount(raw: bigint): string
  fromDisplayAmount(display: string): bigint
  formatAddress(addr: ChainAddress): string
  parseAddress(input: string): ChainAddress | undefined
  createWallet(seed: HDSeed): Promise<WalletHandle>
  nativeTransfers: NativeTransferClient
  /** Look up an identity's registered profile/pubkey. Returns `undefined` if nothing is
   * registered under `addr` yet. `opts.relayBaseUrl`, when given, looks the address up against
   * that relay instead of this chain's own configured default (ticket #78 -- a client-initiated,
   * one-off "finger this specific relay" lookup, not a change to which relay the chain otherwise
   * talks to). */
  fetchProfile(
    addr: ChainAddress,
    opts?: { relayBaseUrl?: string },
  ): Promise<ProfileInfo | undefined>
  directMessages: DirectMessageClient
  topics: TopicBroadcastClient
}

/** Parsed result of {@link parseAddressWithOptionalRelay}. */
export interface AddressWithOptionalRelay {
  /** Everything before the last `@`, or the whole input if there's no `@`. */
  address: string
  /** Everything after the last `@`, normalized to an `http(s)://` base URL, or `undefined` if
   * the input had no `@`. */
  relayBaseUrl?: string
}

/** Parses a "finger"-style `address@relayHost` input (ticket #78): splits on the *last* `@` (an
 * address itself never contains one, so this is unambiguous), and normalizes the right-hand side
 * into a base URL `fetchProfile`'s `opts.relayBaseUrl` can use directly.
 *
 * - No `@` present: returns `{ address: input }` -- today's existing single-field behavior,
 *   completely unchanged (this is the common case; a future UI built on this can use one input
 *   field for both, not two).
 * - `@relayHost` present: `relayHost` is used as-is if it already has an `http://`/`https://`
 *   scheme, otherwise `https://` is prepended (the common case -- typing a bare hostname should
 *   mean "the usual secure default", not force the user to type a scheme every time).
 *
 * Pure parsing only -- does not validate that `address` is a real chain address (that's
 * `ActiveChain.parseAddress`'s job) or that `relayBaseUrl` points at a reachable relay (that's
 * whatever calls `fetchProfile` with it). Deliberately not wired into any UI component yet -- see
 * issue #78's own comment thread for why the actual entry point (`AddContact.vue` or a new
 * dialog) is a separate, not-yet-decided UX question. */
export function parseAddressWithOptionalRelay(
  input: string,
): AddressWithOptionalRelay {
  const at = input.lastIndexOf('@')
  if (at === -1) {
    return { address: input }
  }
  const address = input.slice(0, at)
  const host = input.slice(at + 1)
  const relayBaseUrl = /^https?:\/\//i.test(host) ? host : `https://${host}`
  return { address, relayBaseUrl }
}
