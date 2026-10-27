# Testing the relay HA cluster locally

How to start the three-relay cluster lab on your machine and test it by hand with the app and the
bots. The design is in [relay-ha-cluster.md](relay-ha-cluster.md); the lab's own reference is
[backend/labs/README.md](../../backend/labs/README.md). Everything here is local and disposable:
nothing touches signet.mx, `~/.frank-bots`, `~/.frank-demo` or a production identity, and every
key it makes is a solonet test key.

## What the cluster is

Three relays (relay-a, relay-b, relay-c) behind one nginx proxy at `http://127.0.0.1:18180`. They
share FoundationDB for their state, NATS for wakeups between replicas, and MinIO (S3) for values
over 64 KiB. Payments are on solonet, a local Monad chain (chain ID 20143, unit MONR) in the
Colima VM `frank-solonet`.

The relays include the CBOR type renumbering, the payment network named on each item, sealed
sender, and paid group writes to the hosting relay.

## Commands

One command brings it all up. It starts solonet if it isn't running (a cold start takes 5 to 8
minutes), builds the cluster, takes a fresh chain checkpoint and prints the commands below:

```sh
scripts/lab-cluster-app.sh up
```

While solonet is running (`yarn --cwd packages/bot regtest:monad-start`), the bare
`docker compose -f backend/labs/compose.cluster.yml up -d --build` also works. It reaches solonet
at `http://host.docker.internal:48080` by default and listens on port 18080. If solonet doesn't
answer, lab-init stops with an error and the relays don't start. The script also uses port 18180,
which avoids the clash with your other process on 18080.

The app, in another terminal from `app/` (once per checkout: `yarn install` and
`yarn --cwd app prepare:packages`):

```sh
QCLI_MONAD_RELAY_BASE_URL=http://127.0.0.1:18180 QCLI_MONAD_RPC_CHAIN=monad-regtest \
  QCLI_MONAD_STAMP_BURN_ADDRESS=0x000000000000000000000000000000000000dEaD yarn dev:browser
```

Open `http://localhost:8080`. When you create each account, open **Advanced options** and set the
relay server to `http://127.0.0.1:18180`. Without it, group writes fail with "Group write policy
names host http://127.0.0.1:18180, not http://localhost:8080". Direct messages work either way.
For a second account, use another browser profile or the other origin (`http://127.0.0.1:8080`).

Other commands:

| Command | What it does |
| --- | --- |
| `scripts/lab-cluster-app.sh fund 0x… 20` | The solonet faucet pays 20 MON to an app account (Wallet → Receive). Fund more than 10 MON: Monad keeps a 10 MON reserve per account. |
| `scripts/lab-cluster-app.sh bots` | Runs every bot (Qwen in stub mode) against the cluster; the faucet grants 1 MONR per account (use `fund` for more), with their own funding key and state in `~/.frank-lab-cluster/frank-lab-app`. |
| `scripts/lab-cluster-app.sh refresh-checkpoint` | Takes a fresh starting checkpoint and restarts the relays. Needed only after restarting solonet, or before restarting a relay more than about an hour after `up`. |
| `scripts/lab-cluster-app.sh sweep` | Returns the bot funding wallet's balance to the faucet. Stop the bots first. |
| `scripts/lab-cluster-app.sh down` | Stops the cluster and keeps its volumes. |

Automated checks:

```sh
# The HTTP cluster contract (groups, registry, directory, large values, failover)
COMPOSE_PROJECT_NAME=frank-lab-app FRANK_LAB_CLUSTER_PORT=18180 FRANK_LAB_CLUSTER_SUBNET=10.89.180 \
  FRANK_LAB_SOLONET_RPC_URL=http://host.docker.internal:48080 \
  docker compose -f backend/labs/compose.cluster.yml --profile cluster-contract run --build --rm cluster-contract

# Paid DMs across replicas with the real TypeScript wallet
FRANK_DM_LAB_BURST=60 yarn --cwd packages/bot regtest:monad-dm-cluster
```

## Machine notes

- Port 18080 is used by another process on this machine, so the script uses 18180.
- solonet keeps only about 6,950 blocks (about 75 minutes). Each running relay re-attests its
  checkpoint every 10 minutes along the same chain (`operator_checkpoint_refresh_secs` in
  `backend/labs/cluster/relay.toml.in`), so a long session keeps working without restarts. A
  relay *restarted* more than about an hour after `up` starts from the block `lab-init` wrote,
  which is pruned by then, and refuses the chain ("did not answer the identity probe"): run
  `refresh-checkpoint`. The relay log names each re-attestation ("Operator checkpoint
  re-attested") and each refusal.
- Under heavy load, Colima's port forward for solonet's RPC (48080) can drop. Check
  `yarn --cwd packages/bot regtest:monad-status` before running the checks.
- The `minio/minio` image can no longer be pulled, so the lab builds MinIO from source. The first
  build takes about 14 minutes.

## Test accounts and funding (solonet only)

Make fresh accounts in the app and fund each with `scripts/lab-cluster-app.sh fund <receive
address> 20`; the faucet bot also grants 1 MONR to each new account. The accounts used in the
2026-10-25 and 2026-10-26 browser rounds (Alice, Bob and the QA personas) were all swept back to 0.
The bot funding wallet is `0xe4fe02Bf7A379fab94AD3654482d905052484149`.

When you're done, use Send max to return each app account's balance to the faucet,
`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`. Repeat while change comes back, until only dust below
the payment floor (about 0.0214 MONR) remains. Then stop the bots and run
`scripts/lab-cluster-app.sh sweep`. The DM livecheck returns its own wallets' funds at the end of
every run, including a failed one.

The smallest payment or stamp is ten times the gas to move it: about 0.0214 MONR at solonet's gas
price. The app refuses anything smaller before signing and names the minimum.

## What was verified

Final run, 2026-10-26, on main `bab076ccb`. The later commits up to `4301de2bf` change only app
display and the wallet's fee summary.

- **Cluster contract:** 16 of 16 passed.
- **DM livecheck** (`FRANK_DM_LAB_BURST=300`):
  - A paid DM admitted on relay A was pushed over a websocket held on relay B.
  - 300 concurrent DMs to one recipient, through A, B and C, got strictly increasing times.
  - One request sent to A and B at once was stored once, with one mined payment.
  - A challenge issued on A and replayed was refused.
  - Killing A mid-admission, both before it answered and after it committed, left one row and one
    payment.
  - With NATS down, the reader caught up from its cursor.
  - A 400 kB message read back unchanged. Its note to self now reaches the sender's other devices
    (#1860 fixed).
  - All 7 wallets' funds went back to the faucet.
- **In a real browser (Chrome),** in several QA rounds with fresh accounts:
  - **Messages:** sealed paid DMs both ways; groups (create, accept, post, remove a member); the
    Screener.
  - **Payments:**
    - Send to Contact and chat stealth payments cost exactly what their review showed, on the first
      attempt.
    - An over-fee send is refused before signing and offers the new fee.
    - Payments below the floor are refused with the minimum named.
  - **Two devices of one account:**
    - History is one row per send on both, with the same amounts, stamp and fee.
    - Both devices sending at the same moment pay each message once.
    - A 100 KB message reaches the second device.
  - **Games:** dice, blackjack and raffle at the minimum stake, with wins verified on chain.
- **All relays down:** with relays a, b and c stopped:
  - nothing was signed or broadcast;
  - the app said the server couldn't be reached;
  - queued DMs were delivered once, with one stamp each, within about 15 s of restart;
  - with only relay-c up, DMs worked both ways.
- **Bots** answered after the outage. Dice answers "help" within a second.
- **Clean checkout, 2026-10-26:** a fresh clone of main `c9176c730`,
  `docker compose -f backend/labs/compose.cluster.yml up -d --build` (with
  `FRANK_LAB_CLUSTER_PORT`, since 18080 was taken), came up all healthy, and the cluster contract
  passed 16 of 16 on it.
- **Direct messages over 64 KiB in S3** (#1924, verified on its branch, identical to main
  `71d44dbe1`):
  - cluster contract 16 of 16;
  - DM livecheck OK: A admitted the largest message a client seals (a 401,813-byte request), B
    and C each read back the exact delivery frame through an authenticated mailbox scan, and the
    object under `lab/messages/sha256/<sha256 of the request>/` in MinIO hashes to that request;
    all funds went back to the faucet.
  - **An 8 MiB DM could not round-trip** on #1924: the codec admitted one crypto-box envelope
    of at most 524,376 bytes per DM. The owner raised the limit (question 14); see the next
    bullet.
- **Direct messages up to 8 MiB** (branch `fix/dm-8mib`): a DM holds up to 8 MiB of
  ciphertext (an envelope of at most 8,388,696 bytes), a DM frame up to 10 MiB, and a request up
  to 12 MiB. Cluster contract 16 of 16; DM livecheck OK (burst 300): A admitted a paid message whose envelope is exactly
  the maximum (an 8,390,526-byte request), B and C each read it back unchanged, and its object
  is under `lab/messages/sha256/<sha256 of the request>/` in MinIO; a request of 12,582,913
  bytes got 413 with nothing stored; the same message sealed was refused before anything was
  sent, because its note to self would not fit; all funds went back to the faucet. On that
  branch a sealed message was still capped at about 512 KiB by its note to self; see the next
  bullet.
- **A sealed message up to the DM limit** (branch `fix/note-to-self-dm-size`): a note to self
  (`outbox-message`) holds what a direct message carries, not the 512 KiB of other plugin
  items, so a sealed message is no longer capped at about 512 KiB. Its note holds the message
  and its own fields, so the original and the note must both fit: the largest sealed message is
  a few hundred bytes smaller than the largest that names its sender (in the wallet test, 33
  text items: 8,387,320 bytes of text named, 8,386,997 sealed free, 8,386,916 sealed paid,
  whose note counts the stamp at its widest before paying). One byte more is refused before
  anything is paid. Cluster contract 16 of 16; DM livecheck OK (burst 300): the largest sealed paid
  message (8,386,916 bytes of text, envelope 8,388,443 bytes) was delivered to bob, its note to
  self (envelope 8,388,634 bytes, limit 8,388,696) reached alice's mailbox and read back as the
  sent message, one byte more was refused before anything was sent; all funds went back to the
  faucet.
- **Long text in the app composer** (branch `fix/composer-long-text`, on main `b8a0fe8db`): a
  text longer than one text item holds (256 KiB) is sent as consecutive text items, cut on UTF-8
  boundaries, and every reader (bubble, chat list, notification, copy, forward, search, email
  thread, mail gateway) shows them as one text. The composer holds a message to what a sealed
  message carries (`MAX_SEALED_MESSAGE_CONTENT_BYTES`, 8 MiB of ciphertext less 16 KiB for the
  message's and its note's fields: 8,372,224 bytes) and refuses a larger one before Send, naming
  the limit. A send the wallet refuses before paying because it cannot be encoded says so in the
  bubble (too large, or an item that cannot be sent) and offers Discard, not Retry. In Chrome
  against this lab (dev server on :8094, two fresh accounts, Alice funded 20 MONR): sealed paid
  DMs of 1,000,692 bytes (4 text items), 4,000,712 bytes (16) and 8,360,000 bytes (32) reached
  Bob with the same SHA-256 as sent, each shown as one bubble with one text; a 9 MiB text was
  refused before Send with "one message holds at most 8.0 MB, and this one is 9.0 MB" and
  nothing was sent. Both accounts were swept to the faucet (app and chain balances 0). The
  sender's other device is covered by the wallet test (self-wallet-sync.jest.test.ts: a 1 MB
  split text and a message at exactly the composer bound read back on the other device), not in
  the browser.
- **Long bot replies, and tied-up funds found later** (branch
  `fix/bot-long-replies-pending-tied-up`):
  - The bot host sends a long text as consecutive text items, with the app's splitter. That
    covers stored replies, a handler's own replies and anything else a bot sends. A stored reply
    may be as large as a sealed message carries. A reply larger than that is refused before the
    wallet is asked, and the log says why. The peer gets the failure reply once; the long reply
    is never sent again. The host gives up, at once and with the reason, on a reply the wallet
    refuses as too large or unencodable.
  - Owner question 15 now also covers sends found later. The wallet's background pass may find
    an older pending intent, for example after a restart, whose money is still in its earlier
    sends. It ends that intent `funds_tied_up` and records the amount, and no later pass sends
    it. The app shows the reason and the amount. A Retry takes the ended attempt off the message
    and sends again under the same message ID. A message carrying a payment of its own keeps its
    attempt.
  - The bot host gives up on a stored reply the wallet refuses this way, or one the wallet's
    pass already ended, and logs the amount. It does not resend it on later polls; the peer's
    next message is answered as usual. A handler's own reply refused this way is rejected to the
    handler at once.
  - Evidence: wallet, bot-framework and app tests. The restart case runs in
    `evm-parallel-send.jest.test.ts`: ended with the amount, not sent by six later passes, sent
    once on Retry, a second Retry the same attempt. A ~1 MB bot reply arrives as items that join
    to the one text. Not yet checked: a bot's long reply through a real relay.

## Shared across replicas, and replica-local

Shared through FoundationDB (and MinIO for large values): groups, direct messages, the registry
database (profiles, usernames), the directory, the forum (posts, votes, burn records, cursors),
and values over 64 KiB, including direct-message requests over 64 KiB (objects under
`lab/messages/` in the `frank-lab-blobs` bucket).

Still replica-local; each relay's startup log names them:

- **The hourly RPC proxy quotas and the directory enrollment quotas:** each replica counts its own
  (HA step 10).

## Not working, and known bugs

- **Relay-to-relay forwarding doesn't exist.** A message to someone whose home is a *different*
  relay is answered `undeliverable`. The three replicas are one relay, so this doesn't affect the
  cluster. Two independent relays can't exchange messages, and no test connects bots on two
  different relays. Only the envelope format has landed. See
  [Messages to a recipient on another relay are refused: forwarding is not wired (#1348)](https://github.com/schancel/frank/issues/1348).
  It needs the owner decisions in [#89](https://github.com/schancel/frank/issues/89).
- [A second device's 'existing' answer makes it broadcast its own group-write payment (#1862)](https://github.com/schancel/frank/issues/1862).
- [The app's websocket advances its cursor before storing the record (#1854)](https://github.com/schancel/frank/issues/1854).
- **Fixed: a contact payment no longer leaves before the relay stores its message.**
  [A message's carried payments reach the chain only after the relay stores it (#1894)](https://github.com/schancel/frank/pull/1894)
  holds every carried payment (recipient payments, stamps, a contact transfer) until the relay
  has stored the message, and only the set's own moves (change, the stamp's funding) go before.
  A one-coin wallet under Monad's reserve rule is no longer refused: it uses the two-nonce
  ordering of owner question 8.
- **Fixed: `packages/wallet/chain/received-payments.anvil.integration.ts` passes and runs in CI**
  (job `wallet-received-payments`, added by #1894). It covers a one-coin wallet under the
  reserve rule on anvil: the stamp's funding lands at the account's lowest nonce before the
  relay has the message, and the contact transfer lands at the next nonce after it is stored.
- **Fixed: a send right after a send with 10 MON or more of change is no longer refused first.**
  The node judges a transaction against the sender's balance of four blocks back, whatever the
  amount, but change of 10 MON or more was listed as spendable at once; the next send out of it
  was refused ("Signer had insufficient balance") and recovered only by
  [signing it again (#1939)](https://github.com/schancel/frank/pull/1939). Every change coin, and
  every coin a set funds for its own later move, is now spendable from four blocks after the
  block that brought it, the same window the coin-list sync gives a deposit
  (`packages/wallet/chain/evm-spend-rule.ts`). `yarn --cwd packages/bot regtest:monad-fresh-change`
  checks it on solonet.
- **Format break:** notes to self written before #1916 read as unsupported. Start the
  deployment's wallets and bots from fresh stores.
- **App:** unless the relay server is set by hand, the dev server's origin becomes a group's home
  relay. This also affects `yarn demo`.
- **App:** the chat stealth payment dialog shows no fee or total before sending, and names the
  minimum only after a refusal.
- **App:** right after Send max, a spent received payment can count in the balance for about a
  minute.
- **App:** after a reload, a stale "Unsupported message" preview can show for an old group invite.
- **App:** `/metadata` returns 404 in the browser.
- **Tests:** in a full parallel run, `wallet-performance-simulation`, `webpush-sync` and a few
  app suites sometimes time out; each passes alone.

## Owner questions

1. **Group-write price.** The lab and dev use 1e12 wei. Resolved (2026-10-27): "Should be set by
   the creator and adjustable? Also visible to users so they can avoid sending money that will
   fail." The creator signs the group's price with the group root key at creation and an
   administrator can change it; the hosting relay's `min_price_wei` is the floor (1e12 wei in
   the lab and dev), and the app shows the price in the composer and in group info.
2. **xpub derivation for the group-write payee.** Proposed in #1847: pay child `xpub/0/i`, with
   `i = u32_be(commitment[0..4]) & 0x7fffffff`. Resolved (2026-10-27): "Probably better to send
   it to the relay." Writes pay the hosting relay's own address; the xpub payee and the
   `xpub/0/i` rule are removed with no compatibility path.
3. **The Docker image's group-write payee.** It is the placeholder `burn`. Resolved (2026-10-27):
   "just use 0xdead". The Docker, cluster-lab and dev configs name
   `0x000000000000000000000000000000000000dEaD` as the relay's address; `burn` is no longer a
   payee kind.
4. **Sealed sender timing.** The note to self is sent unsealed right after the sealed original, so
   the relay can link the two by timing. Resolved (2026-10-27): "People are expected to use
   trusted relays." The timing link is accepted; the note to self is neither delayed nor batched.
5. **Group payment exposure.** Withdrawn (2026-10-27): not an owner decision. The relay keeps
   its rule: at most one write per (payer, nonce), at most 64 outstanding (nonce window 63).
6. **Deferred group writes.** Resolved (owner ruling 2026-10-27): a write the host defers (`503
   group_payment_*`: nonce gap, balance not seen, node unreadable) shows "Waiting for funds or the
   chain…", not "unreachable", and keeps retrying the same bytes. Discard gives the coin back only
   after the wallet reads the chain and finds the payment neither pending nor mined, and only if no
   attempt went unanswered; otherwise it keeps the write and its reservation and says why.
7. **Relay-to-relay forwarding (#1348).** Withdrawn (2026-10-27): "this isn't a question". It is
   listed under "Not working, and known bugs".
8. **One-coin wallet and its stamp.** Resolved (2026-10-26): "For a UTXO based coin, there's no
   problem. For the account based coin we should be able to just use two different nonces, no?"
   On an EVM account with one coin, the stamp's funding goes out at the lower nonce, before the
   relay has the message, and the carried contact transfer at a higher nonce, after the relay
   stores it. No self-payment round trip, no consolidation.
   - Implemented in [A message's carried payments reach the chain only after the relay stores it (#1894)](https://github.com/schancel/frank/pull/1894).
     When a set keeps back funds for its message's stamp, the preparer signs the stamp's
     funding at the account's lowest nonce and the carried transfer at the next nonce, with
     nothing of the set between them. A transfer that leaves the account below the reserve
     waits out the 3-block quiet window after the funding; the relay gets the message only 4
     blocks after the funding lands, so the window has passed before anyone can broadcast the
     transfer. The set's other change goes after the transfer, as before.
9. **Send to Address below the floor** to an external address. Resolved: refuse (2026-10-26).
   The wallet refuses the transfer, and Send max when everything it can send is below the floor,
   before anything is signed, and the page names the minimum, as Send to Contact does.
10. **External deposits in History.** Resolved (2026-10-27): "Why can't the frontend just check
    the fucking indexer?" … "EVM plain nodes ARE AND INDEXER."
    The wallet reads the chain's own JSON-RPC node through the relay's chain-rpc proxy; there is
    no indexer service and no relay-side index. Implemented in
    `packages/wallet/evm-deposit-scan.ts`: for the receive and identity accounts and opened dApp
    personas, the wallet keeps a cursor (a block and what the address held there), finds the
    first block where that changed by bisecting historical `eth_getBalance` /
    `eth_getTransactionCount` / `balanceOf` reads, and reads only that block: its transaction
    hashes (`eth_getBlockByNumber` without transactions, since the proxy refuses full blocks), the
    transactions, and `eth_getLogs` for a supported ERC20's `Transfer` in that one block. A first
    scan starts at the head for an address that never held anything, else at the oldest block the
    node still serves state for (at most 1,000,000 blocks back). Not found: value moved by a
    contract (internal transfers), and blocks the node pruned before the wallet reached them (the
    cursor records them). The `fund` script's deposit shows in History as "Received from 0x…".
11. **Cross-device rebuild (#1907) gaps.** Withdrawn (2026-10-27): "Not specific enough to
    answer." These are bugs, not decisions, and are worked on in
    [A coin another device spends at the same moment no longer leaves a message stuck or money tied up (#1945)](https://github.com/schancel/frank/pull/1945):
    a nonce taken by a transaction with a different value, a partial collision, combined
    operations, and a message the relay already stored.
12. **Operator blackjack minimum on the wire.** Resolved (2026-10-27): the dealer's offer
    carries its minimum and maximum bet. "No point in betting when you won't be paid out."
    Implemented in
    [The blackjack dealer's offer names its smallest and largest bet; the app shows them and refuses a bet outside them before paying (#1947)](https://github.com/schancel/frank/pull/1947).
    The field is optional: the either-role bot (`packages/bot/blackjack-p2p-bot.ts`) still offers
    without a minimum. An app older than #1947 rejects an offer carrying it, so the bots and the
    app deploy together.
13. **Background coin consolidation.** Resolved: approved 2026-10-26 (a 20 MONR Send max had
    been split into 56 transfers costing 0.12 in fees); 2026-10-27: "It needs to be such that it
    doesn't sweep shit we just created as change... Like that would be silly if it's not designed
    with the same thresholds in mind." Built in `packages/wallet/evm-coin-distribution.ts` (one
    policy read by both the change splitter and the merge) and `evm-coin-consolidator.ts`:
    - A pool coin is a stealth, stamp, change or HD sub-account coin worth at least the payment
      floor (10 transfer fees). The main and identity accounts are not counted or merged.
    - The band's top is 8 pool coins (twice the 4 change outputs one payment may make). A
      payment makes only as many change coins as fit under it; with no room its residual stays
      on its source at the next nonce. Sends alone never start a merge.
    - Above 8, an idle tick (app and bot host, nothing being sent or reconciled) merges the
      smallest coins into one fresh change account until 5 are left (4 + the merged one), at most
      64 per merge. It never takes the newest 4 coins, a coin listed fewer than 3 blocks ago, a
      coin an operation holds, or a coin Monad's spend rule keeps; a coin worth less than its
      move is skipped.
    - A merge is an ordinary transaction set: journalled before broadcast, resumed with the same
      bytes after a restart, noted to the account's other devices like any send, and shown in
      History as one row, "Merged N coins", with its fee. Other sends pick other coins meanwhile;
      nothing waits for it.
    - The merge's account is derived, not allocated (AGENTS.md §5): a keyed hash of the merge's
      lowest [account, nonce] input and the chain, under a salt from the account's own keys,
      picks an index in the upper half of the change branch, which the change allocator (counting
      up from 0) never reaches. Two devices that see the same pool sign the same transactions to
      the same account. A device that knows an emptied account (from its coin list or its seed
      walk) reads the target of that account's last nonce, so a restored device finds the merged
      money; `funds:sweep` reads it from the coin list.
    - Checked on solonet by `yarn --cwd packages/bot regtest:monad-consolidation` (30 coins are
      merged down to 5, a paid message sent during the merge is delivered, funds go back to the
      faucet). Not in CI.
14. **DM size versus the 8 MiB acceptance line.** Resolved: the owner chose to raise the limit
    (2026-10-26). A DM holds up to 8 MiB of ciphertext and a relay reads requests up to 12 MiB.
    A sealed message's note to self now holds what a DM carries (owner, 2026-10-26: a note to
    self must not cap the message it copies), so a sealed message can be about as large as one
    that names its sender: a few hundred bytes smaller, because the note holds the message and
    its own fields and both must fit.
15. **A second send while the last one's change hasn't gone out.** Resolved (2026-10-26): fail
    with a clear reason. On Monad the change behind a message's payments goes out only after the
    relay stored that message, on later ticks. A small wallet's next paid send in that window
    finds no free coin. The wallet now refuses it at once with `FundsInPendingSendError`, naming
    the amount still in its own unfinished sets (read from the transaction-set journal). Nothing
    is signed, reserved or kept to send later. The app says "Your last payment's change hasn't
    gone out yet (X MON). Try again in a moment." (DM bubble, email, Send to Contact, chat
    payment, Send to Address). The message stays failed until the user clicks Retry, which sends
    it again under the same message ID. This also applies to an older pending send that the
    wallet's background pass finds, for example after a restart. That send ends with the reason
    and the amount, and only a Retry sends it again. The bot host does not resend such a reply on
    later polls. Not chosen: queueing the send, or putting change before
    payments. The DM cluster check ticks its wallets between paid steps, as the app and the bot
    host do. That made step 5 flaky before. The one-coin check sends back-to-back on purpose and
    expects this refusal.

## Before deploying this main

These are not done. The owner decides the redeploy.

- **Deploy everything from one main commit:** relay, app, extensions and bots together.
  - This main changes client formats: dice field 14, `wallet-sync.operation`, and the
    note-to-self frames.
  - An older client refuses the new fields.
- **Fresh stores:**
  - Start the bot and gateway wallet stores fresh. Wallet database names now include the network
    (`FRANK_WALLET_STORAGE_LOCATION`).
  - Reset the forum stores to the v2 marker.
- **Relay message store:** the DM row format moved to v3 (#1924). A single-node relay with an
  old `<db>.messages-v3` store refuses to start until it, and `<db>.large-values/messages`, are
  moved aside, which drops its stored DMs. The FDB subspace is now `messages-v4/`.
- **Configuration:** set the stamp floor and the payment floor multiple (10, from
  `docs/protocol/chains/v1.json`) in the relay and bot configs.
- **Never reset the bot custody or create replacement bot identities.**

## Merged for this lab (2026-10-25)

- [Transaction contract for the relay store (#1848)](https://github.com/schancel/frank/pull/1848)
- [Per-item payment network (#1539)](https://github.com/schancel/frank/pull/1539)
- [Cluster composition behind a preview flag (#1849)](https://github.com/schancel/frank/pull/1849)
- [Three-relay cluster lab with FDB, NATS, MinIO and an HTTP contract (#1850)](https://github.com/schancel/frank/pull/1850)
- [Sealed sender: sender pubkey folded into the ciphertext (#1577)](https://github.com/schancel/frank/pull/1577)
- [Large-value store (S3) for group ciphertext over 64 KiB (#1851)](https://github.com/schancel/frank/pull/1851)
- [rustfmt the last unformatted test files (#1856)](https://github.com/schancel/frank/pull/1856)
- [FDB network watcher on a plain thread, retryable group storage errors (#1855)](https://github.com/schancel/frank/pull/1855)
- [Registry database on the transaction port (#1857)](https://github.com/schancel/frank/pull/1857)
- [Dev server forwards /groups, /usernames and /topics (#1859)](https://github.com/schancel/frank/pull/1859)
- [Direct messages on the shared transaction store (#1852)](https://github.com/schancel/frank/pull/1852)
- [solonet check never removes a running chain (#1861)](https://github.com/schancel/frank/pull/1861)
- [Directory on one shared transaction store (#1858)](https://github.com/schancel/frank/pull/1858)
- [Regtest checkpoints a recent solonet block (#1864)](https://github.com/schancel/frank/pull/1864)
- [Wallet waits for a fresh deposit to be spendable (#1863)](https://github.com/schancel/frank/pull/1863)
- [Paid group writes verified by the hosting relay (#1847)](https://github.com/schancel/frank/pull/1847)
- [App, bots, DMs and the directory through the three-relay cluster (#1865)](https://github.com/schancel/frank/pull/1865)

## Merged in the QA hardening rounds (2026-10-25 to 2026-10-26)

- [Key the evidence cache with toHex, not Node's Buffer (#1867)](https://github.com/schancel/frank/pull/1867)
- [Backend and app workflows can be run by hand (#1868)](https://github.com/schancel/frank/pull/1868)
- [An unanswered profile lookup no longer blocks opening the account (#1869)](https://github.com/schancel/frank/pull/1869)
- [Run every bot and grant 1 MONR from the faucet (#1870)](https://github.com/schancel/frank/pull/1870)
- [Mobile chat header and wallet dApp cards; group bubbles show no XPI amount (#1871)](https://github.com/schancel/frank/pull/1871)
- [Stealth send: retry throttled reads, honest failure messages, usable on a phone (#1872)](https://github.com/schancel/frank/pull/1872)
- [A payment carries exactly its amount; residual stays with the sender (#1873)](https://github.com/schancel/frank/pull/1873)
- [Wallet page history, top-up, explorer links and units (#1874)](https://github.com/schancel/frank/pull/1874)
- [Open monad-regtest wallets with the relay's operator checkpoint (#1875)](https://github.com/schancel/frank/pull/1875)
- [Game moves pay only what the game says; bot money, payouts and chat layout (#1876)](https://github.com/schancel/frank/pull/1876)
- [Contacts, onboarding, identity and mobile QA fixes (#1877)](https://github.com/schancel/frank/pull/1877)
- [A contact payment reaches paid after its transaction set is retired (#1878)](https://github.com/schancel/frank/pull/1878)
- [A restored device finds every account its seed controls (#1879)](https://github.com/schancel/frank/pull/1879)
- [The forum on the shared transaction store (HA step 9) (#1880)](https://github.com/schancel/frank/pull/1880)
- [Count received stealth payments in the recipient's coin list (#1881)](https://github.com/schancel/frank/pull/1881)
- [Devices of one account agree on contacts, profile, invites and threads (#1882)](https://github.com/schancel/frank/pull/1882)
- [A sent stealth payment shows what the chain did with it (#1883)](https://github.com/schancel/frank/pull/1883)
- [Send to an address spends the whole coin list, and every quote is the fee paid (#1884)](https://github.com/schancel/frank/pull/1884)
- [A saved account that fails to open lands on Setup, not the signup page (#1885)](https://github.com/schancel/frank/pull/1885)
- [Votes and posts pay like stamps, with a set of burns, and never hang (#1886)](https://github.com/schancel/frank/pull/1886)
- [A running relay keeps its regtest checkpoint inside the node's history (#1887)](https://github.com/schancel/frank/pull/1887)
- [One spending path — swap funding and received-coin sweeps go through the coin list (#1888)](https://github.com/schancel/frank/pull/1888)
- [Cluster-contract solonet funding survives a busy shared node (#1889)](https://github.com/schancel/frank/pull/1889)
- [Unverified coins, missing observations, the seed walk and send latency; run the budgets in CI (#1890)](https://github.com/schancel/frank/pull/1890)
- [Wallet state names its canonical network once; a hidden, user-run Reconcile wallet replaces the automatic mailbox rescan (#1891)](https://github.com/schancel/frank/pull/1891)
- [Count posts and votes once the node accepts every burn (#1892)](https://github.com/schancel/frank/pull/1892)
- [A steady paid DM send does about half the work (#1893)](https://github.com/schancel/frank/pull/1893)
- [Every stamp and payment is at least ten times the gas to move it (#1895)](https://github.com/schancel/frank/pull/1895)
- [Regenerate the WASM package for the current chain registry (#1896)](https://github.com/schancel/frank/pull/1896)
- [A Send whose payment the node forgot finishes; Send max never counts a coin the chain has passed (#1897)](https://github.com/schancel/frank/pull/1897)
- [Fix two web app errors seen in the HA lab: persona scan batch too large, New Group relay list (#1898)](https://github.com/schancel/frank/pull/1898)
- [Approve & Add Contact in the Screener adds the sender to contacts (#1899)](https://github.com/schancel/frank/pull/1899)
- [A game card never offers a stake below the payment floor; a refused low payment names the minimum (#1900)](https://github.com/schancel/frank/pull/1900)
- [A Send's change comes back seconds apart, not one transfer a minute (#1901)](https://github.com/schancel/frank/pull/1901)
- [A Retry never changes the amount of a bet, a purchase or a stamp the sender set (#1902)](https://github.com/schancel/frank/pull/1902)
- [The Monad livechecks stamp at the payment floor, not one transfer's gas (#1903)](https://github.com/schancel/frank/pull/1903)
- [A landed transfer reads Sent with its block, never "replaced"; other devices check a sent payment; History reads blocks the relay serves (#1904)](https://github.com/schancel/frank/pull/1904)
- [Games: raffle rounds stay enterable, app and dealer agree on the smallest bet, refused stakes name the minimum, payouts verify on chain (#1905)](https://github.com/schancel/frank/pull/1905)
- [A contact payment below the payment floor is refused; Send to Contact names the minimum and shows the stamp; a too-small coin is never called spendable (#1906)](https://github.com/schancel/frank/pull/1906)
- [A message whose coin another device spent at the same moment is paid from other coins and delivered (#1907)](https://github.com/schancel/frank/pull/1907)
- [History shows the account's sends on every device (#1908)](https://github.com/schancel/frank/pull/1908)
- [A dismissed peer thread comes back on Start Conversation; a removed group member is told (#1909)](https://github.com/schancel/frank/pull/1909)
- [A stealth payment and its stamp stay within the fee the user approved; an unsigned message gives its coins back (#1910)](https://github.com/schancel/frank/pull/1910)
- [A re-read of an account no longer hides its coin from a payment selecting meanwhile (#1911)](https://github.com/schancel/frank/pull/1911)
- [A received payment once verified stays received when the node no longer serves its transactions (#1912)](https://github.com/schancel/frank/pull/1912)
- [Send to Contact pays no more network fee than its review showed, the stamp included (#1913)](https://github.com/schancel/frank/pull/1913)
- [A chat stealth payment below the payment floor is refused, and no part of a split one is below it (#1914)](https://github.com/schancel/frank/pull/1914)
- [One send is one row with the same label and fee on every device (#1915)](https://github.com/schancel/frank/pull/1915)
- [A sealed message with items over 64 KiB reaches the account's other devices (#1916)](https://github.com/schancel/frank/pull/1916)
- [History shows a payment and its message's stamp as one row on every device (#1917)](https://github.com/schancel/frank/pull/1917)
- [Send to Contact quotes and builds its stamp the same way, refuses over the fee before signing, and gives back a payment nothing of which left the wallet (#1918)](https://github.com/schancel/frank/pull/1918)
- [The DM cluster livecheck returns its wallets' funds to the faucet, also after a failure (#1919)](https://github.com/schancel/frank/pull/1919)
- [A bot passes its own notes to self quietly, and logs a refused inbound message once (#1920)](https://github.com/schancel/frank/pull/1920)
- [Chat stealth payments with a stamp quote what they build and refuse an over-bound stamp before signing; a message ended over the fee says so (#1921)](https://github.com/schancel/frank/pull/1921)
- [Send to Contact says when the fee rose and shows the new one; contact payment cards show the fee breakdown; a card's network fee is the one History shows (#1922)](https://github.com/schancel/frank/pull/1922)
- [Direct-message requests over 64 KiB are stored in S3 like group messages (#1924)](https://github.com/schancel/frank/pull/1924)
