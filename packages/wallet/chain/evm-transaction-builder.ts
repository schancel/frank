import type { Provider, TransactionRequest } from "ethers";
import type { MonadTxOverrides } from "../monad-account-tx";

export interface EvmTransferParams {
  readonly from: string;
  readonly recipient: string;
  readonly amount: bigint;
  readonly overrides?: MonadTxOverrides;
}

export interface EvmBurnParams {
  readonly from: string;
  readonly burnAddress: string;
  readonly amount: bigint;
  readonly commitmentData?: string;
  readonly overrides?: MonadTxOverrides;
}

/**
 * Strategy interface abstracting EVM transaction construction and balance checking.
 * Allows standard native-gas EVM chains (Monad, Ethereum L1, Base, Arbitrum, HyperEVM)
 * and token-as-gas chains (like Tempo TIP-20) to share the exact same wallet, keyring,
 * attempt-journal, sub-account pool, and concurrency machinery.
 */
export interface EvmTransactionBuilder {
  getBalance(params: { address: string; provider: Provider }): Promise<bigint>;
  buildTransfer(params: EvmTransferParams): Promise<TransactionRequest>;
  buildBurn(params: EvmBurnParams): Promise<TransactionRequest>;
}

/**
 * Default standard native EVM transaction builder for chains where gas and value
 * transfers are denominated in native wei (e.g., MON, ETH, HYPE).
 */
export class NativeEvmTransactionBuilder implements EvmTransactionBuilder {
  async getBalance(params: {
    address: string;
    provider: Provider;
  }): Promise<bigint> {
    return params.provider.getBalance(params.address);
  }

  async buildTransfer(params: EvmTransferParams): Promise<TransactionRequest> {
    return {
      from: params.from,
      to: params.recipient,
      value: params.amount,
      data: "0x",
      gasLimit: params.overrides?.gasLimit ?? 21_000n,
      ...(params.overrides?.maxFeePerGas !== undefined && {
        maxFeePerGas: params.overrides.maxFeePerGas,
      }),
      ...(params.overrides?.maxPriorityFeePerGas !== undefined && {
        maxPriorityFeePerGas: params.overrides.maxPriorityFeePerGas,
      }),
      ...(params.overrides?.gasPrice !== undefined && {
        gasPrice: params.overrides.gasPrice,
      }),
      ...(params.overrides?.nonce !== undefined && {
        nonce: params.overrides.nonce,
      }),
    };
  }

  async buildBurn(params: EvmBurnParams): Promise<TransactionRequest> {
    return {
      from: params.from,
      to: params.burnAddress,
      value: params.amount,
      data: params.commitmentData ?? "0x",
      ...(params.overrides?.gasLimit !== undefined && {
        gasLimit: params.overrides.gasLimit,
      }),
      ...(params.overrides?.maxFeePerGas !== undefined && {
        maxFeePerGas: params.overrides.maxFeePerGas,
      }),
      ...(params.overrides?.maxPriorityFeePerGas !== undefined && {
        maxPriorityFeePerGas: params.overrides.maxPriorityFeePerGas,
      }),
      ...(params.overrides?.gasPrice !== undefined && {
        gasPrice: params.overrides.gasPrice,
      }),
      ...(params.overrides?.nonce !== undefined && {
        nonce: params.overrides.nonce,
      }),
    };
  }
}

export const defaultNativeEvmTransactionBuilder =
  new NativeEvmTransactionBuilder();
