import { Interface, type Provider, type TransactionRequest } from "ethers";
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

export interface EvmDrainParams {
  readonly from: string;
  readonly recipient: string;
  readonly balanceWei: bigint;
  readonly baseFeeWei: bigint;
  readonly priorityTipWei?: bigint;
  readonly gasLimit?: bigint;
  readonly nonce?: number;
}

/**
 * Strategy interface abstracting EVM transaction construction and balance checking.
 * Allows standard native-gas EVM chains (Monad, Ethereum L1, Base, Arbitrum, HyperEVM)
 * and token-as-gas chains (like Tempo TIP-20) to share the exact same wallet, keyring,
 * attempt-journal, sub-account pool, and concurrency machinery.
 */
export interface EvmTransactionBuilder {
  /** Explicit support for native-value fan-in accounting, not token-as-gas transfers. */
  readonly supportsNativeConsolidation?: boolean;
  getBalance(params: { address: string; provider: Provider }): Promise<bigint>;
  buildTransfer(params: EvmTransferParams): Promise<TransactionRequest>;
  buildBurn(params: EvmBurnParams): Promise<TransactionRequest>;
  buildZeroRefundDrain(params: EvmDrainParams): Promise<TransactionRequest>;
}

/**
 * Default standard native EVM transaction builder for chains where gas and value
 * transfers are denominated in native wei (e.g., MON, ETH, HYPE).
 */
export class NativeEvmTransactionBuilder implements EvmTransactionBuilder {
  readonly supportsNativeConsolidation = true;
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

  async buildZeroRefundDrain(
    params: EvmDrainParams
  ): Promise<TransactionRequest> {
    const gasLimit = params.gasLimit ?? 21_000n;
    const maxFeePerGas =
      params.baseFeeWei + (params.priorityTipWei ?? 1_000_000_000n);
    const maxPriorityFeePerGas = maxFeePerGas;
    const totalFee = gasLimit * maxFeePerGas;

    if (params.balanceWei <= totalFee) {
      throw new RangeError(
        "Account balance is insufficient to pay zero-refund drain fee"
      );
    }

    const drainValue = params.balanceWei - totalFee;

    return {
      from: params.from,
      to: params.recipient,
      value: drainValue,
      data: "0x",
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      ...(params.nonce !== undefined && {
        nonce: params.nonce,
      }),
    };
  }
}

export const defaultNativeEvmTransactionBuilder =
  new NativeEvmTransactionBuilder();

const TIP20_INTERFACE = new Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const TEMPO_PATH_USD_ADDRESS =
  "0x20c0000000000000000000000000000000000000";

/**
 * Transaction builder for TIP-20 / ERC-20 token-as-gas chains such as Tempo.
 * Balances query `balanceOf(address)` and transfers encode `transfer(recipient, amount)`
 * with native `value: 0n`.
 */
export class Tip20TransactionBuilder implements EvmTransactionBuilder {
  readonly tokenAddress: string;

  constructor(tokenAddress: string = TEMPO_PATH_USD_ADDRESS) {
    this.tokenAddress = tokenAddress;
  }

  async getBalance(params: {
    address: string;
    provider: Provider;
  }): Promise<bigint> {
    const data = TIP20_INTERFACE.encodeFunctionData("balanceOf", [
      params.address,
    ]);
    const rawResult = await params.provider.call({
      to: this.tokenAddress,
      data,
    });
    if (!rawResult || rawResult === "0x") {
      return 0n;
    }
    const [balance] = TIP20_INTERFACE.decodeFunctionResult(
      "balanceOf",
      rawResult
    );
    return balance as bigint;
  }

  async buildTransfer(params: EvmTransferParams): Promise<TransactionRequest> {
    const data = TIP20_INTERFACE.encodeFunctionData("transfer", [
      params.recipient,
      params.amount,
    ]);
    return {
      from: params.from,
      to: this.tokenAddress,
      value: 0n,
      data,
      gasLimit: params.overrides?.gasLimit ?? 65_000n,
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
    const baseData = TIP20_INTERFACE.encodeFunctionData("transfer", [
      params.burnAddress,
      params.amount,
    ]);
    const data =
      params.commitmentData && params.commitmentData !== "0x"
        ? baseData + params.commitmentData.replace(/^0x/, "")
        : baseData;

    return {
      from: params.from,
      to: this.tokenAddress,
      value: 0n,
      data,
      gasLimit: params.overrides?.gasLimit ?? 65_000n,
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

  async buildZeroRefundDrain(
    params: EvmDrainParams
  ): Promise<TransactionRequest> {
    const gasLimit = params.gasLimit ?? 65_000n;
    const maxFeePerGas =
      params.baseFeeWei + (params.priorityTipWei ?? 1_000_000_000n);
    const maxPriorityFeePerGas = maxFeePerGas;
    const totalFee = gasLimit * maxFeePerGas;

    if (params.balanceWei <= totalFee) {
      throw new RangeError(
        "Account balance is insufficient to pay zero-refund drain fee"
      );
    }

    const drainValue = params.balanceWei - totalFee;
    const data = TIP20_INTERFACE.encodeFunctionData("transfer", [
      params.recipient,
      drainValue,
    ]);

    return {
      from: params.from,
      to: this.tokenAddress,
      value: 0n,
      data,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      ...(params.nonce !== undefined && {
        nonce: params.nonce,
      }),
    };
  }
}

export const defaultTempoTransactionBuilder = new Tip20TransactionBuilder();

