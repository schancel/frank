import * as net from 'node:net';
import { SmtpListener, parseRawRfc822, extractEmailAddress } from '../src/smtp/smtp-listener';
import { MxDirectTransport } from '../src/mta/mx-transport';
import { InboundEmailHandler } from '../src/smtp/inbound-server';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { GatewayStampProvider } from '../src/stamps/stamp-provider.interface';
import {
  DkimSigner,
  computeBodyHash,
  generateDkimKeyPair,
  splitMessage,
  verifyDkimSignature,
} from '../src/mta/dkim-signer';

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

type PeerStage = 'GREETING' | 'EHLO' | 'MAIL' | 'RCPT' | 'DATA' | 'BODY' | 'QUIT';
type PeerAction = 'reply' | 'replyThenDrop' | 'drop' | 'silent';

interface PeerScript {
  /** Reply text per stage, without the trailing CRLF. `BODY` answers the end of the message data. */
  readonly replies?: Partial<Record<PeerStage, string>>;
  /** What the peer does when a stage is reached. Default: reply. */
  readonly actions?: Partial<Record<PeerStage, PeerAction>>;
  /** Delay before each reply, so a command written too early is observable. */
  readonly replyDelayMs?: number;
}

interface PeerConnection {
  /** Every byte the peer received, in order. */
  received: Buffer;
  /** Command lines, split on CRLF only. */
  commands: string[];
  /** One entry per completed data phase: the bytes before the end-of-data line, as received. */
  messages: Buffer[];
  /** True when bytes arrived while the peer still owed a reply. */
  spokeBeforeReply: boolean;
}

interface RecordingPeer {
  readonly port: number;
  readonly connections: PeerConnection[];
  /** Resolves once every accepted connection has closed. */
  allClosed(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_PEER_REPLIES: Record<PeerStage, string> = {
  GREETING: '220 peer.test ESMTP ready',
  EHLO: '250-peer.test\r\n250-SIZE 10485760\r\n250 OK',
  MAIL: '250 2.1.0 Sender OK',
  RCPT: '250 2.1.5 Recipient OK',
  DATA: '354 End data with <CR><LF>.<CR><LF>',
  BODY: '250 2.0.0 Accepted',
  QUIT: '221 2.0.0 Bye',
};

const CRLF = Buffer.from('\r\n');
const END_OF_DATA = Buffer.from('\r\n.\r\n');

/**
 * A local SMTP peer that keeps the exact bytes it receives. It recognises
 * only CRLF as a line ending and only CRLF.CRLF as the end of the data, and
 * runs the n-th script for the n-th connection (the last script repeats).
 */
async function startRecordingPeer(scripts: PeerScript[] = [{}]): Promise<RecordingPeer> {
  const connections: PeerConnection[] = [];
  const open = new Set<net.Socket>();
  let notifyClosed: Array<() => void> = [];

  const server = net.createServer((socket) => {
    const script = scripts[Math.min(connections.length, scripts.length - 1)];
    const conn: PeerConnection = {
      received: Buffer.alloc(0),
      commands: [],
      messages: [],
      spokeBeforeReply: false,
    };
    connections.push(conn);
    open.add(socket);

    let pending = Buffer.alloc(0);
    let inData = false;
    let owesReply = false;

    const respond = (stage: PeerStage) => {
      const action = script.actions?.[stage] ?? 'reply';
      if (action === 'silent') return;
      if (action === 'drop') {
        socket.destroy();
        return;
      }
      const reply = `${script.replies?.[stage] ?? DEFAULT_PEER_REPLIES[stage]}\r\n`;
      const send = () => {
        owesReply = false;
        if (socket.destroyed) return;
        if (stage === 'DATA' && reply.startsWith('354')) inData = true;
        if (action === 'replyThenDrop' || stage === 'QUIT') {
          socket.end(reply);
        } else {
          socket.write(reply);
          consume();
        }
      };
      owesReply = true;
      if (script.replyDelayMs) {
        setTimeout(send, script.replyDelayMs);
      } else {
        send();
      }
    };

    const consume = () => {
      while (!owesReply) {
        if (inData) {
          // The CRLF that ended the 354-answered DATA line also opens the first data line.
          const emptyData = pending.subarray(0, 3).equals(END_OF_DATA.subarray(2));
          const end = emptyData ? -2 : pending.indexOf(END_OF_DATA);
          if (!emptyData && end === -1) return;
          conn.messages.push(Buffer.from(pending.subarray(0, end + 2)));
          pending = pending.subarray(end + END_OF_DATA.length);
          inData = false;
          respond('BODY');
          continue;
        }
        const end = pending.indexOf(CRLF);
        if (end === -1) return;
        const line = pending.subarray(0, end).toString('latin1');
        pending = pending.subarray(end + CRLF.length);
        conn.commands.push(line);
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') respond('EHLO');
        else if (verb === 'MAIL') respond('MAIL');
        else if (verb === 'RCPT') respond('RCPT');
        else if (verb === 'DATA') respond('DATA');
        else if (verb === 'QUIT') respond('QUIT');
        else socket.write('500 5.5.2 Command not recognised\r\n');
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (owesReply) conn.spokeBeforeReply = true;
      conn.received = Buffer.concat([conn.received, chunk]);
      pending = Buffer.concat([pending, chunk]);
      consume();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      open.delete(socket);
      if (open.size === 0) {
        const waiting = notifyClosed;
        notifyClosed = [];
        waiting.forEach((fn) => fn());
      }
    });

    respond('GREETING');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as net.AddressInfo).port,
    connections,
    allClosed: () =>
      open.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => notifyClosed.push(resolve)),
    stop: () => {
      open.forEach((socket) => socket.destroy());
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Reverses RFC 5321 section 4.5.2 transparency the way a receiving server does. */
function removeTransparency(data: Buffer): string {
  return data
    .toString('utf-8')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? line.slice(1) : line))
    .join('\r\n');
}

function hasBareLineEnding(data: Buffer): boolean {
  const text = data.toString('latin1');
  return /\r(?!\n)/.test(text) || /(?<!\r)\n/.test(text);
}

describe('MxDirectTransport delivery to a local peer', () => {
  const HEADERS = 'From: sender@frank.org\r\nTo: bob@remote.test\r\nSubject: Hello\r\n\r\n';
  let peer: RecordingPeer | undefined;

  afterEach(async () => {
    await peer?.stop();
    peer = undefined;
  });

  /** A transport whose MX lookup lists the local peer `mxCount` times, in priority order. */
  function transportTo(
    target: RecordingPeer,
    options: { mxCount?: number; timeoutMs?: number; heloDomain?: string } = {}
  ): MxDirectTransport {
    return new MxDirectTransport({
      heloDomain: options.heloDomain ?? 'gateway.frank.org',
      defaultPort: target.port,
      timeoutMs: options.timeoutMs ?? 5_000,
      resolveMxFn: async () =>
        Array.from({ length: options.mxCount ?? 1 }, (_, i) => ({
          exchange: '127.0.0.1',
          priority: 10 * (i + 1),
        })),
    });
  }

  function send(transport: MxDirectTransport, message: string | Buffer, envelope: { from?: string; to?: string } = {}) {
    return transport.deliver({
      fromAddress: envelope.from ?? 'sender@frank.org',
      toAddress: envelope.to ?? 'bob@remote.test',
      rawRfc822: typeof message === 'string' ? Buffer.from(message, 'utf-8') : message,
    });
  }

  it('delivers a body containing a line with only a dot intact, as one message followed only by QUIT', async () => {
    peer = await startRecordingPeer([{ replyDelayMs: 5 }]);
    const message = `${HEADERS}before\r\n.\r\nafter\r\n`;

    const result = await send(transportTo(peer), message);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(result.success).toBe(true);
    expect(result.responseCode).toBe(250);
    expect(peer.connections).toHaveLength(1);
    const conn = peer.connections[0];
    expect(conn.messages).toHaveLength(1);
    expect(removeTransparency(conn.messages[0])).toBe(message);
    expect(conn.commands).toEqual([
      'EHLO gateway.frank.org',
      'MAIL FROM:<sender@frank.org>',
      'RCPT TO:<bob@remote.test>',
      'DATA',
      'QUIT',
    ]);
    expect(conn.spokeBeforeReply).toBe(false);
  });

  it('writes the end-of-data line exactly once, after the message data', async () => {
    peer = await startRecordingPeer();
    const message = `${HEADERS}one\r\n.\r\n.\r\ntwo\r\n`;

    await send(transportTo(peer), message);
    await peer.allClosed();

    const received = peer.connections[0].received.toString('latin1');
    const dataStart = received.indexOf('DATA\r\n') + 'DATA\r\n'.length;
    expect(received.slice(dataStart)).toBe(
      `${HEADERS}one\r\n..\r\n..\r\ntwo\r\n.\r\nQUIT\r\n`
    );
  });

  it('transmits a line beginning with a dot transparently, so the received body matches its DKIM body hash', async () => {
    peer = await startRecordingPeer();
    const keyPair = generateDkimKeyPair();
    const signer = new DkimSigner({ domain: 'frank.org', selector: 'test', privateKey: keyPair.privateKey });
    const signed = signer.sign(
      'From: Alice <alice@frank.org>\r\n' +
        'To: Bob <bob@remote.test>\r\n' +
        'Subject: Dots\r\n' +
        'Date: Fri, 09 Oct 2026 12:00:00 GMT\r\n' +
        'Message-ID: <dots@frank.org>\r\n' +
        '\r\n' +
        'first line\r\n.leading dot\r\n..two leading dots\r\n.\r\nlast line\r\n'
    );

    const result = await send(transportTo(peer), signed);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections[0].messages).toHaveLength(1);
    const received = removeTransparency(peer.connections[0].messages[0]);
    expect(received).toBe(signed);
    const bodyHashTag = /bh=([^;]+);/.exec(received)?.[1];
    expect(computeBodyHash(splitMessage(received).body)).toBe(bodyHashTag);
    expect(verifyDkimSignature(received, keyPair.publicKey)).toBe(true);
  });

  it.each([
    ['lone CR line endings', 'first line\rsecond line\r.third line\rlast line\r'],
    ['CR, LF and CRLF line endings mixed', 'first line\rsecond line\n.third line\r\n\r\n\rfourth  line \n\rlast line'],
  ])('transmits a signed body with %s as the bytes that were signed, so its DKIM signature verifies', async (_label, body) => {
    peer = await startRecordingPeer();
    const keyPair = generateDkimKeyPair();
    const signer = new DkimSigner({ domain: 'frank.org', selector: 'test', privateKey: keyPair.privateKey });
    const signed = signer.sign(
      'From: Alice <alice@frank.org>\n' +
        'To: Bob <bob@remote.test>\r\n' +
        'Subject: Line endings\n' +
        'Date: Fri, 09 Oct 2026 12:00:00 GMT\r\n' +
        'Message-ID: <endings@frank.org>\n' +
        '\n' +
        body
    );

    const result = await send(transportTo(peer), signed);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections[0].messages).toHaveLength(1);
    expect(hasBareLineEnding(peer.connections[0].received)).toBe(false);
    const received = removeTransparency(peer.connections[0].messages[0]);
    expect(received).toBe(signed.endsWith('\r\n') ? signed : `${signed}\r\n`);
    const bodyHashTag = /bh=([^;]+);/.exec(received)?.[1];
    expect(computeBodyHash(splitMessage(received).body)).toBe(bodyHashTag);
    expect(verifyDkimSignature(received, keyPair.publicKey)).toBe(true);
  });

  it('transmits lone LF line endings as CRLF', async () => {
    peer = await startRecordingPeer();

    const result = await send(transportTo(peer), 'From: a@frank.org\nSubject: x\n\none\ntwo\n');
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    const data = peer.connections[0].messages[0];
    expect(hasBareLineEnding(peer.connections[0].received)).toBe(false);
    expect(data.toString('utf-8')).toBe('From: a@frank.org\r\nSubject: x\r\n\r\none\r\ntwo\r\n');
  });

  it('transmits lone CR line endings as CRLF', async () => {
    peer = await startRecordingPeer();

    const result = await send(transportTo(peer), 'From: a@frank.org\rSubject: x\r\rone\r.\rtwo\r');
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections[0].messages).toHaveLength(1);
    const data = peer.connections[0].messages[0];
    expect(hasBareLineEnding(peer.connections[0].received)).toBe(false);
    expect(removeTransparency(data)).toBe('From: a@frank.org\r\nSubject: x\r\n\r\none\r\n.\r\ntwo\r\n');
  });

  it('adds exactly one CRLF before the end-of-data line when the message does not end with a line ending', async () => {
    peer = await startRecordingPeer();

    await send(transportTo(peer), `${HEADERS}no final newline`);
    await peer.allClosed();

    expect(peer.connections[0].messages[0].toString('utf-8')).toBe(`${HEADERS}no final newline\r\n`);
  });

  it('adds no line before the end-of-data line when the message already ends with CRLF', async () => {
    peer = await startRecordingPeer();

    await send(transportTo(peer), `${HEADERS}final newline\r\n`);
    await peer.allClosed();

    expect(peer.connections[0].messages[0].toString('utf-8')).toBe(`${HEADERS}final newline\r\n`);
  });

  it('sends a message whose longest line is 998 bytes', async () => {
    peer = await startRecordingPeer();
    const message = `${HEADERS}${'x'.repeat(998)}\r\n`;

    const result = await send(transportTo(peer), message);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections[0].messages[0].toString('utf-8')).toBe(message);
  });

  it('refuses a message with a 999-byte line before connecting', async () => {
    peer = await startRecordingPeer();

    const result = await send(transportTo(peer), `${HEADERS}${'x'.repeat(999)}\r\n`);

    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(false);
    expect(result.responseCode).toBeUndefined();
    expect(peer.connections).toHaveLength(0);
  });

  it('reports accepted when the peer closes the connection right after its reply to the end of the data, without a second connection', async () => {
    peer = await startRecordingPeer([{ actions: { BODY: 'replyThenDrop' } }]);

    const result = await send(transportTo(peer, { mxCount: 2 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(result.success).toBe(true);
    expect(result.responseCode).toBe(250);
    expect(peer.connections).toHaveLength(1);
  });

  it('reports accepted when the peer never answers QUIT', async () => {
    peer = await startRecordingPeer([{ actions: { QUIT: 'silent' } }]);

    const result = await send(transportTo(peer, { mxCount: 2, timeoutMs: 300 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections).toHaveLength(1);
  });

  it('reports ambiguous and does not contact the second MX when the peer closes the connection after the data without a reply', async () => {
    peer = await startRecordingPeer([{ actions: { BODY: 'drop' } }]);

    const result = await send(transportTo(peer, { mxCount: 2 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('ambiguous');
    expect(result.success).toBe(false);
    expect(result.responseCode).toBeUndefined();
    expect(peer.connections).toHaveLength(1);
    expect(peer.connections[0].messages).toHaveLength(1);
  });

  it('reports ambiguous and does not contact the second MX when no reply to the data arrives before the timeout', async () => {
    peer = await startRecordingPeer([{ actions: { BODY: 'silent' } }]);

    const result = await send(transportTo(peer, { mxCount: 2, timeoutMs: 300 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('ambiguous');
    expect(result.success).toBe(false);
    expect(peer.connections).toHaveLength(1);
  });

  it('tries the second MX after a 4xx reply before the data', async () => {
    peer = await startRecordingPeer([{ replies: { RCPT: '451 4.3.0 Try again later' } }, {}]);

    const result = await send(transportTo(peer, { mxCount: 2 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections).toHaveLength(2);
    expect(peer.connections[0].messages).toHaveLength(0);
    expect(peer.connections[1].messages).toHaveLength(1);
  });

  it('reports refused with the 4xx code when every MX answers 4xx before the data', async () => {
    peer = await startRecordingPeer([{ replies: { RCPT: '451 4.3.0 Try again later' } }]);

    const result = await send(transportTo(peer, { mxCount: 2 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('refused');
    expect(result.responseCode).toBe(451);
    expect(peer.connections).toHaveLength(2);
  });

  it('tries the second MX after a 5xx reply before the data, and reports refused with the 5xx code when every MX answers 5xx', async () => {
    peer = await startRecordingPeer([{ replies: { RCPT: '550 5.1.1 No such user' } }]);

    const result = await send(transportTo(peer, { mxCount: 2 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(false);
    expect(result.responseCode).toBe(550);
    expect(peer.connections).toHaveLength(2);
    expect(peer.connections.every((c) => c.messages.length === 0)).toBe(true);
  });

  it('tries the second MX when the end of the data is answered 4xx', async () => {
    peer = await startRecordingPeer([{ replies: { BODY: '452 4.3.1 Insufficient storage' } }, {}]);

    const result = await send(transportTo(peer, { mxCount: 2 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections).toHaveLength(2);
  });

  it('tries the second MX when the first closes the connection before the data', async () => {
    peer = await startRecordingPeer([{ actions: { MAIL: 'drop' } }, {}]);

    const result = await send(transportTo(peer, { mxCount: 2 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections).toHaveLength(2);
  });

  it('tries the second MX when the first times out before the data', async () => {
    peer = await startRecordingPeer([{ actions: { RCPT: 'silent' } }, {}]);

    const result = await send(transportTo(peer, { mxCount: 2, timeoutMs: 300 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections).toHaveLength(2);
  });

  it('does not take a reply that arrives before the data was written as the answer to the data', async () => {
    peer = await startRecordingPeer([
      { replies: { DATA: '354 Go ahead\r\n250 2.0.0 Accepted' }, actions: { BODY: 'silent' } },
    ]);

    const result = await send(transportTo(peer, { timeoutMs: 300 }), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(false);
    expect(peer.connections[0].messages).toHaveLength(0);
  });

  it('reads a multi-line reply to its last line before writing the next command', async () => {
    peer = await startRecordingPeer([
      {
        replyDelayMs: 5,
        replies: {
          GREETING: '220-peer.test ESMTP\r\n220 ready',
          MAIL: '250-2.1.0 Sender\r\n250 2.1.0 OK',
        },
      },
    ]);

    const result = await send(transportTo(peer), `${HEADERS}body\r\n`);
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections[0].commands).toEqual([
      'EHLO gateway.frank.org',
      'MAIL FROM:<sender@frank.org>',
      'RCPT TO:<bob@remote.test>',
      'DATA',
      'QUIT',
    ]);
    expect(peer.connections[0].spokeBeforeReply).toBe(false);
  });

  const UNACCEPTABLE_IN_ADDRESS: Array<[string, string]> = [
    ['a carriage return', 'bob\r@remote.test'],
    ['a line feed', 'bob@remote.test\nextra'],
    ['a CRLF pair', 'bob@remote.test\r\nextra'],
    ['a space', 'bob smith@remote.test'],
    ['an opening angle bracket', '<bob@remote.test'],
    ['a closing angle bracket', 'bob@remote.test>'],
    ['a NUL', 'bob\u0000@remote.test'],
    ['a doubled dot in the local part', 'bob..smith@remote.test'],
    ['no domain', 'bob'],
  ];

  it.each(UNACCEPTABLE_IN_ADDRESS)(
    'refuses an envelope recipient with %s before connecting',
    async (_label, address) => {
      peer = await startRecordingPeer();

      const result = await send(transportTo(peer), `${HEADERS}body\r\n`, { to: address });

      expect(result.outcome).toBe('refused');
      expect(result.success).toBe(false);
      expect(result.responseCode).toBeUndefined();
      expect(peer.connections).toHaveLength(0);
    }
  );

  it.each(UNACCEPTABLE_IN_ADDRESS)(
    'refuses an envelope sender with %s before connecting',
    async (_label, address) => {
      peer = await startRecordingPeer();

      const result = await send(transportTo(peer), `${HEADERS}body\r\n`, { from: address });

      expect(result.outcome).toBe('refused');
      expect(result.success).toBe(false);
      expect(result.responseCode).toBeUndefined();
      expect(peer.connections).toHaveLength(0);
    }
  );

  it.each([
    ['a carriage return', 'gateway.frank.org\rextra'],
    ['a line feed', 'gateway.frank.org\nextra'],
    ['a CRLF pair', 'gateway.frank.org\r\nextra'],
    ['a space', 'gateway.frank.org extra'],
  ])('refuses to deliver with an EHLO name containing %s before connecting', async (_label, heloDomain) => {
    peer = await startRecordingPeer();

    const result = await send(transportTo(peer, { heloDomain }), `${HEADERS}body\r\n`);

    expect(result.outcome).toBe('refused');
    expect(result.success).toBe(false);
    expect(peer.connections).toHaveLength(0);
  });

  it('accepts envelope addresses that use the full permitted local-part character set', async () => {
    peer = await startRecordingPeer();

    const result = await send(transportTo(peer), `${HEADERS}body\r\n`, {
      from: 'bounce+0a1b2c3d4e5f@frank.org',
      to: "o'neil_j.r-x+tag=1@mail.remote.test",
    });
    await peer.allClosed();

    expect(result.outcome).toBe('accepted');
    expect(peer.connections[0].commands.slice(1, 3)).toEqual([
      'MAIL FROM:<bounce+0a1b2c3d4e5f@frank.org>',
      "RCPT TO:<o'neil_j.r-x+tag=1@mail.remote.test>",
    ]);
  });
});
