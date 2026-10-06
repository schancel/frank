import {
  GatewayStampProvider,
  GatewayWalletBalance,
  StampSubmissionResult,
} from './stamp-provider.interface';
import type { MessageItem } from '@frank/cashweb/types/messages';
import type {
  ActiveChain,
  NativeWalletHandle,
  WalletHandle,
} from '@frank/wallet/chain/active-chain';

export interface MonadStampProviderOptions {
  readonly activeChain: ActiveChain;
  readonly wallet: NativeWalletHandle & WalletHandle;
  readonly lowBalanceThresholdWei?: bigint;
}

export class MonadStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit: string;
  private readonly activeChain: ActiveChain;
  private readonly wallet: NativeWalletHandle & WalletHandle;
  private readonly lowBalanceThresholdWei: bigint;

  constructor(options: MonadStampProviderOptions) {
    this.activeChain = options.activeChain;
    this.wallet = options.wallet;
    this.assetUnit = options.activeChain.unit || 'MON';
    this.lowBalanceThresholdWei =
      options.lowBalanceThresholdWei ?? BigInt('5000000000000000000'); // 5 MON
  }

  async getBalance(): Promise<GatewayWalletBalance> {
    const raw = await this.wallet.getBalance();
    const display = `${this.activeChain.toDisplayAmount(raw)} ${this.assetUnit}`;
    const isLowBalance = raw < this.lowBalanceThresholdWei;
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
    const recipient = this.activeChain.parseAddress(params.recipientAddress);
    if (!recipient) {
      throw new Error(`Invalid recipient chain address: ${params.recipientAddress}`);
    }

    const items: MessageItem[] =
      params.items ?? (params.text ? [{ type: 'text', text: params.text }] : []);

    const sendResult = await this.activeChain.directMessages.send({
      wallet: this.wallet,
      recipient,
      items,
      stampValue: this.activeChain.defaultStampValue,
    });

    return {
      txHash: sendResult.payloadDigest,
      payloadDigest: sendResult.payloadDigest,
      recipientAddress: params.recipientAddress,
      relayResponse: sendResult,
    };
  }
}
