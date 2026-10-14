import { authenticate } from 'mailauth';
import {
  JournaledSmtpIngress,
  SmtpAdmissionRefusal,
  strictSmtpAuthentication,
} from '../src/smtp/journaled-smtp-ingress';
import { createIssuedMailboxLookup } from '../src/smtp/issued-mailbox-lookup';

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

async function authenticateOffline(message: Buffer) {
  const realMailauth = jest.requireActual<typeof import('mailauth')>('mailauth');
  return realMailauth.authenticate(message, {
    ip: '192.0.2.10', helo: 'sender.evil.example', sender: 'attacker@evil.example',
    strict: true, trustReceived: false,
    resolver: async (name, type) => {
      if (type === 'TXT' && name === 'evil.example') return [['v=spf1 ip4:192.0.2.10 -all']];
      if (type === 'TXT' && name === '_dmarc.evil.example') return [['v=DMARC1; p=reject']];
      throw Object.assign(new Error('Not found'), { code: 'ENOTFOUND' });
    },
  });
}

function rawWithFrom(from: string): Buffer {
  return Buffer.from([
    `From: ${from}`, 'To: one@signet.mx', 'Message-ID: <attack@evil.example>',
    'Subject: Test', '', 'Hi',
  ].join('\r\n'));
}

describe('direct SMTP durable ingress', () => {
  const accountAddress = `0x${'1'.repeat(40)}`;

  beforeEach(() => jest.clearAllMocks());

  it('uses the actual SMTP peer and strict DMARC; forged raw headers cannot authenticate', async () => {
    const verify = jest.mocked(authenticate);
    verify.mockResolvedValueOnce({ dmarc: { status: { result: 'fail' } } } as never);
    await expect(strictSmtpAuthentication.authenticatedAuthor(raw, envelope)).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith(raw, {
      ip: '192.0.2.10', helo: 'sender.example.org', sender: 'bounce@example.org',
      strict: true, trustReceived: false,
    });
  });

  it('accepts only issued recipients and journals every alias before success', async () => {
    const lookup = jest.fn(async (localPart: string) => localPart === 'one' || localPart === 'two'
      ? { accountAddress, conversationId: localPart } : undefined);
    const admit = jest.fn((_mail: unknown, _scope: string, _value: bigint, _conversation?: string, _local?: string) => ({ kind: 'held' as const }));
    const authentication = { authenticatedAuthor: jest.fn(async () => 'alice@example.org') };
    const ingress = new JournaledSmtpIngress({
      gatewayDomain: 'signet.mx', issuedMailboxLookup: lookup,
      sender: { admit }, stampValue: 123n, authentication,
    });
    expect(await ingress.acceptsRecipient('unknown@signet.mx')).toBe(false);
    expect(await ingress.acceptsRecipient('postmaster@signet.mx')).toBe(false);
    expect(await ingress.acceptsRecipient('one@signet.mx')).toBe(true);
    await ingress.accept(raw, { ...envelope, recipients: ['one@signet.mx', 'two@signet.mx'] });
    expect(authentication.authenticatedAuthor).toHaveBeenCalledTimes(1);
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
      authentication: { authenticatedAuthor: async () => 'alice@example.org' },
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
      authentication: { authenticatedAuthor: async () => undefined },
    });
    await expect(ingress.accept(raw, envelope)).rejects.toBeInstanceOf(SmtpAdmissionRefusal);
    expect(admit).not.toHaveBeenCalled();
  });

  it('rejects a DMARC-passing comment that the legacy parser would bill to another sender', async () => {
    const spoof = rawWithFrom('(comment <victim@bank.example>) attacker@evil.example');
    const authenticated = await authenticateOffline(spoof);
    expect(authenticated.dmarc && authenticated.dmarc.status.result).toBe('pass');
    const admit = jest.fn(() => ({ kind: 'held' as const }));
    jest.mocked(authenticate).mockResolvedValueOnce(authenticated);
    const ingress = new JournaledSmtpIngress({
      gatewayDomain: 'signet.mx',
      issuedMailboxLookup: async () => ({ accountAddress }),
      sender: { admit }, stampValue: 1n,
    });
    await expect(ingress.accept(spoof, {
      ...envelope, mailFrom: 'attacker@evil.example',
    })).rejects.toMatchObject({ responseCode: 550 });
    expect(authenticated.dkim.headerFrom).toEqual(['attacker@evil.example']);
    expect(admit).not.toHaveBeenCalled();
  });

  it('uses one quoted display-name author and refuses multiple, absent, or malformed authors', async () => {
    const admit = jest.fn((_mail: { authenticatedSenderEmail: string }) => ({ kind: 'held' as const }));
    const ingress = new JournaledSmtpIngress({
      gatewayDomain: 'signet.mx',
      issuedMailboxLookup: async () => ({ accountAddress }),
      sender: { admit }, stampValue: 1n,
    });
    const named = rawWithFrom('"Alice, Customer" <alice@evil.example>');
    const namedAuth = await authenticateOffline(named);
    expect(namedAuth.dkim.headerFrom).toEqual(['alice@evil.example']);
    jest.mocked(authenticate).mockResolvedValueOnce(namedAuth);
    await ingress.accept(named, { ...envelope, mailFrom: 'attacker@evil.example' });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0][0].authenticatedSenderEmail).toBe('alice@evil.example');

    for (const from of ['a@evil.example, b@evil.example', '', 'Alice <alice@evil.example> Bob']) {
      const message = rawWithFrom(from);
      const result = await authenticateOffline(message);
      jest.mocked(authenticate).mockResolvedValueOnce(result);
      await expect(ingress.accept(message, { ...envelope, mailFrom: 'attacker@evil.example' }))
        .rejects.toMatchObject({ responseCode: 550 });
    }
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('resolves operator aliases, u.0x userId fallback, and relay usernames in createIssuedMailboxLookup', async () => {
    const operatorAccount = `0x${'f'.repeat(40)}`;
    const userAccount = `0x${'a'.repeat(40)}`;
    const relayAccount = `0x${'b'.repeat(40)}`;
    const issuedMailbox = jest.fn(() => undefined);
    const fetchImpl = jest.fn(async (url: string | URL) => {
      if (String(url).endsWith('/usernames/alice_frank')) {
        return {
          ok: true,
          json: async () => ({ username: 'alice_frank', address: relayAccount }),
        } as unknown as Response;
      }
      return { ok: false, json: async () => ({}) } as unknown as Response;
    });
    const lookup = createIssuedMailboxLookup(
      { issuedMailbox },
      {
        operatorAccountAddress: operatorAccount,
        relayBaseUrl: 'https://relay.frank.test',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    await expect(lookup('support')).resolves.toEqual({ accountAddress: operatorAccount });
    await expect(lookup('admin')).resolves.toEqual({ accountAddress: operatorAccount });
    await expect(lookup('postmaster')).resolves.toEqual({ accountAddress: operatorAccount });
    await expect(lookup(`u.${userAccount}`)).resolves.toEqual({ accountAddress: userAccount });
    await expect(lookup('alice_frank')).resolves.toEqual({ accountAddress: relayAccount });
    await expect(lookup('unknown_user')).resolves.toBeUndefined();
    expect(issuedMailbox).not.toHaveBeenCalledWith('support');
    expect(issuedMailbox).not.toHaveBeenCalledWith(`u.${userAccount}`);
  });
});

