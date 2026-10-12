# Gateway wallet host contract

`openGatewayWallet` in `src/host/gateway-wallet.ts` is a headless custody seam for a Monad testnet mail gateway. It does not start the gateway or provision a wallet. The production host must inject a fully configured `EvmChainConfig`, an absolute path to a private roots file, and the **expected public identity address** from its deployment configuration. It must close the returned handle on shutdown.

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

`chainIdentifier`, `rpcChain`, and `networkId` must all be `monad-testnet`, `networkTag` must be `MONT`, and native EVM chain ID must be 10143. `walletStorageLocation` must be an absolute persistent base path. The corresponding wallet state is stored under `<base>-evm-<lowercase main account address>` and must already contain LevelDB state for `wallet-manifest`, `sub-account-pool`, and `change-pool`. A missing or incomplete state path is refused before opening custody, because silently starting fresh on a previously used root could reuse a spent account or rewind a nonce. Keep this volume and every wallet journal across pod restarts. Run one wallet owner at a time; do not mount the same state writable in multiple replicas.

Provisioning the roots and wallet state is a separate, explicit operator step; it is not performed by this helper. The gateway host must bind its mail journal and directory identity to the same public account, reconcile retained payment attempts before sending, and use the wallet's signed payment capability. The legacy demo daemon still uses a fake stamp provider and is not a production entry point.
