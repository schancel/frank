# Examples

- `e2e_demo_server.rs`: the registry HTTP server with a chain adapter that needs no Lotus node.
  It serves identity registration only; it has no message routes.
- `e2e_demo_register_identity.rs`: registers an identity against it.
- `directory_trust_probe.rs`: probes a relay's directory.

To see messages sent through a real relay on Monad testnet, with payments checked on chain, use
the real-stack harness from the repository root:

    yarn test:two-wallets     # two wallets exchange paid messages
    yarn demo:smoke           # a wallet messages each demo bot and checks the reply

Both start the relay from `backend/cashweb/cashwebd.local.toml` through
`backend/cashweb/run-local-monad.sh`. See `packages/bot/demo/real-stack.ts` for what they need
in `.env`.

The runbook that used to be here described the protobuf message transport (`PUT /message/monad`),
which no longer exists.
