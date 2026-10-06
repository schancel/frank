import {
  GatewayStampProvider,
  GatewayWalletBalance,
  StampSubmissionResult,
} from './stamp-provider.interface';
import type { MessageItem } from '@frank/cashweb/types/messages';
import type { ChainAddress, ChainTransaction } from '@frank/wallet/chain/chain-wallet';

export interface EcashSendWallet {
  getBalance(): Promise<bigint>;
  sendNative(params: {
    recipient: ChainAddress;
    value: bigint;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction>;
  networkId?: string;
}

export interface EcashStampProviderOptions {
  readonly wallet: EcashSendWallet;
  readonly networkId?: 'ecash-mainnet' | 'ecash-testnet' | 'xec-mainnet' | 'xec-testnet';
  readonly defaultStampSats?: bigint;
  readonly lowBalanceThresholdSats?: bigint;
}

/** Formats satoshis (1 XEC = 100 sats) into standard decimal string. */
export function formatXecAmount(sats: bigint): string {
  const isNegative = sats < 0n;
  const abs = isNegative ? -sats : sats;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac.toString().padStart(2, '0');
  return `${isNegative ? '-' : ''}${whole}.${fracStr}`;
}

export class EcashStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'bitcoin' as const;
  readonly assetUnit: string;
  private readonly wallet: EcashSendWallet;
  private readonly defaultStampSats: bigint;
  private readonly lowBalanceThresholdSats: bigint;

  constructor(options: EcashStampProviderOptions) {
    this.wallet = options.wallet;
    const isTestnet =
      options.networkId === 'ecash-testnet' || options.networkId === 'xec-testnet';
    this.assetUnit = isTestnet ? 'tXEC' : 'XEC';
    // 546 sats standard eCash dust / micro-payment stamp
    this.defaultStampSats = options.defaultStampSats ?? 546n;
    // 10,000 XEC = 1,000,000 sats low balance threshold
    this.lowBalanceThresholdSats = options.lowBalanceThresholdSats ?? 1_000_000n;
  }

  async getBalance(): Promise<GatewayWalletBalance> {
    const raw = await this.wallet.getBalance();
    const display = `${formatXecAmount(raw)} ${this.assetUnit}`;
    const isLowBalance = raw < this.lowBalanceThresholdSats;
    return { raw, display, isLowBalance };
  }

  async checkHealth(): Promise<{ ok: boolean; message?: string }> {
    try {
      const balance = await this.getBalance();
      if (balance.isLowBalance) {
        return {
          ok: true,
          message: `Warning: Hot wallet balance is low (${balance.display})`,
        };
      }
      return { ok: true, message: `Healthy (${balance.display})` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Health check failed: ${message}` };
    }
  }

  async stampAndSendDirectMessage(params: {
    recipientAddress: string;
    items?: MessageItem[];
    text?: string;
    relayUrl?: string;
  }): Promise<StampSubmissionResult> {
    const recipientRaw = params.recipientAddress.trim();
    if (!recipientRaw) {
      throw new Error('Recipient address cannot be empty');
    }

    const tx = await this.wallet.sendNative({
      recipient: { raw: recipientRaw },
      value: this.defaultStampSats,
    });

    return {
      txHash: tx.txHash,
      payloadDigest: tx.txHash,
      recipientAddress: recipientRaw,
      relayResponse: tx,
    };
  }
}
