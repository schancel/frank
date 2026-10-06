import {
  EcashStampProvider,
  EcashSendWallet,
  formatXecAmount,
} from '../src/stamps/ecash-stamp-provider';
import { InboundEmailHandler } from '../src/smtp/inbound-server';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { ChainAddress, ChainTransaction } from '@frank/wallet/chain/chain-wallet';

describe('formatXecAmount', () => {
  it('formats satoshis to XEC with 2 decimal places', () => {
    expect(formatXecAmount(0n)).toBe('0.00');
    expect(formatXecAmount(546n)).toBe('5.46');
    expect(formatXecAmount(100n)).toBe('1.00');
    expect(formatXecAmount(99n)).toBe('0.99');
    expect(formatXecAmount(1_000_000n)).toBe('10000.00');
    expect(formatXecAmount(-500n)).toBe('-5.00');
  });
});

describe('EcashStampProvider', () => {
  let mockWallet: EcashSendWallet;

  beforeEach(() => {
    mockWallet = {
      getBalance: jest.fn().mockResolvedValue(5_000_000n), // 50,000 XEC
      sendNative: jest.fn().mockImplementation(async (params: { recipient: ChainAddress; value: bigint }) => {
        return {
          txHash: `tx_${Math.random().toString(16).slice(2)}`,
        } as ChainTransaction;
      }),
    };
  });

  it('reports balance and health status', async () => {
    const provider = new EcashStampProvider({
      wallet: mockWallet,
      networkId: 'ecash-mainnet',
      lowBalanceThresholdSats: 1_000_000n, // 10,000 XEC
    });

    expect(provider.chainFamily).toBe('bitcoin');
    expect(provider.assetUnit).toBe('XEC');

    const balance = await provider.getBalance();
    expect(balance.raw).toBe(5_000_000n);
    expect(balance.display).toBe('50000.00 XEC');
    expect(balance.isLowBalance).toBe(false);

    const health = await provider.checkHealth();
    expect(health.ok).toBe(true);
    expect(health.message).toContain('Healthy');
  });

  it('warns when balance is below threshold', async () => {
    (mockWallet.getBalance as jest.Mock).mockResolvedValue(500_000n); // 5,000 XEC

    const provider = new EcashStampProvider({
      wallet: mockWallet,
      networkId: 'xec-testnet',
      lowBalanceThresholdSats: 1_000_000n,
    });

    expect(provider.assetUnit).toBe('tXEC');

    const balance = await provider.getBalance();
    expect(balance.isLowBalance).toBe(true);

    const health = await provider.checkHealth();
    expect(health.ok).toBe(true);
    expect(health.message).toContain('Warning: Hot wallet balance is low');
  });

  it('handles error in health check gracefully', async () => {
    (mockWallet.getBalance as jest.Mock).mockRejectedValue(new Error('RPC connection failed'));

    const provider = new EcashStampProvider({ wallet: mockWallet });
    const health = await provider.checkHealth();

    expect(health.ok).toBe(false);
    expect(health.message).toContain('RPC connection failed');
  });

  it('stamps and sends micro-payment output to recipient', async () => {
    const provider = new EcashStampProvider({
      wallet: mockWallet,
      defaultStampSats: 546n,
    });

    const result = await provider.stampAndSendDirectMessage({
      recipientAddress: 'ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl',
      text: 'Hello from gateway',
    });

    expect(result.recipientAddress).toBe('ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl');
    expect(result.txHash).toBeDefined();
    expect(mockWallet.sendNative).toHaveBeenCalledWith({
      recipient: { raw: 'ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl' },
      value: 546n,
    });
  });

  it('swaps seamlessly into InboundEmailHandler', async () => {
    const ledger = new CreditLedger(':memory:');
    ledger.grantReplyAllowance('alice@example.com', 'ecash:recipient1', 1);

    const provider = new EcashStampProvider({
      wallet: mockWallet,
    });

    const handler = new InboundEmailHandler({
      gatewayDomain: 'frank.example.com',
      ledger,
      stampProvider: provider,
      relayLookup: async (username) => {
        if (username === 'bob') {
          return { accountAddress: 'ecash:recipient1' };
        }
        return undefined;
      },
    });

    const result = await handler.processInboundEmail({
      messageId: '<test_ecash_msg@example.com>',
      fromAddress: 'alice@example.com',
      fromDomain: 'example.com',
      toAddress: 'bob@frank.example.com',
      localPart: 'bob',
      subject: 'Swappable Stamp Test',
      textBody: 'Testing eCash stamp delivery',
      dkimValid: true,
      spfValid: true,
      rawRfc822: Buffer.from('From: alice@example.com\r\n\r\nbody'),
    });

    expect(result.status).toBe('delivered');
    expect(result.txHash).toBeDefined();
    expect(mockWallet.sendNative).toHaveBeenCalled();
  });
});
