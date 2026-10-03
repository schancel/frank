# Simulated typed-wallet funding

Start the built-in demo with `yarn demo --fake-chain`. Creating a typed account
may leave it with zero funds; that is a valid setup. Its EVM receive address is
different from its authentication/profile address. The production faucet and
Qwen welcome behavior still fund profile addresses and are unchanged.

To explicitly ensure **1 simulated MON** at the typed wallet's EVM receive
address, run this from the repository root, using the fake RPC port printed by
the launcher (8545 by default):

```sh
TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx \
  packages/bot/demo/fund-demo.ts --fake-chain --port 8545 0xYOUR_EVM_RECEIVE_ADDRESS
```

Replace the last argument with `wallet.getReceiveAddress().raw` (await the
method), not `wallet.identity.address.raw`. No root, seed, private key, wallet
file, amount, or external RPC URL belongs in this command. Output is labeled
simulated ledger credit and contains only the public address and balance.

The named client seam for the later #699 UI integration is:

```ts
import { ensureDemoBalance } from './demo-funding'

const result = await ensureDemoBalance(
  { fakeChain: true, rpcUrl: 'http://127.0.0.1:8545' },
  (
    await wallet.getReceiveAddress()
  ).raw,
)
```

Only pass `fakeChain: true` when the launcher is explicitly in built-in fake
mode. The helper rejects real mode, nonliteral loopback URLs, redirects, and
services without the fake funding capability. A Monad chain ID or genesis
checkpoint is **not** a fake-mode signal. The built-in launcher enables the
capability only in its fake-chain branch, with a persisted ledger. Standalone
`startFakeRpc` instances do not expose it unless explicitly enabled with
`demoFunding: true`, a state file, and the `127.0.0.1` bind address.

This is a local fake-service control API (`GET`/`POST
`/\_ctl/demo-funding`), not a chain RPC method or protocol allocation. The GET
returns an explicitly simulated capability and a process-lifetime token. The
POST requires that token in `x-frank-demo-funding`and exactly`{evmReceiveAddress, amountWei: "1000000000000000000"}`. The token is publicly
discoverable on loopback; it identifies the running fake service, not a user or
an authorization boundary. This service holds only simulated funds. No chain
transaction, signing operation, production wallet, or real faucet is involved.

The fixed floor is the existing fake-demo faucet default, 1 MON. Credits persist
through the existing fake-chain ledger write before success is returned. A
write failure fails the request and restores the previous in-memory balance.
Concurrent requests or retries at the floor do not add more funds; balances
above the floor are preserved. Restart restores the ledger and never refills
spent balances. **Explicitly calling again after spending requests a top-up
back to 1 simulated MON**, including a delayed retry after another operation
has spent funds. There is no per-operation retry journal. A rejected request
does not credit anything; startup and ordinary account creation never invoke
this seam automatically.
# Explicit directory admission integration

`yarn workspace @frank/bot demo --directory-admission /absolute/public-config.json`
selects the separate synthetic public-trust/admission integration. It requires
explicit installed inputs for both relays and the bot, trusted nanosecond time,
new/reopen intent and continuity outside the admission store. It starts only an
owned pinned-HTTPS fixture and uses the public admission facade; it does not
activate production directory routes, writers, DM or UI. Normal `yarn demo`
behavior is unchanged, and its topic wire remains protobuf.

See [the integration contract and configuration](directory-trust/README.md).
Real directory publication/resolution is #774; actual UI/game/two-relay proof
remains separately owned. Synthetic fixture completion is not those outcomes.
