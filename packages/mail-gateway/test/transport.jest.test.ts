import * as net from 'node:net';
import { SmtpListener, parseRawRfc822, extractEmailAddress } from '../src/smtp/smtp-listener';
import { MxDirectTransport } from '../src/mta/mx-transport';
import { InboundEmailHandler } from '../src/smtp/inbound-server';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { GatewayStampProvider } from '../src/stamps/stamp-provider.interface';

class MockStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit = 'MON';

  async getBalance() {
    return { raw: 1000n, display: '1000 MON', isLowBalance: false };
  }
  async checkHealth() {
    return { ok: true, message: 'Healthy' };
  }
  async stampAndSendDirectMessage(params: { recipientAddress: string; text?: string }) {
    return {
      txHash: '0xmock_tx_hash_123',
      payloadDigest: '0xmock_digest_123',
      recipientAddress: params.recipientAddress,
    };
  }
}

describe('parseRawRfc822 and extractEmailAddress', () => {
  it('extracts emails from angle brackets or bare strings', () => {
    expect(extractEmailAddress('Alice Smith <alice@example.com>')).toBe('alice@example.com');
    expect(extractEmailAddress('<bob@example.com>')).toBe('bob@example.com');
    expect(extractEmailAddress('carol@example.com')).toBe('carol@example.com');
  });

  it('parses headers and extracts dkim and spf authentication results', () => {
    const raw = Buffer.from(
      'From: "Sender Name" <sender@domain.com>\r\n' +
      'To: <recipient@frank.domain>\r\n' +
      'Subject: Hello Frank!\r\n' +
      'Message-ID: <12345@domain.com>\r\n' +
      'Authentication-Results: mx.google.com; dkim=pass header.i=@domain.com; spf=pass\r\n' +
      '\r\n' +
      'This is the email body content.\r\n'
    );

    const parsed = parseRawRfc822(raw);
    expect(parsed.fromAddress).toBe('sender@domain.com');
    expect(parsed.toAddress).toBe('recipient@frank.domain');
    expect(parsed.localPart).toBe('recipient');
    expect(parsed.subject).toBe('Hello Frank!');
    expect(parsed.messageId).toBe('<12345@domain.com>');
    expect(parsed.dkimValid).toBe(true);
    expect(parsed.spfValid).toBe(true);
    expect(parsed.textBody).toContain('This is the email body content.');
  });
});

describe('SmtpListener', () => {
  let ledger: CreditLedger;
  let stampProvider: MockStampProvider;
  let handler: InboundEmailHandler;
  let listener: SmtpListener;
  const testPort = 25251;

  beforeEach(async () => {
    ledger = new CreditLedger(':memory:');
    ledger.grantReplyAllowance('sender@domain.com', '0xrecipient_addr', 1);
    stampProvider = new MockStampProvider();
    handler = new InboundEmailHandler({
      gatewayDomain: 'frank.domain',
      ledger,
      stampProvider,
      relayLookup: async (username) => {
        if (username === 'alice') {
          return { accountAddress: '0xrecipient_addr' };
        }
        if (username === 'tombstoned_user') {
          return { accountAddress: '0xtomb', isTombstoned: true };
        }
        return undefined;
      },
    });

    listener = new SmtpListener({
      gatewayDomain: 'frank.domain',
      handler,
    });

    await listener.start(testPort, '127.0.0.1');
  });

  afterEach(async () => {
    await listener.stop();
  });

  function sendSmtpCommands(commands: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: testPort, host: '127.0.0.1' });
      const responses: string[] = [];
      let buffer = '';
      let cmdIndex = 0;

      socket.on('error', reject);
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n');
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          responses.push(line);

          // If greeting or intermediate response received, send next command
          if (line.match(/^220 /) || line.match(/^250 /) || line.match(/^354 /) || line.match(/^550 /)) {
            if (cmdIndex < commands.length) {
              const cmd = commands[cmdIndex++];
              socket.write(cmd + '\r\n');
            } else if (line.startsWith('221 ') || line.startsWith('550 ')) {
              socket.end();
            }
          }
        }
      });

      socket.on('close', () => resolve(responses));
    });
  }

  it('completes SMTP transaction and delivers stamped message', async () => {
    const rawMsg =
      'From: sender@domain.com\r\n' +
      'To: alice@frank.domain\r\n' +
      'Subject: Test DM\r\n' +
      'Authentication-Results: dkim=pass\r\n' +
      '\r\n' +
      'Hello via SMTP!\r\n' +
      '.';

    const responses = await sendSmtpCommands([
      'EHLO client.example.com',
      'MAIL FROM:<sender@domain.com>',
      'RCPT TO:<alice@frank.domain>',
      'DATA',
      rawMsg,
      'QUIT',
    ]);

    expect(responses.some((r) => r.startsWith('220 '))).toBe(true);
    expect(responses.some((r) => r.startsWith('250-frank.domain'))).toBe(true);
    expect(responses.some((r) => r.includes('Message accepted and delivered'))).toBe(true);
  });

  it('rejects deactivated and tombstoned recipients with 550', async () => {
    const rawMsg =
      'From: sender@domain.com\r\n' +
      'To: tombstoned_user@frank.domain\r\n' +
      'Subject: Deactivated test\r\n' +
      '\r\n' +
      'Content\r\n' +
      '.';

    const responses = await sendSmtpCommands([
      'EHLO client.example.com',
      'MAIL FROM:<sender@domain.com>',
      'RCPT TO:<tombstoned_user@frank.domain>',
      'DATA',
      rawMsg,
      'QUIT',
    ]);

    expect(responses.some((r) => r.startsWith('550 5.2.1'))).toBe(true);
  });
});

describe('MxDirectTransport', () => {
  it('sorts MX records by priority', async () => {
    const mockResolveMx = jest.fn().mockResolvedValue([
      { exchange: 'backup.mail.example.com', priority: 20 },
      { exchange: 'primary.mail.example.com', priority: 10 },
      { exchange: 'tertiary.mail.example.com', priority: 30 },
    ]);

    const transport = new MxDirectTransport({
      heloDomain: 'gateway.frank.org',
      resolveMxFn: mockResolveMx,
    });

    const hosts = await transport.resolveMxHosts('example.com');
    expect(hosts).toEqual([
      'primary.mail.example.com',
      'backup.mail.example.com',
      'tertiary.mail.example.com',
    ]);
  });

  it('falls back to domain directly when no MX records exist', async () => {
    const mockResolveMx = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));

    const transport = new MxDirectTransport({
      heloDomain: 'gateway.frank.org',
      resolveMxFn: mockResolveMx,
    });

    const hosts = await transport.resolveMxHosts('bare-domain.org');
    expect(hosts).toEqual(['bare-domain.org']);
  });
});
