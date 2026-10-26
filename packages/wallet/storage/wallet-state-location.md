# Wallet state names and the development reset

`walletStateLocation` in [`wallet-state-location.ts`](wallet-state-location.ts) names every
wallet's durable state. It is the only function that does:

```
<base>-<chainIdentifier>-<owner>
```

- `base`: the host's choice. The browser app uses `frank-wallet-state`
  (`FRANK_WALLET_STORAGE_LOCATION` overrides it). Node hosts pass a directory, for example
  `<state>/chain-storage` (bots) or `FRANK_MAIL_WALLET_STATE_DIR` (mail gateway).
- `chainIdentifier`: the canonical network id from `docs/protocol/chains/v1.json`, exactly once.
- `owner`: `evm-<main account, lower case>` for an EVM wallet, `pathusd-<address>` for Tempo.

Each store of the wallet is a namespace under that location: in Node the directory
`<location>/<namespace>`, in the browser the IndexedDB database
`level-js-<location>/<namespace>`. For an EVM wallet that is the pool records, change pool,
manifest, native operation journal, stamp journals, coin list, received coins, stealth
preparations, contact payments, the mailbox-scan record and the sent-message store. eCash,
Bitcoin-family and native-attempt records live in `localStorage` under keys that already carry
the canonical network.

Examples, one account `0xabc…` on two networks:

| Network | Location |
| --- | --- |
| monad-testnet | `frank-wallet-state-monad-testnet-evm-0xabc…` |
| monad-regtest | `frank-wallet-state-monad-regtest-evm-0xabc…` |
| ethereum-sepolia | `frank-wallet-state-ethereum-sepolia-evm-0xabc…` |

## Earlier names

Builds before this change wrote:

- a Monad wallet on any Monad network: `frank-monad-wallet-state-evm-<address>` (no network;
  testnet and regtest shared it);
- a Monad wallet opened as a second network: `frank-monad-wallet-state-<network>-evm-<address>`;
- another EVM network: `frank-monad-wallet-state-<network>-<network>-evm-<address>`;
- a Node host's Monad wallet: `<base>-evm-<address>`.

Nothing reads, migrates or deletes these (AGENTS.md §6). When a wallet opens and one of them
still exists for the same account, the wallet reports it (`earlierEvmWalletState`), and the
app shows a notice on the Wallet page saying so, with this reset path.

## Development reset

The old state holds no seed and no root. What it held is found again from the seed, the chain
and the mailbox:

1. Open the account in this build. Open **Settings → About**, tap the version line seven times,
   and run **Developer → Reconcile wallet**. It reads the mailbox from the start (received
   stealth payments), walks the seed for accounts in use, and reads every signed operation from
   the chain. It signs and sends nothing. Its summary lists what it found.
2. When the balance is what you expect, delete the old databases: in the browser's developer
   tools, *Application → IndexedDB*, delete each database whose name starts with
   `level-js-frank-monad-wallet-state-` (the notice lists the exact locations). On a Node host,
   stop it and delete the old directory.

A Node host that ran a single network can instead stop and rename the old directory to the new
name, because the state is that network's. Do not do this for a browser Monad wallet: its old
state may mix Monad networks.

Deleting old state forgets unfinished sends of the old build; settle or abandon them first.
