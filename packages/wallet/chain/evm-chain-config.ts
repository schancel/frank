import type { StampDefaultResolver } from "../oracle/stamp-policy";
/** Generic EVM configuration; runtime/environment composition remains in monad-chain.ts. */
import type { NativeTransactionAttemptStore } from "./chain-wallet";
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
  /**
   * Contract addresses for a network whose contracts are deployed per run (a regtest chain is
   * new on every start, so the registry has no record for it). Other networks take theirs from
   * the registry and must not set this.
   */
  contracts?: { readonly stateChannel?: string; readonly htlc?: string };
  /** `0x`-prefixed Monad burn address Stamp/topic-vote burns are sent to (see
   * `frank/.env.example`'s `MONAD_STAMP_BURN_ADDRESS`). */
  stampBurnAddress: string;
  /** Host-owned default stamp pricing. Omitted when only explicit/free amounts are used. */
  resolveDefaultStamp?: StampDefaultResolver;
  /** Existing EVM wager minimum, independent of attention-stamp pricing. */
  minimumWagerValueWei?: bigint;
  /** Existing background funding sizing, independent of attention-stamp pricing. */
  stampFundingTargetWei?: bigint;
  /**
   * How many blocks must pass after an account's last transaction before a value transfer from
   * it is safe. Monad: 3. Its reserve-balance rule reverts (and still charges gas for) a
   * transfer that takes an account below its reserve (10 MON, so nearly every transfer of a
   * small wallet) unless the account sent nothing in the previous 3 blocks. Seen on testnet: a
   * stamp payment mined two blocks after the previous one from the same account reverted, and
   * its message was delivered unpaid. Read from the network's registry row; absent: no spacing.
   */
  spendSpacingBlocks?: number;
  /** The reserve the spacing rule protects (Monad: 10 MON). A transfer that leaves its account
   * at or above it is never reverted by the rule, so it needs no spacing. Both facts come from
   * the network's registry row (`ChainRegistryEntry`). */
  reserveBalanceWei?: bigint;
  /** Client polling policy for waiting payments (the registry row's `paymentPollIntervalMs`). */
  paymentPollIntervalMs?: number;
  /** How long a native send watches the transfer it just broadcast for its block before it
   * returns it as pending (it is then watched from outside). Default 30 s. Tests on a stub
   * node that never mines set 0: one look. */
  nativeInclusionWaitMs?: number;
  /** Default value, in wei, burned for a topic post or vote. */
  defaultTopicVoteValueWei: bigint;
  /** How many single-use funding sub-accounts `createWallet` pre-derives into the pool. */
  subAccountPoolSize: number;
  /** Parent LevelDB location for durable sender-account and change state. `false` is reserved for
   * isolated tests; production must persist these records so recreating a wallet cannot reuse a
   * sender account or rewind the change derivation path. */
  walletStorageLocation: string | false;
  nativeAttemptStore?: NativeTransactionAttemptStore;

  /** Unique chain identifier, e.g. "monad-testnet", "monad-mainnet", "hyperliquid-mainnet", "tempo-mainnet". */
  readonly chainIdentifier?: string;
  /** Human-readable chain display name, e.g. "Base", "HyperEVM". */
  readonly name?: string;
  /** Primary display unit symbol, e.g. "ETH", "HYPE". */
  readonly unit?: string;
  /** Custom transaction builder strategy for native gas vs token-as-gas (TIP-20/ERC-20). */
  readonly transactionBuilder?: EvmTransactionBuilder;
}
