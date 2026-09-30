> **Update (2026-09-27, autonomous overnight session):** the bot and its scripts were ported off
> `lotus-identity.ts`/`FrankIdentity` onto `monad-identity.ts`/`MonadIdentity` -- the real Frank UI's
> `ActiveChain`/`MonadChain` stack (tickets #41-#45) only ever resolves a contact via
> `fetchMonadProfile`, which never finds a Lotus-registered identity, so the bot was previously
> invisible to (and couldn't message) any real wallet created through the app. The "Live proof"
> section below is left exactly as it was written -- an accurate historical record of that original,
> Lotus-identity run -- but is no longer how the bot actually authenticates itself; see each script's
> own updated header comment (compile command, imports) for the current shape, and the "fix(app):
> wire up identity registration; port Qwen bot to Monad-native identity" commit for the full
> before/after, including a real wire-format interop bug (bare-string vs. `MessageItem[]` JSON) only
> found by actually running the bot against a real `ActiveChain` wallet.

# Ticket #9: a Qwen 3.8 Max agent with its own on-chain Frank identity

This is the runbook and bounty write-up for issue #9 (stretch): a headless client that bridges
real conversation turns between a human/script and **Qwen 3.8 Max** (Alibaba Cloud), speaking only
over **Frank**, a burn-to-speak messaging protocol on **Monad testnet**. Written for the Alibaba
Cloud "Best Builds with Qwen" bounty (Trust, Identity & AI track).

Everything described here is real and was run live against Monad testnet and Alibaba Cloud's Qwen
API while implementing this ticket — see "Live proof from this ticket's own run" below for the
actual transcript, transaction hashes, and independent on-chain verification.

## What this is, and why it's "agentic"

Most "AI agent" demos give a model a tool to call and call it a day. This is a different, more
literal claim: **the agent owns a cryptographic identity and pays its own way to communicate.**

- The bot generates its own secp256k1 keypair and derives its own Frank address
  (`lotus-identity.ts`) — nobody hands it credentials; it mints its own.
- It registers that identity on a live `cashweb-registry` relay via a real, signed `PUT /metadata/:addr` — the same identity-registration primitive a human Frank user would use.
- To reply to anyone, it must **burn real MON** (Monad's native token) in a stamp transaction it
  builds and signs itself, from a funded sub-account it manages itself (`qwen-bot-common.ts`,
  building on tickets #13/#14/#18/#34). No message goes out without a real, on-chain cost paid by
  the agent's own key.
- It reads every incoming message by trial-decrypting a real end-to-end-encrypted envelope
  (`monad-message-envelope.ts`) using ECDH between its own identity key and the sender's — a key
  it resolves by looking the sender up in the _same_ trust-anchored identity registry, not by
  trusting a self-asserted value in the message itself.

That's the "Trust, Identity & AI" angle: this isn't a wrapper around an API key sitting in an env
var. It's an agent whose right to speak is enforced by the same economic/cryptographic primitive
every other Frank user is bound by, and whose identity is independently verifiable by anyone who
can query the registry — a genuinely novel trust substrate for an autonomous agent, not just a
chatbot with blockchain flavor text sprinkled on top.

## Architecture

```
 human/script                         cashweb-registry relay                    bot
 (qwen-bot-send-demo.livecheck.ts)    (real HTTP server, real Monad RPC)   (qwen-bot.livecheck.ts)
 ─────────────────────────────        ──────────────────────────────      ─────────────────────
 1. register identity  ───PUT /metadata/:addr────────────────────────────────▶ (same, on startup)
 2. encrypt msg (ECDH), burn MON,
    PUT /message/monad  ──────────────────────────────────────────────────▶
                                        broadcasts+confirms+verifies burn tx
                                        on real Monad testnet, stores msg
 3. signed mailbox read (challenge +   ◀───────────────────────────────    4. same, as the bot's
    GET /message/monad/inbox/:me)                                                own recipient,
                                                                                  find msg addressed
                                                                                  to itself, decrypt
                                                                               5. ask Qwen 3.8 Max
                                                                                  (real streaming
                                                                                  HTTPS call)
                                                                               6. encrypt reply,
                                                                                  burn MON, PUT
    decrypt reply,             ◀───────────────────────────────────────────     /message/monad
    print Qwen's real answer
```

Library code (reusable, no side effects at import time):

- `lotus-identity.ts` — Frank/Lotus identity: keypair, address derivation (a from-scratch
  reimplementation of `bitcoinsuite_core::LotusAddress`, verified against its own Rust test
  vectors), signing, `PUT`/`GET /metadata/:addr`.
- `monad-message-envelope.ts` — the E2E encryption + recipient-addressing convention (see "The
  recipient-filtering gap" below), reusing `../relay/crypto.ts`'s existing ECDH+AES code.
- `monad-message-feed.ts` / `monad-mailbox-client.ts` — the authenticated recipient mailbox
  client (`POST /message/monad/auth/:me` challenge, identity-key signature, then
  `GET /message/monad/inbox/:me` with cursor paging). It replaced ticket #37's unauthenticated
  `GET /message/monad?since=<t>`, which PR #197 removed.
- `qwen-client.ts` — Qwen 3.8 Max streaming chat client (SSE, hand-parsed; the endpoint rejects
  non-streaming requests — see "Qwen API notes" below).
- `qwen-bot-common.ts` — shared identity/funding/sub-account-pool setup for both scripts below,
  including a nonce-race retry wrapper (see "Problems found and fixed" below).

Runnable entry points (`.livecheck.ts`, this app's existing convention for scripts that hit the
real network — excluded from `jest`'s `testMatch`, meant to be run manually):

- `qwen-bot.livecheck.ts` — the agent itself.
- `qwen-bot-send-demo.livecheck.ts` — the "human/script" side, for driving a live demo
  conversation (supports multiple sequential turns via `QWEN_BOT_MESSAGES`).

## How the recipient-filtering gap was solved for this demo

> **Historical (pre-PR #197).** The relay now serves each recipient only its own inbox behind a
> signed challenge, so bots read `fetchMonadMessagesSince({ ...mailboxAuthFor(identity, relayBaseUrl),
sinceMs })` and no longer download the global feed. The envelope's `to` check below is retained as
> defence in depth.

Ticket #37's `GET /message/monad?since=<t>` returns **every** stored message — there's no
recipient field on `MonadStampedMessage`/`StoredMonadMessage` for the relay to filter on (see that
route's own module doc in `backend/cashweb/cashweb-registry/src/http/monad_message.rs` for the
full reasoning). Fixing that for real means adding a wire-format field (`recipient_address_hint`,
sketched in that file's doc comment) — a deliberate proto change left for review, not made
unilaterally by this stretch ticket, since #16/#19/#27/#30/#37 all build on that proto.

Instead, messages use the version-2 envelope documented in `monad-message-envelope.ts`: ECDH plus
HKDF-SHA256 derives an AES-256-GCM key, and the version, Frank network tag, sender, and recipient
are authenticated as associated data. `from`/`to` remain relay-visible routing hints, while the
ciphertext and GCM tag provide confidentiality and tamper detection without adding a public sender
signature; either conversation participant can still construct an indistinguishable transcript.
Pollers compare EVM identities case-independently and persist canonical lower-case identity keys,
so checksum spelling is never a second bot user or raffle entrant. Readers always resolve the
sender's public key through the trust-anchored profile registry rather than accepting one from the
envelope. Version 1 AES-CBC envelopes remain parse/decrypt-only compatibility for records already
stored (including historical upper-case address spellings); no builder or new relay admission path
emits or accepts v1.

## Qwen API notes (confirmed live)

- `POST {QWEN_OPENAI_COMPATIBLE_ENDPOINT}/chat/completions`, model `qwen3.8-max`.
- **Must** pass `"stream": true` and `"enable_thinking": true` — a plain non-streaming request is
  rejected. `qwen-client.ts` hand-parses the resulting SSE stream (`choices[0].delta.content` for
  the reply text, `.delta.reasoning_content` for the model's visible reasoning, logged separately
  for this write-up but never sent back over Frank as part of the reply).

## Problems found and fixed while wiring this up

Both are genuine bugs/gaps found only by actually running the full pipeline live, fixed minimally
and documented at the fix site (same standard ticket #8 held itself to):

1. **`bitcore-lib-xpi`'s `PrivateKey.fromBuffer` silently drops key compression.**
   `PrivateKey._transformBNBuffer` (the path `fromBuffer` takes for a raw 32-byte key) hardcodes
   `compressed: false`, while the constructor's plain-hex-_string_ path defaults to `compressed: true`. A freshly-generated identity (`new PrivateKey()`, no args) got a 33-byte compressed
   pubkey; the _same_ identity reloaded via `fromBuffer` on a later run got a 65-byte uncompressed
   one — and the live registry's `PUT /metadata/:addr` rejects that with `400 invalid-pub-key-len` (`PubKeyHash` requires exactly 33 bytes). Confirmed live: the bot's first
   run worked, its second run (reloading the same persisted identity) failed with exactly this
   error until fixed. Fix: `FrankIdentity.fromPrivateKeyHex` (`lotus-identity.ts`) passes the hex
   _string_ to `PrivateKey`'s constructor instead of calling `fromBuffer`, sidestepping the buggy
   path entirely. Not a fix to `bitcore-lib-xpi` itself (a vendored third-party library) — worked
   around in this ticket's own new code only.
2. **The shared funded testnet wallet is in concurrent use by other activity in this
   environment.** Its balance and `eth_getTransactionCount` kept moving between this ticket's own
   transactions, and `fanOutFundSubAccounts` (#14) has no retry logic for a nonce fetched via
   `eth_getTransactionCount(addr, "pending")` going stale by submit time — confirmed live,
   repeatedly, as `"nonce has already been used"` / `NONCE_EXPIRED` errors. `fanOutFundSubAccounts`
   itself is untouched (its own doc comment already calls this "out of scope" for that ticket); this
   ticket's own `fundPoolWithRetry` (`qwen-bot-common.ts`) instead calls it directly with its
   `onFunded` hook, retrying only whichever sub-accounts didn't already get a real funding tx
   broadcast on a nonce-race failure, up to 6 attempts with linear backoff.

Also worth surfacing plainly: this ticket's instructions described the shared wallet
(`frank-worktrees/spike-demo/spike/data/chain-wallet.json`) as down to ~0.0177 MON by the time this
ticket started (per ticket #8's own balance having been spent down in the interim). That figure
turned out to describe a _different_ address — a one-time, already-`spent`, never-swept sub-account
from ticket #8's own ephemeral pool (`0x7494372aF686Db5ABC346fB4Cc49B5b17Fe8bEE8`, single-use by
design per ticket #34), not the main wallet itself. The actual main wallet
(`0xf7a977F50E825D9f9ea403a03Fca9828FEa65E9c`) had ~9.94 MON when this ticket's demo ran — plenty
for the multi-turn conversation below. This ticket's code (`qwen-bot-common.ts`'s dynamic,
fee-data-driven `gasReserve`) was written before this was discovered, under the (mistaken, at the
time) assumption of a near-empty wallet — left as-is since a frugal, no-guessing gas reserve is
strictly better than a padded one regardless of how much balance is actually available.

## Live proof from this ticket's own run

Two real conversation turns, run live against Monad testnet and Alibaba Cloud's Qwen API while
implementing this ticket (not mocked, not replayed):

- Bot's Frank identity: `lotusR16PSJKa9pYYkfkZVFYeWA6obDmzmXZx8CsRmZZjX9`
- Sender's Frank identity: `lotusR16PSJKNGo5sNqXoVjyaQKHDfdK3U6STRd2AydW9bt`

**Turn 1**

> Sender: "Hi! I'm a script talking to you over Frank on Monad testnet, for the Alibaba Cloud Best
> Builds with Qwen bounty demo. Please tell me: what model are you, who built you, and in one
> sentence why is a burn-to-speak protocol like Frank a good fit for an AI agent's identity?"

- Sender's stamped message burn tx: `0xd7a281fd2ffc0f4c7d10ad7933f6d5b9a45bfefad1e509f5f2ab622c2592877c`

> Qwen (via the bot): "I'm Qwen, a large language model built by Alibaba Group's Tongyi Lab. A
> burn-to-speak protocol like Frank fits AI agents because each message carries a small real cost
> and on-chain provenance, which helps deter spam and ties the agent's output to a verifiable
> identity."

- Bot's reply burn tx: `0xbf6ade241ff8eef009a274d1413532fa98915e4e78cee79b6cebe3b2dccfdd91`

**Turn 2** (a real follow-up, with the bot's Qwen conversation history carrying context from turn 1)

> Sender: "Follow-up: you said Tongyi Lab built you. Roughly how many parameters does qwen3.8-max
> have, and is your burn-to-speak reply itself proof that you paid real gas to talk to me?"

- Sender's stamped message burn tx: `0xb21bd361e0475e4a3d5db1a7d43aacb245c9e1484bf6bb4193a3cc1089cb19ba`

> Qwen (via the bot): "Alibaba hasn't published a reliable public parameter count for
> `qwen3.8-max`, so I shouldn't guess a number. My reply text alone isn't proof of payment; the
> proof is the associated Frank/Monad transaction, burn event, and receipt. If you have the tx
> hash, you can verify the MON burn and delivery on-chain."

- Bot's reply burn tx: `0xced7e73cc1c6415ab432a2e8fc4148adeac27736981c54267ff30c0b909aa7d2`

**Independent on-chain verification** (a separate `eth_getTransactionReceipt` call against
Alchemy's Monad testnet RPC, for all four burns above): every one landed with `status: 0x1`
(success) and `to: 0x000000000000000000000000000000000000dead` (the canonical Stamp burn address)
— real, mined, successful transactions, not simulated.

Note on turn 2's answer: this is Qwen correctly declining to fabricate a parameter count and
correctly reasoning about what "proof of payment" actually means here (the on-chain burn, not the
text) — exactly the kind of grounded, identity-aware response this bounty's track is about.

## Usage (from `packages/bot/`)

**Update (ticket #53, package split):** this used to require hand-listing every transitively
needed file to a raw `tsc` invocation (no `ts-node` in the repo) because the bot lived inside
`app/src/cashweb/wallet/` with no package boundary of its own. It's now `@frank/bot`, a real yarn
workspace package depending on `@frank/wallet`/`@frank/cashweb` -- runs directly via `tsx`, no
manual compile step:

```sh
cd packages/bot
yarn install   # from the repo root, or once via the root workspace
```

Start a local relay exactly as in ticket #8's runbook
(`backend/cashweb/cashweb-registry/examples/README.md`, step 1), then:

```sh
set -a; source ../../.env; set +a   # needs QWEN_API_KEY, QWEN_OPENAI_COMPATIBLE_ENDPOINT too
export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
export QWEN_BOT_MAX_REPLIES=2   # must be >= however many turns the sender script will send
yarn bot
```

By default the bot only replies to messages received after that process began starting. This
prevents a restart from paying for duplicate replies to retained mailbox history while still
including messages that arrive during sender-account funding. Set
`QWEN_BOT_MESSAGE_SINCE_MS=<unix milliseconds>` only when intentionally backfilling older mail.

In a separate shell, once the bot prints its address (or is already running from a prior run —
its identity persists at `QWEN_BOT_IDENTITY_JSON`, default `/tmp/qwen-bot-identity.json`):

```sh
set -a; source ../../.env; set +a
export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
export QWEN_BOT_MESSAGES='["Hi, who are you?","Follow-up: prove you paid to reply."]'
yarn send-demo
```

`yarn ui-verify` (`monad-ui-verify.livecheck.ts`) exercises the same flow through the real app's
own `ActiveChain` seam (`@frank/wallet/chain`) instead of the bot's own hand-rolled calls -- see
that file's own header comment for its specific env vars.

## Auto-greet / auto-fund new signups (ticket #77)

Alongside its Qwen-reply behavior, `qwen-bot.livecheck.ts` also polls the live
`GET /metadata/monad?since=<t>` route (ticket #75, via `fetchMonadProfilesSince`,
`@frank/wallet/monad-identity`) for newly-registered Monad profiles. For each one seen after the
bot's own startup (never itself), it sends a real greeting DM (the same stamped-message path used
for Qwen replies, factored into `qwen-bot-common.ts`'s `sendDirectMessageText`) and funds the new
address with a small amount of real testnet MON, sent directly via `MonadAccountTxSigner.
buildAndSignTransfer` on the main funded wallet -- see `qwen-bot.livecheck.ts`'s own header comment
(point 5) for why that primitive was used instead of `fanOutFundSubAccounts`
(`@frank/wallet/monad-account-pool.ts`), which this ticket's own text originally suggested but
which is actually scoped to funding the bot's _own_ derived sub-account pool, not arbitrary
third-party addresses.

Configuration (env vars, all optional):

- `QWEN_BOT_MAX_GREETINGS` -- max new registrations to greet+fund per run (default `5`). Also
  widens the bot's pre-funded stamp sub-account pool (`poolSize = maxReplies + maxGreetings`),
  since a greeting DM consumes a disposable sub-account exactly like a Qwen reply does.
- `QWEN_BOT_GREETING_MESSAGE` -- the greeting DM's text (default: a short welcome message).
- `QWEN_BOT_FUND_VALUE_WEI` -- wei sent to each newly-greeted address (default `1000000000000000`,
  i.e. 0.001 MON -- a small, symbolic amount, not full burn-cost coverage).

Idempotency: matches this script's own message-reply loop's risk tolerance -- an in-memory
`Set` of already-greeted addresses avoids double-greeting/double-funding within a single run, but
(like `processedPayloadHashes` for messages) isn't persisted across restarts. A restart could in
principle re-greet an address it already greeted in a prior run; there's no persistent dedupe
layer for this manually-run demo script, matching its existing standard.

**Not live-tested in the environment this ticket was implemented in** -- no funded testnet wallet
or live relay was available in that sandbox. Verified via `yarn jest`/`tsc --noEmit`/code review
only; see the ticket's PR description for the exact commands run.

## Bot loop guard (#311)

Bots that answer any inbound message (vendor catalog, raffle round status, Qwen chat) would
otherwise reply to each other forever, each reply paying a stamp. Every bot now registers a
self-declared `bot` profile entry (`registerAndLog`, an ordinary open-ended `Entry` kind: no
proto/backend change) and shares `bot-loop-guard.ts`:

- never greet/fund, chat with, or send catalog/status to another bot: a peer is a bot if its
  profile carries the marker or its address is in `FRANK_BOT_PEER_DENYLIST` (comma-separated;
  for bots registered before the marker existed or third-party bots). A failed profile lookup
  fails closed.
- hard per-peer reply budget per sliding window: `FRANK_BOT_MAX_REPLIES_PER_PEER` (default 20,
  `0` = never reply) per `FRANK_BOT_REPLY_WINDOW_MS` (default 1 hour). Applies to Qwen replies
  and the vendor/raffle unsolicited replies; paid fulfilment and game moves are never dropped.
- Qwen only treats `text` items as prompts; structured items are ignored, never quoted to the model.

Limits: the marker is self-asserted; the budget is in memory (a restart resets it) and per
address (a sybil gets the budget per address, each still paying a stamp). Blackjack only answers
`blackjack-move` items and is unchanged apart from registering the marker.

## Standalone testnet faucet (#316)

`yarn faucet` (`faucet-bot.livecheck.ts`, logic in `faucet-core.ts`) funds each newly registered
profile once with testnet MON. It needs no LLM key, no stamp pool and no identity: only
`MONAD_TESTNET_HTTP_RPC_URL`, `FRANK_NETWORK_TAG=MONT` and `E2E_DEMO_MAIN_WALLET_JSON`
(`{address, privateKey}` of a wallet holding testnet MON only). See the file header for every knob
(`FAUCET_AMOUNT_WEI` default 0.05 MON, hard ceiling 1 MON; `FAUCET_MAX_PER_RUN` 10;
`FAUCET_MAX_PER_DAY` 20 (max 1000); `FAUCET_MIN_RESERVE_WEI` 0.1 MON (minimum 0.01 MON);
`FAUCET_POLL_INTERVAL_MS` 4000 (min 1000); `FAUCET_STATE_DIR` default `~/.frank-faucet`, warns if under a
tmp dir). Invalid values fail startup with the variable name; nothing becomes NaN.

- once per address, durable: the exact signed transaction is persisted before broadcast; any
  record (signed/submitted/confirmed) blocks re-funding, across restarts and address casing. A
  crash mid-broadcast replays the same bytes on restart; it never re-signs.
- skips itself, `FRANK_BOT_PEER_DENYLIST`, self-declared bots (#311) and addresses that already
  hold at least the amount. Stops (without consuming the profile, so it is retried) at the per-run
  cap, the rolling 24h cap, or when the wallet would fall under the reserve.
- testnet only: refuses to start unless `FRANK_NETWORK_TAG=MONT` and the RPC reports chain id 10143.
- Do not also let Qwen fund: set `QWEN_BOT_FUND_VALUE_WEI=0` on the Qwen bot (it still greets).

- one wallet, one faucet: use a wallet dedicated to it. Do not share it with the Qwen bot's funding
  (`QWEN_BOT_FUND_VALUE_WEI=0`) or run a second faucet on a different state dir: concurrent senders
  reuse nonces and one kills the other's transfer. The faucet itself will not sign a new transfer
  while an earlier one is unsettled, and handles profiles one at a time.
- the wallet JSON holds a private key: `chmod 600` it (the faucet warns if group/others can read it).
- a profile that keeps failing (e.g. malformed address) is skipped and recorded after 3
  consecutive failures while the RPC is healthy, so it cannot block everyone behind it; an RPC
  outage never counts against a profile.

Stuck transfers. If the node rejects the exact-bytes replay (`already known`, `nonce too low`) the
faucet looks the receipt up by hash: mined settles the record, otherwise it waits and logs once.
If a record stays stuck (further funding is paused while any transfer is unsettled):

    yarn faucet --list-stuck          # signed / failed / skipped records with tx hashes
    yarn faucet --clear <address>     # DANGEROUS: lets the address be paid again

`--clear` is guarded because the record is the only thing preventing a second payment. It never
clears `submitted`/`confirmed` records; if `MONAD_TESTNET_HTTP_RPC_URL` is set it asks the node and
refuses any tx that is mined or in the mempool (or if the node cannot be asked). A `signed` record
may already have been broadcast (a timeout after the node accepted the tx looks identical), so it
additionally needs `--force --confirm-tx <txHash>` typed exactly, and prints a loud warning. A
`failed` record with a tx hash needs the same when no node lookup is available (a `failed` set
because the node did not know the tx may still land later). These
admin commands run before any other env validation and need only `FAUCET_STATE_DIR`.

A `submitted` transfer whose confirmation was never seen is re-checked by hash (5 min after its
(re)broadcast, at most every 5 min): a receipt settles it; a tx the node no longer knows is marked `failed` so it
shows in `--list-stuck`. It is never re-funded automatically.

Profiles with a malformed address (not `0x` + 40 hex, e.g. `abc`, `foo.eth`) are skipped up front,
without any RPC call, so they never stall the cursor. Skipping a profile after repeated failures ignores transient errors (timeouts, 5xx, rate limits):
malformed-address errors count 3 times; unclassified errors need 10 failures spread over 10 minutes.

Abuse limits (demo level): registration is free, so a sybil can mint addresses and collect the
amount per address until the daily cap (loss bounded to `maxPerDay * amount`, wallet floor kept by
the reserve). No captcha, no proof of humanity, no per-IP limit. The app's Receive page shows the
user's address and explains the faucet when the balance is a real zero.

## Non-goals (per the ticket)

Production hardening, multi-user bot support, prompt/persona design polish, and a full
recipient-addressing fix to the wire format (ticket #37's noted follow-up).
