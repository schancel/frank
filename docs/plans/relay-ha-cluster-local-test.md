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

These accounts were used for the browser test on 2026-10-25 and are left funded for testing by
hand. Their browser profiles are on this machine.

| Account | Profile address | Receive address |
| --- | --- | --- |
| Alice | `0xB754191B32b15Eb667D4d3F24De8EabA368d472C` | `0xe1F404D87Ea86E2cf6b13165B4b064f9d37d49E7` |
| Bob ("Bob Lab") | `0xbAbBD90B089a96CAE453900D07623E7673a680d8` | `0x239243E946F77F69610eeD586B50ad0cdAf5Ae62` |
| Bot funding wallet | `0xe4fe02Bf7A379fab94AD3654482d905052484149` (about 197 MON) | |

Each app account got 20 MON from the faucet. When you're done, send each app account's balance to
the faucet, `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, from the app, and run
`scripts/lab-cluster-app.sh sweep` for the bots.

## What was verified

- **Cluster contract:** 13 of 13 passed.
- **DM livecheck:**
  - A paid DM admitted on relay A was pushed over a websocket held on relay B.
  - 60 concurrent DMs got strictly increasing times.
  - One request sent to A and B at once was stored once.
  - A challenge issued on A and replayed was refused.
  - Killing A mid-admission, both before it answered and after it committed, left one row and one
    payment.
  - With NATS down, the reader caught up from its cursor.
  - A 400 kB message read back unchanged.
- **In a real browser (Chrome):**
  - Alice and Bob exchanged sealed, paid DMs both ways at a 0.01 MONR stamp, and Bob's balance
    went up by 0.01.
  - Alice created a group, Bob accepted, and each saw the other's posts.
- **Bots:** they sent welcome DMs, and Qwen answered within 4 seconds.

## Shared across replicas, and replica-local

Shared through FoundationDB (and MinIO for large values): groups, direct messages, the registry
database (profiles, usernames), the directory, the forum (posts, votes, burn records, cursors),
and values over 64 KiB.

Still replica-local; each relay's startup log names them:

- **The hourly RPC proxy quotas and the directory enrollment quotas:** each replica counts its own
  (HA step 10).

Not stored in S3: direct messages over 100 kB are split across FoundationDB values instead.

## Not working, and known bugs

- **Relay-to-relay forwarding doesn't exist.** A message to someone whose home is a *different*
  relay is answered `undeliverable`. The three replicas are one relay, so this doesn't affect the
  cluster. Two independent relays can't exchange messages, and no test connects bots on two
  different relays. Only the envelope format has landed. See
  [Messages to a recipient on another relay are refused: forwarding is not wired (#1348)](https://github.com/schancel/frank/issues/1348).
  It needs the owner decisions in [#89](https://github.com/schancel/frank/issues/89).
- [A sealed send with an item over 64 KiB never delivers its note to self (#1860)](https://github.com/schancel/frank/issues/1860).
  Avoid attachments over 64 KiB in sealed DMs while testing.
- [A second device's 'existing' answer makes it broadcast its own group-write payment (#1862)](https://github.com/schancel/frank/issues/1862).
- [The wallet sometimes pays a DM stamp about 10x the stamp price (#1853)](https://github.com/schancel/frank/issues/1853).
- [The app's websocket advances its cursor before storing the record (#1854)](https://github.com/schancel/frank/issues/1854).
- **App:** unless the relay server is set by hand, the dev server's origin becomes a group's home
  relay. This also affects `yarn demo`.
- **App:** group messages show "0.00 XPI".
- **App:** after a reload, a stale "Unsupported message" preview can show for an old group invite.
- **App:** `/metadata` returns 404 in the browser.

## Owner questions

1. **Group-write price.** The lab and dev use 1e12 wei.
2. **xpub derivation for the group-write payee.** Proposed in #1847: pay child `xpub/0/i`, with
   `i = u32_be(commitment[0..4]) & 0x7fffffff`.
3. **The Docker image's group-write payee.** It is the placeholder `burn`.
4. **Sealed sender timing.** The note to self is sent unsealed right after the sealed original, so
   the relay can link the two by timing. Delay or batch it, or accept that under the threat model?
5. **Group payment exposure.** The relay accepts at most one write per (payer, nonce). Each
   unlanded write costs one landed transaction at that nonce, and at most 64 can be outstanding
   (nonce window 63). Accept this, or ask for a tighter rule?
6. **Deferred group writes.** Writes waiting on a nonce gap or a chain check show as "unreachable".
   Should they get a distinct "waiting for funds/chain" state, plus a discard that releases the
   coin only after a chain read?
7. **Relay-to-relay forwarding (#1348).** It needs the #89 decisions: how relays authenticate each
   other, who may retry, and how fees are kept separate from the recipient's payment.

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
