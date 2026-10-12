# Gateway wallet host contract

`openGatewayWallet` in `src/host/gateway-wallet.ts` is a headless custody seam for a Monad testnet mail gateway. It does not start the gateway or create a wallet. The host must inject a fully configured `EvmChainConfig`, an absolute path to a private roots file, and the **expected public identity address** from its deployment configuration. It must close the returned handle on shutdown.

The roots file is an existing, regular, owner-readable file with mode 0400 or 0600 on Unix. It must not be a symlink. Its schema is `frank-domain-roots-v1` with exactly these three 32-byte lowercase or uppercase hex roots:

```json
{
  "registry": "frank-domain-roots-v1",
  "roots": {
    "evm-wallet": "<64 hex characters>",
    "identity-authentication": "<64 hex characters>",
    "messaging-encryption": "<64 hex characters>"
  }
}
```

Supply the file through a private mounted secret, not a source file, container image, command-line argument containing the bytes, or public Terraform variable. The helper never generates or replaces roots. Its errors contain fixed reason codes and no key material. The `replyAliasSalt()` result is a copy of a domain-separated secret derived from the messaging root; the host should retain it only as long as it needs to derive aliases and zeroize its own copies. The helper zeroizes its copy on close.

`chainIdentifier`, `rpcChain`, and `networkId` must all be `monad-testnet`, `networkTag` must be `MONT`, and native EVM chain ID must be 10143. `walletStorageLocation` must be an absolute persistent base path. The corresponding wallet state is stored under `<base>-evm-<lowercase main account address>`. The opener checks five existing LevelDB namespaces, the typed wallet's native-operation manifest and canonical public binding, and a mail-host continuity marker before opening custody. Empty LevelDB directories cannot satisfy this admission. Keep the entire volume and every wallet journal across pod restarts. Run one wallet owner at a time; do not mount the same state writable in multiple replicas.

First provision a genuinely new wallet using the existing typed wallet factory and close it. Then call `provisionGatewayWalletAdmission` once with the same roots, state path, and expected identity. It opens and validates the wallet and creates `mail-host-admission.json` exclusively with a random state ID. Ordinary `openGatewayWallet` will never create this marker. Do not run provisioning merely to silence an admission error for a previously used root or a restored volume.

**Mainnet custody gap:** The current typed EVM wallet does not bind its `sub-account-pool` and `change-pool` databases to its native/canonical manifests. A partial restore that keeps those manifests and the mail-host marker but resets either pool could therefore pass this host preflight while losing spend history. The host must not be used with mainnet funds until wallet-owned pool binding and monotonic recovery checks are implemented and tested. The gateway host must also bind its mail journal and directory identity to the same public account, reconcile retained payment attempts before sending, and use the wallet's signed payment capability. The legacy demo daemon still uses a fake stamp provider and is not a production entry point.
