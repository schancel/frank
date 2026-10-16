# Format & Ownership Disposition (`fix/hd-funding-provenance`)

## Durable Format Baseline

- **Wallet Storage Manifest Version**: `4` (`MONAD_WALLET_STORAGE_VERSION = 4`)
- **Sub-Account Pool Schema Intent**: `sub-account-pool-v4-funding-evidence`
- **Change Pool Schema Intent**: `change-pool-v2` (unchanged)
- **Pool Envelope Version**: `4` (`POOL_ENVELOPE_VERSION = 4`)

## Ownership & Compatibility Rules

1. **Authoritative Row & Terminal Provenance**:
   - `SubAccountRecord.funding` (`SubAccountFundingCollection`, `version: 1`) is the single durable authority for locally initiated HD child funding attempts and their anchored chain observations.
   - `SubAccountTerminalCheckpoint.funding` preserves the full `SubAccountFundingCollection` when terminal `spent` or `retired` rows are projected to checkpoints. Rows with any `unresolved` funding attempt or active `funding.hold` cannot be compacted.
2. **Fail-Closed Refusal of Legacy Formats**:
   - `LevelSubAccountPoolStore` and `MonadWalletBundle` accept only version `4` (`sub-account-pool-v4-funding-evidence`). Legacy v3 or unversioned pool records and manifests are refused before any disk write, preserving existing keys, manifests, and signed artifacts untouched on disk.
   - No dual-read fallback or synthetic empty funding provenance is invented for legacy funded rows. Owner disposition is required before release migration.
3. **Distinct Store Boundaries Preserved**:
   - `MonadAccountTxSigner` performs stateless anchored RPC observation (`observeFunding`) and never mutates pool storage.
   - `EvmNativeOperationJournal`, `ReceivedCoinStore`, and `ChangePoolStore` retain their existing independent ownership boundaries.
   - `evm-input-admission` blocks native spends on sub-accounts in `funding` status or holding any `unresolved` funding attempt or active `funding.hold`.
