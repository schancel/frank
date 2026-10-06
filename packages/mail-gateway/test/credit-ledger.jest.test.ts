import { CreditLedger } from '../src/ledger/credit-ledger';

describe('CreditLedger', () => {
  let ledger: CreditLedger;

  beforeEach(() => {
    ledger = new CreditLedger(':memory:');
  });

  it('initializes with zero balance', () => {
    expect(ledger.getBalance('alice@example.com')).toBe(0);
  });

  it('adds and accumulates credits', () => {
    ledger.addCredits('alice@example.com', 5);
    expect(ledger.getBalance('alice@example.com')).toBe(5);

    ledger.addCredits('alice@example.com', 10);
    expect(ledger.getBalance('alice@example.com')).toBe(15);
  });

  it('deduplicates payments by provider transaction id', () => {
    ledger.addCredits('bob@example.com', 5, 'stripe_tx_123', 'stripe');
    expect(ledger.getBalance('bob@example.com')).toBe(5);

    // Duplicate webhook delivery
    ledger.addCredits('bob@example.com', 5, 'stripe_tx_123', 'stripe');
    expect(ledger.getBalance('bob@example.com')).toBe(5); // Still 5
  });

  it('prioritizes thread-scoped reply allowances over global credits', () => {
    ledger.addCredits('alice@example.com', 5); // 5 global
    ledger.grantReplyAllowance('alice@example.com', '0xfrankuser', 2); // 2 scoped to 0xfrankuser

    expect(ledger.getThreadAllowance('alice@example.com', '0xfrankuser')).toBe(2);

    // 1st send to 0xfrankuser: consumes reply allowance
    expect(ledger.consumeCredit('alice@example.com', '0xfrankuser')).toBe(true);
    expect(ledger.getThreadAllowance('alice@example.com', '0xfrankuser')).toBe(1);
    expect(ledger.getBalance('alice@example.com')).toBe(5); // Global untouched

    // 2nd send to 0xfrankuser: consumes reply allowance
    expect(ledger.consumeCredit('alice@example.com', '0xfrankuser')).toBe(true);
    expect(ledger.getThreadAllowance('alice@example.com', '0xfrankuser')).toBe(0);
    expect(ledger.getBalance('alice@example.com')).toBe(5);

    // 3rd send to 0xfrankuser: allowance exhausted, falls back to global credits
    expect(ledger.consumeCredit('alice@example.com', '0xfrankuser')).toBe(true);
    expect(ledger.getBalance('alice@example.com')).toBe(4);

    // Sending to another recipient doesn't get 0xfrankuser's allowance
    expect(ledger.consumeCredit('alice@example.com', '0xotheruser')).toBe(true);
    expect(ledger.getBalance('alice@example.com')).toBe(3);
  });

  it('holds, retrieves, and releases held messages', async () => {
    const rawRfc822 = new Uint8Array([1, 2, 3, 4]);
    await ledger.holdMessage({
      id: 'msg_1',
      senderEmail: 'recruiter@tech.com',
      recipientAddress: '0xfrankuser',
      dkimDomain: 'tech.com',
      subject: 'Interview request',
      rawRfc822,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 100000,
    });

    const held = ledger.getHeldMessage('msg_1');
    expect(held).toBeDefined();
    expect(held?.status).toBe('held');
    expect(held?.subject).toBe('Interview request');

    const released = ledger.releaseHeldMessage('msg_1');
    expect(released?.status).toBe('released');

    const afterRelease = ledger.getHeldMessage('msg_1');
    expect(afterRelease?.status).toBe('released');
  });

  it('manages bi-directional thread mappings', () => {
    ledger.recordThreadMapping({
      conversationId: 'conv_abc',
      frankMessageId: 'frank_msg_1',
      rfc822MessageId: '<rfc822_msg_1@tech.com>',
      inReplyToRfc822: undefined,
      subject: 'Hello Frank',
      createdAtMs: Date.now(),
    });

    const byFrank = ledger.getThreadMappingByFrankMessageId('conv_abc', 'frank_msg_1');
    expect(byFrank?.rfc822MessageId).toBe('<rfc822_msg_1@tech.com>');

    const byRfc822 = ledger.getThreadMappingByRfc822Id('<rfc822_msg_1@tech.com>');
    expect(byRfc822?.frankMessageId).toBe('frank_msg_1');
  });
});
