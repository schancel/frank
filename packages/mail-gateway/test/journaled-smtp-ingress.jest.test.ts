import { authenticate } from 'mailauth';
import {
  JournaledSmtpIngress,
  SmtpAdmissionRefusal,
  strictSmtpAuthentication,
} from '../src/smtp/journaled-smtp-ingress';

jest.mock('mailauth', () => ({ authenticate: jest.fn() }));

const raw = Buffer.from([
  'From: Alice <alice@example.org>',
  'To: one@signet.mx',
  'Message-ID: <smtp-test@example.org>',
  'Authentication-Results: attacker.invalid; dmarc=pass header.from=example.org',
  'Subject: Test',
  '',
  'Hello',
].join('\r\n'));
const envelope = {
  clientIp: '192.0.2.10', helo: 'sender.example.org', mailFrom: 'bounce@example.org',
  recipients: ['one@signet.mx'],
};

describe('direct SMTP durable ingress', () => {
  const accountAddress = `0x${'1'.repeat(40)}`;

  beforeEach(() => jest.clearAllMocks());

  it('uses the actual SMTP peer and strict DMARC; forged raw headers cannot authenticate', async () => {
    const verify = jest.mocked(authenticate);
    verify.mockResolvedValueOnce({ dmarc: { status: { result: 'fail' } } } as never);
    await expect(strictSmtpAuthentication.verify(raw, envelope)).resolves.toBe(false);
    expect(verify).toHaveBeenCalledWith(raw, {
      ip: '192.0.2.10', helo: 'sender.example.org', sender: 'bounce@example.org',
      strict: true, trustReceived: false,
    });
  });

  it('accepts only issued recipients and journals every alias before success', async () => {
    const lookup = jest.fn(async (localPart: string) => localPart === 'one' || localPart === 'two'
      ? { accountAddress, conversationId: localPart } : undefined);
    const admit = jest.fn((_mail: unknown, _scope: string, _value: bigint, _conversation?: string, _local?: string) => ({ kind: 'held' as const }));
    const authentication = { verify: jest.fn(async () => true) };
    const ingress = new JournaledSmtpIngress({
      gatewayDomain: 'signet.mx', issuedMailboxLookup: lookup,
      sender: { admit }, stampValue: 123n, authentication,
    });
    expect(await ingress.acceptsRecipient('unknown@signet.mx')).toBe(false);
    expect(await ingress.acceptsRecipient('postmaster@signet.mx')).toBe(false);
    expect(await ingress.acceptsRecipient('one@signet.mx')).toBe(true);
    await ingress.accept(raw, { ...envelope, recipients: ['one@signet.mx', 'two@signet.mx'] });
    expect(authentication.verify).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(admit.mock.calls[0][3]).toBe('one');
    expect(admit.mock.calls[0][4]).toBe('one');
    expect(admit.mock.calls[1][3]).toBe('two');
    expect(admit.mock.calls[1][4]).toBe('two');
  });

  it('returns a temporary refusal if any recipient cannot be journaled', async () => {
    const admit = jest.fn().mockReturnValueOnce({ kind: 'held' }).mockReturnValueOnce({ kind: 'refused' });
    const ingress = new JournaledSmtpIngress({
      gatewayDomain: 'signet.mx',
      issuedMailboxLookup: async localPart => ({ accountAddress, conversationId: localPart }),
      sender: { admit }, stampValue: 0n,
      authentication: { verify: async () => true },
    });
    await expect(ingress.accept(raw, { ...envelope, recipients: ['one@signet.mx', 'two@signet.mx'] }))
      .rejects.toMatchObject({ responseCode: 451 });
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it('rejects unauthenticated mail without spending or queuing', async () => {
    const admit = jest.fn(() => ({ kind: 'held' as const }));
    const ingress = new JournaledSmtpIngress({
      gatewayDomain: 'signet.mx',
      issuedMailboxLookup: async () => ({ accountAddress }),
      sender: { admit }, stampValue: 1n,
      authentication: { verify: async () => false },
    });
    await expect(ingress.accept(raw, envelope)).rejects.toBeInstanceOf(SmtpAdmissionRefusal);
    expect(admit).not.toHaveBeenCalled();
  });
});
