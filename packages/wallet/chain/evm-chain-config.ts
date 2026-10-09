/** Generic EVM configuration; runtime/environment composition remains in monad-chain.ts. */
import type { NativeTransactionAttemptStore } from "./chain-wallet";
import type { FakeDemoRpcConfig } from "../monad-demo-rpc";
import type { EvmTransactionBuilder } from "./evm-transaction-builder";

export interface EvmChainConfig {
  /** Stable chain/deployment identifier used for wallet affinity checks. */
  networkId: string;
  /** Shared protocol chain identifier used by the relay family route. */
  rpcChain: string;
  /** Expected EVM chain ID, e.g. 10143 for Monad testnet. */
  chainId: number | bigint;
  /** Base URL of the `cashweb-registry` relay. */
  relayBaseUrl: string;
  /** Frank network tag included in every DM envelope before hashing. */
  networkTag: string;
  /** `0x`-prefixed Monad burn address Stamp/topic-vote burns are sent to (see
   * `frank/.env.example`'s `MONAD_STAMP_BURN_ADDRESS`). */
  stampBurnAddress: string;
  /** Default aggregate value, in wei, `directMessages.send` pays per Stamp message. */
  defaultStampValueWei: bigint;
  /** Default value, in wei, burned for a topic post or vote. */
  defaultTopicVoteValueWei: bigint;
  /** How many single-use funding sub-accounts `createWallet` pre-derives into the pool. */
  subAccountPoolSize: number;
  /** Parent LevelDB location for durable sender-account and change state. `false` is reserved for
   * isolated tests; production must persist these records so recreating a wallet cannot reuse a
   * sender account or rewind the change derivation path. */
  walletStorageLocation: string | false;
  nativeAttemptStore?: NativeTransactionAttemptStore;
  /** Explicit disposable fake-service opt-in; never selected by a relay failure. */
  fakeDemo?: FakeDemoRpcConfig;

  /** Unique chain identifier, e.g. "monad-testnet", "monad-mainnet", "hyperliquid-mainnet", "tempo-mainnet". */
  readonly chainIdentifier?: string;
  /** Human-readable chain display name, e.g. "Base", "HyperEVM". */
  readonly name?: string;
  /** Primary display unit symbol, e.g. "ETH", "HYPE". */
  readonly unit?: string;
  /** Custom transaction builder strategy for native gas vs token-as-gas (TIP-20/ERC-20). */
  readonly transactionBuilder?: EvmTransactionBuilder;
}
