# Typed Monad wallet construction

`ActiveChain.createWallet` accepts a `MonadRootBundle` containing `evm`,
`authentication`, and `messaging` outputs from the frozen `frank-domain-roots-v1`
registry. Every output must have its matching purpose and exactly 32 bytes; the
three secrets must differ. Validation and owned snapshots precede storage or RPC
effects. No mnemonic encoding or PBKDF2 runs on this path.

| Root | Owned role and existing path |
| --- | --- |
| `evm-wallet` | Native main/funding `m/44'/60'/1'/0/0`; pool `m/44'/60'/0'/0/i`; change `m/44'/60'/0'/1/i` |
| `identity-authentication` | Account identifier and authentication signatures at `m/44'/60'/1'/0/0` |
| `messaging-encryption` | Reserved owned copy; no child derivation until #696 |

The authentication address is the account identifier. `getReceiveAddress`, native
balance, transfers, and topic funding use the distinct EVM main address. All typed
DM entrypoints fail closed, including recovery operations that would otherwise use
the legacy identity-based payment/encryption key. No messaging schedule or wire
format is allocated here.

New typed pool/change/journal locations use
`<walletStorageLocation>-evm-<lowercase-main-address>`. Legacy locations remain
`<walletStorageLocation>-<lowercase-identity-address>`. Native attempt records use
the existing schema with the EVM main address as owner. Thus changing authentication
or messaging does not abandon EVM inventory or unresolved native transactions.
No existing data is migrated, copied, or deleted. As with the existing Node Level
store API, the host supplies an existing parent directory; browser storage uses
the namespace as its database name.

One factory reuses an exact bundle and rejects a changed bundle for the same
authentication identity. Across factories in one runtime, a second typed handle
for the same EVM account and chain ID is rejected until the first closes, even if
its authentication root differs. Cached callers share the wallet operation queue;
native attempts additionally retain the existing account-keyed coordinator. This
does not introduce a cross-process pool coordinator or an application activation
flow; #699 must continue to honor the host's persistence ownership requirements.

The typed return value exposes `close()`: it rejects new managed operations,
drains queued sends, closes stores and the provider, and wipes its owned messaging
bytes. Successful close releases the cache and economic owner; a failed close
keeps that owner reserved. Constructor failures and duplicate/mismatched cache
inputs also wipe their copies. Caller buffers are never wiped. EVM/auth root
snapshots are wiped immediately after key derivation; ethers-derived immutable
key strings are not claimed to be securely erased by JavaScript.

The deprecated `HDSeed` overload routes through the named private
`legacyMnemonicWalletMaterial` adapter for existing recovery callers. #699 owns
the normal app switch and removal of that overload; #692 remains open. This
enabling seam does not claim that the UI uses Codex32 or that all BIP39 runtime
reachability has been removed.
