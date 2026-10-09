import { createHash, randomBytes } from 'node:crypto';

import { CreditLedger } from '../src/ledger/credit-ledger';
import { DkimSigner, generateDkimKeyPair, verifyDkimSignature } from '../src/mta/dkim-signer';
import { encodeMessageData } from '../src/mta/mx-transport';
import { OutboundEmailDelivery } from '../src/mta/outbound-delivery';
import { emailItemKey, mailKey, type EmailItemKeyInput } from '../src/rfc/mail-keys';
import { readHeaderSection, renderThreadHeaders } from '../src/rfc/message-headers';

const latin1 = (s: string): Uint8Array => Buffer.from(s, 'latin1');
const utf8 = (s: string): Uint8Array => Buffer.from(s, 'utf8');
const key = (s: string): string => mailKey(latin1(s));
const HEX_64 = /^[0-9a-f]{64}$/;

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const sha256 = (...parts: Array<Buffer | string>): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest('hex');
};

/** The contract's mail of section 21.2. */
const VECTOR_HEADERS = [
  'From: Ann <ann@x.example>',
  'To: bob@gw.example',
  'Subject: Hi\r\n there',
  'Date: Fri, 09 Oct 2026 10:00:00 +0000',
  'Message-ID: <m1@x.example>',
  'Received: from a',
];
const VECTOR_MAIL = `${VECTOR_HEADERS.join('\r\n')}\r\n\r\nHello\r\n`;
const VECTOR_KEY = '3aea9868b291aa938f09bf26e16d8980d2785cc0ce0eb77e02ad0d2d86f9d83a';

/** A mail with all eight key headers, for the sensitivity tests. */
const FULL: Record<string, string> = {
  From: 'Ann <ann@x.example>',
  To: 'bob@gw.example',
  Cc: 'cy@x.example',
  Subject: 'Hi there',
  Date: 'Fri, 09 Oct 2026 10:00:00 +0000',
  'Message-ID': '<m1@x.example>',
  'In-Reply-To': '<p1@gw.example>',
  References: '<r1@gw.example> <p1@gw.example>',
};
const mail = (headers: Record<string, string>, body = 'Hello\r\n', extra: string[] = []): string =>
  [...extra, ...Object.entries(headers).map(([n, v]) => `${n}: ${v}`)].join('\r\n') + `\r\n\r\n${body}`;

/**
 * What a receiving SMTP server hands over for the wire bytes of one message:
 * the data up to the end-of-data line, with the transparency dot of RFC 5321
 * section 4.5.2 removed from each line, behind the receiver's own trace lines.
 */
function asReceived(queued: Uint8Array, traceLines: string[] = ['Received: from mx.example by gw']): Buffer {
  const wire = Buffer.concat([encodeMessageData(queued), Buffer.from('.\r\n')]);
  const end = wire.indexOf('\r\n.\r\n');
  const data = wire.subarray(0, end + 2);
  const lines: Buffer[] = [];
  for (let at = 0; at < data.length; ) {
    const next = data.indexOf('\r\n', at) + 2;
    lines.push(data.subarray(data[at] === 0x2e ? at + 1 : at, next));
    at = next;
  }
  return Buffer.concat([...traceLines.map((l) => Buffer.from(`${l}\r\n`)), ...lines]);
}

describe('mailKey', () => {
  describe('contract vectors (section 21.2)', () => {
    it('gives the stated key for the stated mail', () => {
      expect(key(VECTOR_MAIL)).toBe(VECTOR_KEY);
    });

    it('gives the same key with LF line ends, other Received lines first, a folded Message-ID and three trailing newlines', () => {
      const variant = [
        'Received: from b',
        'Received: from c',
        'From: Ann <ann@x.example>',
        'To: bob@gw.example',
        'Subject: Hi\n there',
        'Date: Fri, 09 Oct 2026 10:00:00 +0000',
        'Message-ID:\n <m1@x.example>',
        '',
        'Hello\n\n\n',
      ].join('\n');
      expect(key(variant)).toBe(VECTOR_KEY);
    });

    it('gives the stated other key for body Hello!', () => {
      const other = key(VECTOR_MAIL.replace('Hello', 'Hello!'));
      expect(other).toMatch(/^b8fc15c3[0-9a-f]{50}a90005$/);
      expect(other).toBe('b8fc15c315d16431b3db61ccef5d5df8f24b128ff8d76ed311d71762efa90005');
    });

    it('equals the hash of the preimage written out by hand', () => {
      const h = (...values: string[]): Buffer =>
        Buffer.concat([u32(values.length), ...values.flatMap((v) => [u32(v.length), Buffer.from(v, 'latin1')])]);
      expect(VECTOR_KEY).toBe(
        sha256(
          'frank-mail-key/1',
          Buffer.from([0]),
          h('Ann <ann@x.example>'),
          h('bob@gw.example'),
          h(), // cc absent
          h('Hi there'),
          h('Fri, 09 Oct 2026 10:00:00 +0000'),
          h('<m1@x.example>'),
          h(), // in-reply-to absent
          h(), // references absent
          'Hello\r\n',
        ),
      );
    });
  });

  describe('headers', () => {
    const base = key(mail(FULL));

    it.each(Object.keys(FULL))('changes when one byte of %s changes', (name) => {
      expect(key(mail({ ...FULL, [name]: `${FULL[name]}x` }))).not.toBe(base);
      expect(key(mail({ ...FULL, [name]: FULL[name].replace(/[a-z]/, 'Z') }))).not.toBe(base);
    });

    it.each(Object.keys(FULL))('changes when %s is removed', (name) => {
      const { [name]: _removed, ...rest } = FULL;
      expect(key(mail(rest))).not.toBe(base);
    });

    it('tells an absent header from an empty one', () => {
      const { Cc: _cc, ...noCc } = FULL;
      const absent = key(mail(noCc));
      const empty = key(mail({ ...FULL, Cc: '' }));
      expect(empty).not.toBe(absent);
      // Only spaces, tabs and CRs: still present, with an empty value.
      expect(key(mail({ ...FULL, Cc: ' \t ' }))).toBe(empty);
    });

    it('ignores every header outside the eight, wherever it stands', () => {
      const extras = [
        'Received: from a by b',
        'DKIM-Signature: v=1; a=rsa-sha256; d=x.example; b=abc',
        'Return-Path: <ann@x.example>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'X-From: someone else',
        'Reply-To: other@x.example',
        'Bcc: hidden@x.example',
      ];
      expect(key(mail(FULL, 'Hello\r\n', extras))).toBe(base);
      expect(key(mail({ ...FULL, 'X-Trailer': 'y', Received: 'last' }))).toBe(base);
    });

    it('ignores the order of headers of different names and the case of names', () => {
      const reversed = Object.fromEntries(Object.entries(FULL).reverse());
      expect(key(mail(reversed))).toBe(base);
      const shouted = Object.fromEntries(Object.entries(FULL).map(([n, v]) => [n.toUpperCase(), v]));
      expect(key(mail(shouted))).toBe(base);
      expect(key(mail(FULL).replace('Subject:', 'subject \t:'))).toBe(base);
    });

    it('ignores folding at existing whitespace and outer spaces, tabs and CRs', () => {
      expect(key(mail({ ...FULL, Subject: 'Hi\r\n there' }))).toBe(base);
      expect(key(mail({ ...FULL, References: '<r1@gw.example>\r\n <p1@gw.example>' }))).toBe(base);
      expect(key(mail(FULL).replace('Subject: Hi there', 'Subject:\t  Hi there \t'))).toBe(base);
      expect(key(mail(FULL).replace('Subject: Hi there', 'Subject:Hi there'))).toBe(base);
      // A CR left at the end of a line by CR CR LF is outer whitespace.
      expect(key(mail(FULL).replace('Hi there\r\n', 'Hi there\r\r\n'))).toBe(base);
    });

    it('keeps inner whitespace and letter case of values as written', () => {
      expect(key(mail({ ...FULL, Subject: 'Hi  there' }))).not.toBe(base);
      expect(key(mail({ ...FULL, Subject: 'Hi\tthere' }))).not.toBe(base);
      expect(key(mail({ ...FULL, Subject: 'Hi\r\n\tthere' }))).not.toBe(base);
      expect(key(mail({ ...FULL, To: 'Bob@gw.example' }))).not.toBe(base);
    });

    it('covers every occurrence of a repeated header, in order', () => {
      const one = key('To: a@x.example\r\n\r\nB\r\n');
      const twoAB = key('To: a@x.example\r\nTo: b@x.example\r\n\r\nB\r\n');
      const twoBA = key('To: b@x.example\r\nTo: a@x.example\r\n\r\nB\r\n');
      const apart = key('To: a@x.example\r\nX-Other: 1\r\nTo: b@x.example\r\n\r\nB\r\n');
      expect(new Set([one, twoAB, twoBA]).size).toBe(3);
      expect(apart).toBe(twoAB);
    });

    it('hashes value bytes as they are, not as decoded text', () => {
      const a = mailKey(Buffer.concat([Buffer.from('Subject: caf'), Buffer.from([0xc3, 0xa9]), Buffer.from('\r\n\r\nB\r\n')]));
      const b = mailKey(Buffer.concat([Buffer.from('Subject: caf'), Buffer.from([0xe9]), Buffer.from('\r\n\r\nB\r\n')]));
      expect(a).not.toBe(b);
      expect(a).toBe(
        sha256(
          'frank-mail-key/1',
          Buffer.from([0]),
          u32(0),
          u32(0),
          u32(0),
          Buffer.concat([u32(1), u32(5), Buffer.from([0x63, 0x61, 0x66, 0xc3, 0xa9])]),
          u32(0),
          u32(0),
          u32(0),
          u32(0),
          'B\r\n',
        ),
      );
    });

    it('does not read a header after the section has ended', () => {
      expect(key('To: a@x.example\r\n\r\nSubject: in body\r\n')).not.toBe(
        key('To: a@x.example\r\nSubject: in body\r\n\r\n'),
      );
    });
  });

  describe('field boundaries', () => {
    it('changes when a byte moves between neighbouring fields', () => {
      const keys = [
        key('Subject: ab\r\n\r\nc\r\n'),
        key('Subject: a\r\n\r\nbc\r\n'),
        key('Subject: abc\r\n\r\n'),
        key('Subject:\r\n\r\nabc\r\n'),
        key('To: ab\r\nCc: c\r\n\r\n'),
        key('To: a\r\nCc: bc\r\n\r\n'),
        key('To: a\r\nTo: bc\r\n\r\n'),
        key('To: ab\r\nTo: c\r\n\r\n'),
        key('To: abc\r\n\r\n'),
        key('Cc: abc\r\n\r\n'),
      ];
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('cannot be steered by length bytes written into a value', () => {
      // One To of "a" + what a second To of "b" would hash as, against two real headers.
      const forged = Buffer.concat([Buffer.from('To: a'), u32(1), Buffer.from('b\r\n\r\n')]);
      expect(mailKey(forged)).not.toBe(key('To: a\r\nTo: b\r\n\r\n'));
    });
  });

  describe('body', () => {
    const body = (b: string): string => key(`Subject: s\r\n\r\n${b}`);

    it('reads CRLF and a lone LF as the same line ending', () => {
      expect(body('a\nb\n')).toBe(body('a\r\nb\r\n'));
      expect(body('a\r\nb\n')).toBe(body('a\r\nb\r\n'));
      expect(key('Subject: s\n\na\nb\n')).toBe(body('a\r\nb\r\n'));
    });

    it('removes trailing empty lines and supplies the final line ending', () => {
      const one = body('a\r\n');
      expect(body('a')).toBe(one);
      expect(body('a\r\n\r\n\r\n')).toBe(one);
      expect(body('a\n\n\n\n')).toBe(one);
      // Empty lines inside the body and before it are kept.
      expect(body('a\r\n\r\nb\r\n')).not.toBe(body('a\r\nb\r\n'));
      expect(body('\r\na\r\n')).not.toBe(one);
    });

    it('treats an empty body, a body of empty lines and no body at all as one CRLF', () => {
      const empty = body('');
      expect(body('\r\n')).toBe(empty);
      expect(body('\n\n\r\n')).toBe(empty);
      expect(key('Subject: s\r\n')).toBe(empty);
      expect(key('Subject: s')).toBe(empty);
      expect(empty).toBe(
        sha256('frank-mail-key/1', Buffer.from([0]), u32(0), u32(0), u32(0), u32(1), u32(1), 's', u32(0), u32(0), u32(0), u32(0), '\r\n'),
      );
    });

    it('keeps trailing spaces and whitespace-only lines: only empty lines are removed', () => {
      expect(body('a \r\n')).not.toBe(body('a\r\n'));
      expect(body('a\r\n \r\n')).not.toBe(body('a\r\n'));
      expect(body('a\r\n\t\r\n\r\n')).toBe(body('a\r\n\t\r\n'));
    });

    it('reads a lone CR as a line ending, like CRLF and a lone LF', () => {
      const crlf = body('a\r\nb\r\nc\r\n');
      expect(body('a\rb\rc\r')).toBe(crlf);
      expect(body('a\nb\nc\n')).toBe(crlf);
      expect(body('a\rb\nc')).toBe(crlf);
      expect(body('a\rb\r\nc\r\r\r')).toBe(crlf);
      expect(body('\r\r')).toBe(body(''));
      // LF CR is two line endings, not one.
      expect(body('a\n\rb')).toBe(body('a\r\n\r\nb\r\n'));
      expect(body('a\n\rb')).not.toBe(body('a\r\nb'));
    });

    it('reads CR CR LF as two line endings, exactly as the transport writes it', () => {
      const preimage = (bodyBytes: string): string =>
        sha256('frank-mail-key/1', Buffer.from([0]), u32(0), u32(0), u32(0), u32(1), u32(1), 's', u32(0), u32(0), u32(0), u32(0), bodyBytes);
      // In the middle: the line, one empty line, the next line.
      expect(body('a\r\r\nb')).toBe(preimage('a\r\n\r\nb\r\n'));
      expect(body('a\r\r\nb')).toBe(body('a\r\n\r\nb\r\n'));
      expect(body('a\r\r\nb')).not.toBe(body('a\r\nb\r\n'));
      expect(Buffer.from(encodeMessageData(latin1('a\r\r\nb'))).toString('latin1')).toBe('a\r\n\r\nb\r\n');
      // At the end: the empty line it makes is a trailing one and is removed.
      expect(body('a\r\r\n')).toBe(preimage('a\r\n'));
      expect(Buffer.from(encodeMessageData(latin1('a\r\r\n'))).toString('latin1')).toBe('a\r\n\r\n');
    });

    it('keys unsigned bytes with lone CRs in the body the same before and after the transport', () => {
      const head = 'From: ann <ann@frank.org>\r\nTo: bob@x.example\r\nSubject: s\r\n\r\n';
      const bodies = [
        'one\rtwo\rthree',
        'one\rtwo\nthree\r\nfour\r\rfive\n\rsix\r',
        '\rleading',
        'trailing\r\r\r',
        '.dot\r.\r..\rend\r',
        'a\r\r\nb\r\r\n',
        '\r',
      ];
      for (const b of bodies) {
        const queued = latin1(head + b);
        expect({ b, key: mailKey(asReceived(queued)) }).toEqual({ b, key: mailKey(queued) });
        expect({ b, key: mailKey(asReceived(queued, [])) }).toEqual({ b, key: mailKey(queued) });
      }
      // Random bodies over a small alphabet of line-ending bytes, dots and text.
      const alphabet = ['\r', '\n', '\r\n', '.', 'a', ' ', '\r\r\n'];
      let seed = 99;
      const next = (n: number): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      for (let round = 0; round < 3000; round++) {
        let b = '';
        for (let i = next(12); i > 0; i--) b += alphabet[next(alphabet.length)];
        const queued = latin1(head + b);
        expect({ b, key: mailKey(asReceived(queued)) }).toEqual({ b, key: mailKey(queued) });
      }
    });

    it('changes with any one visible body byte', () => {
      const text = 'line one\r\n.dot line\r\n\r\nlast';
      const base = body(text);
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '\r' || text[i] === '\n') continue;
        const changed = `${text.slice(0, i)}~${text.slice(i + 1)}`;
        expect(body(changed)).not.toBe(base);
      }
    });

    it('starts the body where the header section reader says it starts', () => {
      // A line with no colon ends the section and is itself body text.
      expect(key('Subject: s\r\nno colon here\r\n')).toBe(key('Subject: s\r\n\r\nno colon here\r\n'));
      // A whitespace-only line ends the section and is not body text.
      expect(key('Subject: s\r\n \t\r\nbody\r\n')).toBe(key('Subject: s\r\n\r\nbody\r\n'));
      const raw = latin1('Subject: s\r\n\r\nbody');
      expect(readHeaderSection(raw).bodyOffset).toBe(14);
    });
  });

  describe('a message as queued and as an SMTP receiver hands it over', () => {
    const { privateKey, publicKey } = generateDkimKeyPair();
    const signer = new DkimSigner({ domain: 'frank.org', selector: 'k1', privateKey });
    let ledger: CreditLedger;
    let delivery: OutboundEmailDelivery;

    beforeEach(() => {
      ledger = new CreditLedger(':memory:');
      delivery = new OutboundEmailDelivery({ gatewayDomain: 'frank.org', ledger });
    });

    const render = async (over: {
      bodyText: string;
      subject?: string;
      ccRecipients?: string[];
    }): Promise<string> => {
      const result = await delivery.processOutboundDirectMessage({
        conversationId: 'c1',
        frankMessageId: 'm1',
        senderFrankAddress: 'ann',
        recipientEmail: 'bob@x.example',
        ...over,
      });
      return result.renderedEmail;
    };

    const expectRoundTrip = (rendered: string): string => {
      const queued = utf8(signer.sign(rendered));
      const received = asReceived(queued, ['Received: from a by b', 'Received: from b by c\r\n\twith ESMTP']);
      expect(verifyDkimSignature(received, publicKey)).toBe(true);
      const k = mailKey(queued);
      expect(mailKey(received)).toBe(k);
      // Signing does not change the key: the unsigned rendering keys alike.
      expect(mailKey(utf8(rendered))).toBe(k);
      // Signature and trace headers are outside the key, wherever they stand.
      const text = Buffer.from(queued).toString('latin1');
      const signature = /^DKIM-Signature:.*\r\n/m.exec(text)![0];
      const signatureFirst = signature + text.replace(signature, '');
      expect(mailKey(latin1(signatureFirst))).toBe(k);
      expect(mailKey(asReceived(latin1(signatureFirst)))).toBe(k);
      expect(k).toMatch(HEX_64);
      return k;
    };

    it('holds for a plain rendered email, with and without Cc', async () => {
      const plain = expectRoundTrip(await render({ bodyText: 'Hello Bob' }));
      const withCc = expectRoundTrip(await render({ bodyText: 'Hello Bob', ccRecipients: ['cy@x.example'] }));
      expect(withCc).not.toBe(plain);
    });

    it('holds for a body with lone CR, lone LF and mixed line endings', async () => {
      expectRoundTrip(await render({ bodyText: 'one\rtwo\nthree\r\nfour\r\rfive\n\rsix\r' }));
    });

    it('holds for dot-led lines and a lone-dot line', async () => {
      const rendered = await render({ bodyText: '.leading dot\n..two dots\n.\nafter the dot line\n.' });
      const queued = utf8(signer.sign(rendered));
      // The model receiver must see the whole message: the dot line does not end it.
      expect(asReceived(queued).toString('latin1')).toContain('\r\n.\r\nafter the dot line\r\n');
      expectRoundTrip(rendered);
    });

    it('holds for a body with trailing blank lines and for one without a final line ending', async () => {
      const rendered = await render({ bodyText: 'x' });
      const a = expectRoundTrip(rendered);
      const b = expectRoundTrip(`${rendered}\n\n\n`);
      expect(b).toBe(a);
    });

    it('holds for a non-ASCII subject and body', async () => {
      expectRoundTrip(await render({ bodyText: 'caf\u00e9 \u2603 \ud83d\ude00', subject: 'Gr\u00fc\u00dfe' }));
    });

    it('holds for a folded References header and for a message with no optional header', () => {
      const references = Array.from({ length: 12 }, (_, i) => `<ref-${i}.aaaaaaaaaaaaaaaaaaaa@frank.org>`);
      const thread = renderThreadHeaders({ messageId: '<m9@frank.org>', inReplyTo: references[11], references });
      expect(thread).toMatch(/\r\n <ref-/);
      const head = 'From: ann <ann@frank.org>\nTo: bob@x.example\nSubject: s\nDate: Fri, 09 Oct 2026 10:00:00 GMT\n';
      const folded = expectRoundTrip(`${head}${thread}\nbody\n`);
      // The same References on one line is the same mail.
      const unfolded = thread.replace(/\r\n (?=<ref-)/g, ' ');
      expect(key(`${head}${unfolded}\nbody\n`)).toBe(folded);

      const bare = expectRoundTrip('From: ann <ann@frank.org>\nMessage-ID: <m9@frank.org>\n\nbody\n');
      expect(bare).not.toBe(folded);
    });

    it('holds for headers with no body and for a message that ends inside its headers', () => {
      expectRoundTrip('From: ann <ann@frank.org>\nSubject: s\n\n');
      const queued = latin1('From: ann <ann@frank.org>\r\nSubject: s');
      expect(mailKey(asReceived(queued))).toBe(mailKey(queued));
    });

    it('gives another key when the receiver was handed an altered message', async () => {
      const queued = utf8(signer.sign(await render({ bodyText: 'Hello Bob' })));
      const received = asReceived(queued).toString('latin1');
      const k = mailKey(queued);
      expect(mailKey(latin1(received.replace('Hello Bob', 'Hello Bob\r\n-- \r\nlist footer')))).not.toBe(k);
      expect(mailKey(latin1(received.replace('To: bob@', 'To: rob@')))).not.toBe(k);
    });
  });

  describe('any input', () => {
    it('gives 64 lower-case hex characters for arbitrary bytes and never throws', () => {
      const inputs: Uint8Array[] = [
        new Uint8Array(0),
        latin1('\r'),
        latin1('\n'),
        latin1(' leading continuation\r\nSubject: s\r\n'),
        latin1(':\r\n'),
        latin1('Subject\r\n'),
        new Uint8Array(1024).fill(0),
        new Uint8Array(1024).fill(0xff),
        new Uint8Array(1024).fill(0x0d),
        new Uint8Array(1024).fill(0x0a),
        new Uint8Array(1024).fill(0x3a),
      ];
      for (let i = 0; i < 300; i++) inputs.push(randomBytes(i * 7));
      for (let i = 0; i < 100; i++) {
        inputs.push(Buffer.concat([Buffer.from('From: a\r\nSubject: b\r\n'), randomBytes(i * 5)]));
      }
      for (const input of inputs) expect(mailKey(input)).toMatch(HEX_64);
    });

    it('reads a view into a larger buffer by its own bounds', () => {
      const whole = Buffer.from(`XXXX${VECTOR_MAIL}YYYY`, 'latin1');
      const view = new Uint8Array(whole.buffer, whole.byteOffset + 4, VECTOR_MAIL.length);
      expect(mailKey(view)).toBe(VECTOR_KEY);
    });

    it('hashes a 5 MB message quickly, whatever its shape', () => {
      const size = 5 * 1024 * 1024;
      const head = Buffer.from('From: a@x.example\r\nSubject: big\r\n\r\n');
      const shapes: Record<string, Buffer> = {
        'random body': Buffer.concat([head, randomBytes(size)]),
        'one line': Buffer.concat([head, Buffer.alloc(size, 0x61)]),
        'only LF': Buffer.concat([head, Buffer.alloc(size, 0x0a)]),
        'only CR': Buffer.concat([head, Buffer.alloc(size, 0x0d)]),
        'alternating text and blank lines': Buffer.concat([head, Buffer.from('a\n\n'.repeat(size / 3))]),
        'header lines only': Buffer.from('X-H: v\r\n'.repeat(size / 8)),
        'To lines only': Buffer.from('To: v\n'.repeat(size / 6)),
        'one endless continuation': Buffer.concat([Buffer.from('Subject: s\r\n'), Buffer.from(' x\r\n'.repeat(size / 4))]),
        'spaces before a colon': Buffer.concat([Buffer.from('x'), Buffer.alloc(size, 0x20), Buffer.from('y:\r\n')]),
        'spaces as a value': Buffer.concat([Buffer.from('Subject:'), Buffer.alloc(size, 0x20), Buffer.from('y \r\n')]),
        'no line ending at all': randomBytes(size).map((b) => (b === 0x0a ? 0x20 : b)) as Buffer,
      };
      for (const [shape, input] of Object.entries(shapes)) {
        const started = process.hrtime.bigint();
        const k = mailKey(input);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        expect(k).toMatch(HEX_64);
        expect({ shape, slow: ms > 2000 }).toEqual({ shape, slow: false });
      }
      expect(mailKey(shapes['only LF'])).toBe(key('From: a@x.example\r\nSubject: big\r\n'));
    });
  });
});

describe('emailItemKey', () => {
  const ITEM: Required<EmailItemKeyInput> = {
    messageId: '<f1@frank.org>',
    inReplyTo: '<p1@x.example>',
    references: ['<r1@x.example>', '<p1@x.example>'],
    to: [{ address: 'ann@x.example' }, { address: 'bob@x.example' }],
    cc: [{ address: 'cy@x.example' }],
    subject: 'Hi',
    textBody: 'Hello',
    htmlBody: '<p>Hello</p>',
  };
  const base = emailItemKey(ITEM);
  const S = (s: string): Buffer => Buffer.concat([u32(Buffer.byteLength(s, 'utf8')), Buffer.from(s, 'utf8')]);

  it('gives the contract vector (section 21.2)', () => {
    const vector = { messageId: '<f1@frank.org>', to: [{ address: 'ann@x.example' }], subject: 'Hi', textBody: 'Hello' };
    expect(emailItemKey(vector)).toBe('4df5da7f51f90a63034017ee9fcd31f0f68d21edf69eaee6f98dac826587aae9');
    expect(emailItemKey(vector)).toBe(
      sha256(
        'frank-email-item-key/1',
        Buffer.from([0]),
        S('<f1@frank.org>'),
        Buffer.from([0]), // inReplyTo undefined
        u32(0), // references
        u32(1),
        S('ann@x.example'),
        u32(0), // cc
        S('Hi'),
        S('Hello'),
        Buffer.from([0]), // htmlBody undefined
      ),
    );
  });

  it('equals the hash of the full preimage written out by hand', () => {
    expect(base).toBe(
      sha256(
        'frank-email-item-key/1',
        Buffer.from([0]),
        S('<f1@frank.org>'),
        Buffer.from([1]),
        S('<p1@x.example>'),
        u32(2),
        S('<r1@x.example>'),
        S('<p1@x.example>'),
        u32(2),
        S('ann@x.example'),
        S('bob@x.example'),
        u32(1),
        S('cy@x.example'),
        S('Hi'),
        S('Hello'),
        Buffer.from([1]),
        S('<p>Hello</p>'),
      ),
    );
    expect(base).toMatch(HEX_64);
  });

  it('is the same for a re-sealed copy: seal, time, conversation and unkeyed fields do not count', () => {
    const sealed = (seal: object): EmailItemKeyInput => ({ ...ITEM, ...seal }) as EmailItemKeyInput;
    const first = sealed({
      type: 'email',
      from: { address: 'ann@frank.org', name: 'Ann' },
      receivedTime: 1_000,
      payloadDigest: 'aa'.repeat(32),
      frankMessageId: 'sealed-1',
      conversationId: 'c1',
      stampValue: '5',
    });
    const second = sealed({
      type: 'email',
      from: { address: 'other@frank.org' },
      replyTo: { address: 'r@x.example' },
      bcc: [{ address: 'h@x.example' }],
      attachments: [{ filename: 'a.txt' }],
      receivedTime: 2_000,
      payloadDigest: 'bb'.repeat(32),
      frankMessageId: 'sealed-2',
      conversationId: 'c2',
      stampValue: '9',
    });
    expect(emailItemKey(first)).toBe(base);
    expect(emailItemKey(second)).toBe(base);
    const named = { ...ITEM, to: ITEM.to.map((p, i) => ({ ...p, name: `Name ${i}` })) };
    expect(emailItemKey(named)).toBe(base);
  });

  it.each<[string, Partial<EmailItemKeyInput>]>([
    ['messageId', { messageId: '<f2@frank.org>' }],
    ['inReplyTo', { inReplyTo: '<p2@x.example>' }],
    ['inReplyTo removed', { inReplyTo: undefined }],
    ['references value', { references: ['<r1@x.example>', '<p2@x.example>'] }],
    ['references order', { references: ['<p1@x.example>', '<r1@x.example>'] }],
    ['references shortened', { references: ['<r1@x.example>'] }],
    ['references removed', { references: undefined }],
    ['to address', { to: [{ address: 'ann@x.example' }, { address: 'rob@x.example' }] }],
    ['to order', { to: [{ address: 'bob@x.example' }, { address: 'ann@x.example' }] }],
    ['to case', { to: [{ address: 'Ann@x.example' }, { address: 'bob@x.example' }] }],
    ['to repeated', { to: [...ITEM.to, { address: 'bob@x.example' }] }],
    ['cc address', { cc: [{ address: 'di@x.example' }] }],
    ['cc removed', { cc: undefined }],
    ['subject', { subject: 'Hi ' }],
    ['textBody', { textBody: 'Hello.' }],
    ['htmlBody', { htmlBody: '<p>Hello!</p>' }],
    ['htmlBody removed', { htmlBody: undefined }],
  ])('changes with %s', (_label, change) => {
    expect(emailItemKey({ ...ITEM, ...change })).not.toBe(base);
  });

  it('tells an absent optional string from an empty one, and reads an absent list as an empty one', () => {
    const bare: EmailItemKeyInput = { messageId: '<f1@frank.org>', subject: '', textBody: '' };
    const k = emailItemKey(bare);
    expect(emailItemKey({ ...bare, inReplyTo: '' })).not.toBe(k);
    expect(emailItemKey({ ...bare, htmlBody: '' })).not.toBe(k);
    expect(emailItemKey({ ...bare, inReplyTo: '' })).not.toBe(emailItemKey({ ...bare, htmlBody: '' }));
    expect(emailItemKey({ ...bare, references: [], to: [], cc: [] })).toBe(k);
    expect(emailItemKey({ ...bare, references: [''] })).not.toBe(k);
  });

  it('changes when a byte or an entry moves between neighbouring fields', () => {
    const bare: EmailItemKeyInput = { messageId: '<f1@frank.org>', subject: 'ab', textBody: 'c' };
    const keys = [
      emailItemKey(bare),
      emailItemKey({ ...bare, subject: 'a', textBody: 'bc' }),
      emailItemKey({ ...bare, subject: 'abc', textBody: '' }),
      emailItemKey({ ...bare, subject: '', textBody: 'abc' }),
      emailItemKey({ ...bare, textBody: '', htmlBody: 'c' }),
      emailItemKey({ ...bare, to: [{ address: 'x@y.z' }] }),
      emailItemKey({ ...bare, cc: [{ address: 'x@y.z' }] }),
      emailItemKey({ ...bare, references: ['x@y.z'] }),
      emailItemKey({ ...bare, inReplyTo: 'x@y.z' }),
      emailItemKey({ ...bare, to: [{ address: 'x@y.z' }, { address: 'q@y.z' }] }),
      emailItemKey({ ...bare, to: [{ address: 'x@y.z' }], cc: [{ address: 'q@y.z' }] }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('measures lengths in UTF-8 bytes', () => {
    const bare: EmailItemKeyInput = { messageId: '<f1@frank.org>', subject: 'Gr\u00fc\u00dfe \ud83d\ude00', textBody: '' };
    expect(Buffer.byteLength(bare.subject, 'utf8')).toBe(12);
    expect(emailItemKey(bare)).toBe(
      sha256('frank-email-item-key/1', Buffer.from([0]), S('<f1@frank.org>'), Buffer.from([0]), u32(0), u32(0), u32(0), S(bare.subject), S(''), Buffer.from([0])),
    );
  });

  it('differs from the mail key of the same text: the two tags keep the keys apart', () => {
    expect(emailItemKey({ messageId: '', subject: '', textBody: '' })).not.toBe(mailKey(new Uint8Array(0)));
  });

  it('refuses a field of the wrong type instead of hashing it', () => {
    const bad = (change: object): EmailItemKeyInput => ({ ...ITEM, ...change }) as EmailItemKeyInput;
    expect(() => emailItemKey(bad({ subject: 7 }))).toThrow(TypeError);
    expect(() => emailItemKey(bad({ textBody: undefined }))).toThrow(TypeError);
    expect(() => emailItemKey(bad({ htmlBody: null }))).toThrow(TypeError);
    expect(() => emailItemKey(bad({ references: '<r1@x.example>' }))).toThrow(TypeError);
    expect(() => emailItemKey(bad({ to: [{ address: [1, 2] }] }))).toThrow(TypeError);
    expect(() => emailItemKey(bad({ messageId: Buffer.from('x') }))).toThrow(TypeError);
  });

  it('hashes a large item quickly', () => {
    const started = process.hrtime.bigint();
    const k = emailItemKey({ ...ITEM, textBody: 'x'.repeat(5 * 1024 * 1024), htmlBody: '\u00e9'.repeat(524288) });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2000);
    expect(k).toMatch(HEX_64);
  });
});
