# Demo launcher and the real test harness

Everything here runs on a real chain (Monad testnet) with the real relay binary. Nothing in this
directory simulates a chain or a relay.

| File | What it is |
| --- | --- |
| `demo.ts`, `demo-config.ts`, `demo-identities.ts` | `yarn demo`: the relay, then one process running every bot (`../targets/all-bots.ts`). See [the bot README](../README.md#one-command-demo-yarn-demo). |
| `real-stack.ts` | The reusable harness: start the real relay, open real wallets, fund them from the funding wallet, tear down. |
| `two-wallets.ts` | `yarn test:two-wallets`: two wallets exchange stamped messages; payments are checked on chain. |
| `smoke.ts`, `smoke-checks.ts` | `yarn demo:smoke`: the demo stack plus a new user who messages each bot; replies are checked for content. |
| `chain-rpc.ts` | The read-only JSON-RPC calls the launcher makes (balances, chain id). |

## Using the harness in another test

```ts
import { startRealStack } from '@frank/bot/demo/real-stack'   // or a relative path

const stack = await startRealStack()             // real relay on a free port; RPC and wallet from .env
const alice = await stack.openWallet('alice')    // fresh keys, directory entry and profile published
const bob = await stack.openWallet('bob')
await stack.fund(alice.mainAccount, 12_000_000_000_000_000n)   // from the funding wallet, confirmed
const digest = await alice.send(bob.address, [{ type: 'text', text: 'hi' }], 1_000_000_000_000n)
const got = await bob.receive(m => m.payloadDigest === digest)
// stack.provider is an ethers provider on the same chain, for on-chain assertions
await stack.stop()                               // returns what is left, stops the relay
```

Settings (process environment first, then `<repo>/.env` or `FRANK_DEMO_ENV_FILE`):
`MONAD_TESTNET_HTTP_RPC_URL` (required), `E2E_DEMO_MAIN_WALLET_JSON` (required to fund),
`CASHWEBD_BIN` (a prebuilt relay; otherwise this checkout's Cargo build), `FRANK_REAL_STACK_RELAY_PORT`
(default: a free port), `FRANK_REAL_STACK_DIR` (default: a new temp directory; every wallet's
account root is kept there, mode 0600, so its funds can be recovered). Pass `relayUrl` to
`startRealStack` to use a relay that is already running instead of starting one.

It spends real testnet funds: what `fund` is asked for plus gas. Funding transfers from the one
wallet are serialised across processes by a lock directory beside the wallet file, each sent with
the next pending nonce and waited for, so parallel test runs cannot collide. A wallet's first
message also moves about 0.008 MON from its main account into the stamp account it prepares; that
stays with the wallet. In a git worktree, point `FRANK_DEMO_ENV_FILE` at the `.env` of the main
checkout.

## Explicit directory admission integration

`yarn workspace @frank/bot demo --directory-admission /absolute/public-config.json`
selects the separate synthetic public-trust/admission integration. It requires
explicit installed inputs for both relays and the bot, trusted nanosecond time,
new/reopen intent and continuity outside the admission store. It starts only an
owned pinned-HTTPS fixture and uses the public admission facade; it does not
activate production directory routes, writers, DM or UI.

See [the integration contract and configuration](directory-trust/README.md).
