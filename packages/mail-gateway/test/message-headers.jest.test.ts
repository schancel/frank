import {
  assertHeaderValue,
  parseMessageId,
  parseMessageIdList,
  readHeaderSection,
  readThreadHeaders,
  renderThreadHeaders,
} from '../src/rfc/message-headers';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const idOfLength = (n: number): string => `<${'a'.repeat(n - 4)}@b>`;

describe('message-headers (S1)', () => {
  describe('contract rows', () => {
    it('reads a normal ID', () => {
      const r = readThreadHeaders(
        enc('Message-ID: <abc.123@example.com>\r\nSubject: hi\r\n\r\nbody <x@y>'),
      );
      expect(r).toEqual({ ok: true, messageId: '<abc.123@example.com>', references: [] });
    });

    it('reads an ID with surrounding comment text and keeps it exactly', () => {
      expect(parseMessageId('(note) <A.b@Example.COM> (trailing)')).toBe('<A.b@Example.COM>');
      const r = readThreadHeaders(
        enc('Message-ID: (c) <Id@Host> (d)\r\nIn-Reply-To: (x) <P@H> (y)\r\n\r\n'),
      );
      expect(r).toEqual({ ok: true, messageId: '<Id@Host>', inReplyTo: '<P@H>', references: [] });
    });

    it('matches header names case-insensitively', () => {
      const r = readThreadHeaders(
        enc('MESSAGE-id: <a@b>\r\nin-reply-to: <p@q>\r\nREFERENCES: <r@s>\r\n\r\n'),
      );
      expect(r).toEqual({
        ok: true,
        messageId: '<a@b>',
        inReplyTo: '<p@q>',
        references: ['<r@s>'],
      });
    });

    it('unfolds a folded References header', () => {
      const r = readThreadHeaders(
        enc('Message-ID: <a@b>\r\nReferences: <r1@x>\r\n <r2@x>\r\n\t<r3@x>\r\n\r\n'),
      );
      expect(r).toEqual({
        ok: true,
        messageId: '<a@b>',
        references: ['<r1@x>', '<r2@x>', '<r3@x>'],
      });
    });

    it('rejects a duplicate Message-ID', () => {
      expect(readThreadHeaders(enc('Message-ID: <a@b>\r\nMessage-ID: <c@d>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'duplicate_header',
      });
    });

    it('accepts a missing Message-ID with messageId undefined', () => {
      const r = readThreadHeaders(enc('Subject: x\r\n\r\n'));
      expect(r).toEqual({ ok: true, references: [] });
      expect(r.ok && r.messageId).toBeUndefined();
    });

    it('rejects an ID containing a space', () => {
      expect(parseMessageId('<a b@c>')).toBeUndefined();
      expect(readThreadHeaders(enc('Message-ID: <a b@c>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
      expect(() => renderThreadHeaders({ messageId: '<a b@c>', references: [] })).toThrow();
    });

    it('rejects an ID of 257 characters and accepts 256 and 5', () => {
      expect(parseMessageId(idOfLength(257))).toBeUndefined();
      expect(parseMessageId(idOfLength(256))).toBe(idOfLength(256));
      expect(parseMessageId('<a@b>')).toBe('<a@b>');
      expect(readThreadHeaders(enc(`Message-ID: ${idOfLength(257)}\r\n\r\n`))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
      expect(() => renderThreadHeaders({ messageId: idOfLength(257), references: [] })).toThrow();
    });

    it('renders 70 references and reads them back equal', () => {
      const references = Array.from(
        { length: 70 },
        (_, i) => `<ref-${i}.${'x'.repeat(i % 9)}@h.example>`,
      );
      const text = renderThreadHeaders({
        messageId: '<m@h.example>',
        inReplyTo: references[69],
        references,
      });
      const r = readThreadHeaders(enc(`${text}Subject: s\r\n\r\n`));
      expect(r).toEqual({
        ok: true,
        messageId: '<m@h.example>',
        inReplyTo: references[69],
        references,
      });
      for (const line of text.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    });

    it('rejects a value with CRLF in assertHeaderValue', () => {
      expect(() => assertHeaderValue('a\r\nBcc: x@y')).toThrow();
    });
  });

  describe('grammar and identity', () => {
    it('never normalises: case, brackets and surrounding text are kept exactly', () => {
      expect(parseMessageId('<AbC@HoSt>')).toBe('<AbC@HoSt>');
      expect(parseMessageId('<AbC@HoSt>')).not.toBe(parseMessageId('<abc@host>'));
      expect(parseMessageId('abc@host')).toBeUndefined();
    });

    it('requires exactly one @ with non-empty sides and no angle brackets inside', () => {
      for (const bad of ['<@b>', '<a@>', '<a@@b>', '<a@b@c>', '<a>', '<a@b', '<a<b@c>', '']) {
        expect(parseMessageId(bad)).toBeUndefined();
      }
      expect(parseMessageId('<a<b@c>')).toBeUndefined();
    });

    it('accepts the whole allowed character set and refuses control, space and non-ASCII', () => {
      const allowed =
        '!"#$%&\'()*+,-./0123456789:;=?ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
      expect(parseMessageId(`<${allowed}@${allowed}>`)).toBe(`<${allowed}@${allowed}>`);
      for (const bad of ['\x00', '\x1f', ' ', '\x7f', 'é', '\t']) {
        expect(parseMessageId(`<a${bad}b@c>`)).toBeUndefined();
      }
    });

    it('two distinct IDs never compare equal after processing', () => {
      const ids = ['<a@b>', '<A@b>', '<a@B>', '<a@b.>', '<a.@b>', '<aa@b>'];
      const processed = ids.map((id) => {
        const r = readThreadHeaders(enc(`Message-ID: ${id}\r\n\r\n`));
        return r.ok ? r.messageId : undefined;
      });
      expect(processed).toEqual(ids);
      expect(new Set(processed).size).toBe(ids.length);
      const rendered = ids.map((id) => renderThreadHeaders({ messageId: id, references: [] }));
      expect(new Set(rendered).size).toBe(ids.length);
    });

    it('parseMessageIdList returns every match in order, duplicates kept, junk ignored', () => {
      expect(parseMessageIdList('x <a@b>, junk <c d@e> (cm) <A@B> <a@b> <toolong')).toEqual([
        '<a@b>',
        '<A@B>',
        '<a@b>',
      ]);
      expect(parseMessageIdList('')).toEqual([]);
    });
  });

  describe('readThreadHeaders', () => {
    it('reads only the header section', () => {
      const r = readThreadHeaders(
        enc('Message-ID: <a@b>\r\n\r\nMessage-ID: <dup@b>\r\nIn-Reply-To: <body@b>\r\n'),
      );
      expect(r).toEqual({ ok: true, messageId: '<a@b>', references: [] });
    });

    it('accepts bare LF line endings and stops at the first empty line', () => {
      expect(
        readThreadHeaders(enc('Message-ID: <a@b>\nIn-Reply-To: <p@q>\n\nIn-Reply-To: <z@z>')),
      ).toEqual({ ok: true, messageId: '<a@b>', inReplyTo: '<p@q>', references: [] });
    });

    it('rejects duplicate In-Reply-To and References, case-insensitively', () => {
      const dup = { ok: false, reason: 'duplicate_header' };
      expect(readThreadHeaders(enc('In-Reply-To: <a@b>\r\nin-reply-to: <c@d>\r\n\r\n'))).toEqual(
        dup,
      );
      expect(readThreadHeaders(enc('References: <a@b>\r\nreferences: <c@d>\r\n\r\n'))).toEqual(
        dup,
      );
    });

    it('rejects a duplicate even when one copy is malformed', () => {
      expect(readThreadHeaders(enc('Message-ID: <a@b>\r\nMessage-ID: junk\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'duplicate_header',
      });
    });

    it('takes the first ID of In-Reply-To', () => {
      const r = readThreadHeaders(enc('In-Reply-To: <first@x> <second@x>\r\n\r\n'));
      expect(r).toEqual({ ok: true, inReplyTo: '<first@x>', references: [] });
    });

    it('rejects an empty or ID-less Message-ID', () => {
      for (const v of ['', ' ', 'no id here', 'a@b']) {
        expect(readThreadHeaders(enc(`Message-ID:${v}\r\n\r\n`))).toEqual({
          ok: false,
          reason: 'bad_message_id',
        });
      }
    });

    it('does not accept an ID folded in the middle', () => {
      expect(readThreadHeaders(enc('Message-ID: <a\r\n b@c>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
    });

    it('does not read bodies, Subject or lookalike header names', () => {
      const r = readThreadHeaders(
        enc('X-Message-ID: <x@y>\r\nSubject: Re: <s@s>\r\nMessage-ID-Extra: <e@e>\r\n\r\n'),
      );
      expect(r).toEqual({ ok: true, references: [] });
    });

    it('does not trim or fold case in values', () => {
      const r = readThreadHeaders(enc('Message-ID:\t  <MiXed@Case>  \r\n\r\n'));
      expect(r).toEqual({ ok: true, messageId: '<MiXed@Case>', references: [] });
    });

    it('works on a Uint8Array view with an offset', () => {
      const whole = enc('JUNKMessage-ID: <a@b>\r\n\r\n');
      expect(readThreadHeaders(whole.subarray(4))).toEqual({
        ok: true,
        messageId: '<a@b>',
        references: [],
      });
    });
  });

  describe('interpretations pinned where the contract is silent', () => {
    it('Message-ID header carrying several IDs is rejected, not guessed', () => {
      expect(readThreadHeaders(enc('Message-ID: <a@b> <c@d>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
    });

    it('In-Reply-To without a valid ID means no parent, not an error', () => {
      expect(readThreadHeaders(enc('In-Reply-To: not an id\r\n\r\n'))).toEqual({
        ok: true,
        references: [],
      });
    });

    it('References with no valid ID is an empty list', () => {
      expect(readThreadHeaders(enc('References: nothing <bad id@x>\r\n\r\n'))).toEqual({
        ok: true,
        references: [],
      });
    });

    it('a trailing-space header name is still the same header (duplicate detection)', () => {
      expect(readThreadHeaders(enc('Message-ID: <a@b>\r\nMessage-ID : <c@d>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'duplicate_header',
      });
    });

    it('no bound on the number of references is applied', () => {
      const ids = Array.from({ length: 500 }, (_, i) => `<r${i}@h>`);
      const text = renderThreadHeaders({ messageId: '<m@h>', references: ids });
      const r = readThreadHeaders(enc(`${text}\r\n`));
      expect(r.ok && r.references).toEqual(ids);
    });

    it('duplicate references are kept in order when rendering and reading', () => {
      const ids = ['<a@b>', '<c@d>', '<a@b>'];
      const text = renderThreadHeaders({ messageId: '<m@h>', references: ids });
      const r = readThreadHeaders(enc(`${text}\r\n`));
      expect(r.ok && r.references).toEqual(ids);
    });
  });

  describe('renderThreadHeaders', () => {
    it('renders Message-ID, In-Reply-To and References with CRLF in that order', () => {
      expect(
        renderThreadHeaders({
          messageId: '<m@h>',
          inReplyTo: '<p@h>',
          references: ['<a@h>', '<p@h>'],
        }),
      ).toBe('Message-ID: <m@h>\r\nIn-Reply-To: <p@h>\r\nReferences: <a@h> <p@h>\r\n');
    });

    it('omits In-Reply-To and References when absent', () => {
      expect(renderThreadHeaders({ messageId: '<m@h>', references: [] })).toBe(
        'Message-ID: <m@h>\r\n',
      );
    });

    it('folds with CRLF plus exactly one space and never exceeds 78 characters', () => {
      const ids = Array.from(
        { length: 20 },
        (_, i) => `<id-${String(i).padStart(2, '0')}@host.example>`,
      );
      const text = renderThreadHeaders({ messageId: '<m@h>', references: ids });
      const lines = text.split('\r\n');
      expect(lines.pop()).toBe('');
      expect(lines.length).toBeGreaterThan(2);
      for (const l of lines.slice(2)) {
        expect(l[0]).toBe(' ');
        expect(l[1]).not.toBe(' ');
      }
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(78);
    });

    it('lets a single long ID exceed 78 characters rather than splitting it', () => {
      const long = idOfLength(200);
      const text = renderThreadHeaders({
        messageId: '<m@h>',
        references: ['<a@h>', long, '<b@h>'],
      });
      expect(text).toContain(`\r\n ${long}\r\n`);
      const r = readThreadHeaders(enc(`${text}\r\n`));
      expect(r.ok && r.references).toEqual(['<a@h>', long, '<b@h>']);
    });

    it('throws on any invalid ID in any position', () => {
      expect(() => renderThreadHeaders({ messageId: 'm@h', references: [] })).toThrow();
      expect(() =>
        renderThreadHeaders({ messageId: '<m@h>', inReplyTo: '<p h@x>', references: [] }),
      ).toThrow();
      expect(() =>
        renderThreadHeaders({ messageId: '<m@h>', inReplyTo: '', references: [] }),
      ).toThrow();
      expect(() =>
        renderThreadHeaders({ messageId: '<m@h>', references: ['<a@h>', '<a@h>\r\nBcc: x'] }),
      ).toThrow();
      expect(() => renderThreadHeaders({ messageId: '<m@h> <n@h>', references: [] })).toThrow();
      expect(() => renderThreadHeaders({ messageId: ' <m@h>', references: [] })).toThrow();
    });

    it('round-trips messageId and parent exactly, including case', () => {
      const h = {
        messageId: '<Up.Per@Host>',
        inReplyTo: '<LoWer@host>',
        references: ['<A@b>', '<a@b>'],
      };
      const r = readThreadHeaders(enc(`${renderThreadHeaders(h)}\r\n`));
      expect(r).toEqual({ ok: true, ...h });
    });
  });

  describe('assertHeaderValue', () => {
    it('accepts printable ASCII and non-control Unicode', () => {
      expect(() => assertHeaderValue('')).not.toThrow();
      expect(() => assertHeaderValue('Re: hello ~ world é')).not.toThrow();
    });

    it('rejects every code unit below 0x20 and 0x7f, and only those', () => {
      for (let c = 0; c < 0x20; c++) {
        expect(() => assertHeaderValue(`a${String.fromCharCode(c)}b`)).toThrow();
      }
      expect(() => assertHeaderValue('a\x7fb')).toThrow();
      expect(() => assertHeaderValue('\x20\x7e\x80')).not.toThrow();
    });
  });

  describe('change A: whole-token validation', () => {
    it('does not extract an ID from inside a rejected token', () => {
      expect(parseMessageId('<<abc@h>>')).toBeUndefined();
      expect(parseMessageId('<a b<c@d>')).toBeUndefined();
      expect(parseMessageId('<a<b@c>')).toBeUndefined();
      expect(parseMessageIdList('<a<b@c> <x@y>')).toEqual(['<x@y>']);
    });

    it('skips an oversized whole token and keeps the next valid one', () => {
      expect(parseMessageId(`${idOfLength(257)} <a@b>`)).toBe('<a@b>');
      expect(parseMessageId('<toolong <a@b>')).toBeUndefined();
    });

    it('must not merge two distinct Message-IDs that share an interior substring', () => {
      const a = readThreadHeaders(enc('Message-ID: <"x<y"@z>\r\n\r\n'));
      const b = readThreadHeaders(enc('Message-ID: <"w<y"@z>\r\n\r\n'));
      expect(a).toEqual({ ok: false, reason: 'bad_message_id' });
      expect(b).toEqual({ ok: false, reason: 'bad_message_id' });
    });

    it('does not turn an In-Reply-To interior substring into a parent', () => {
      expect(readThreadHeaders(enc('In-Reply-To: <"x<p"@z>\r\n\r\n'))).toEqual({
        ok: true,
        references: [],
      });
    });

    it('references skip invalid whole tokens and keep valid ones', () => {
      const r = readThreadHeaders(enc('References: <"x<y"@z> <a@b> <<c@d>> <e@f>\r\n\r\n'));
      expect(r).toEqual({ ok: true, references: ['<a@b>', '<e@f>'] });
    });
  });

  describe('change B: Message-ID is exactly one valid token', () => {
    it('rejects an invalid token followed by a valid one', () => {
      expect(readThreadHeaders(enc('Message-ID: <x y@z> <b@c>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
    });

    it('rejects two valid tokens and a single invalid token', () => {
      expect(readThreadHeaders(enc('Message-ID: <a@b> <c@d>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
      expect(readThreadHeaders(enc('Message-ID: <x y@z>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
    });

    it('rejects a tokenless value (kept: bad_message_id)', () => {
      expect(readThreadHeaders(enc('Message-ID: plain@text\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
    });
  });

  describe('change C: header section end', () => {
    it('stops at a non-continuation line without a colon', () => {
      const r = readThreadHeaders(
        enc('Subject: s\r\nthis is body text\r\nIn-Reply-To: <body@x>\r\n\r\n'),
      );
      expect(r).toEqual({ ok: true, references: [] });
    });

    it('treats a whitespace-only line as the end of the section', () => {
      expect(readThreadHeaders(enc('Subject: s\r\n \r\nMessage-ID: <body@x>'))).toEqual({
        ok: true,
        references: [],
      });
      expect(readThreadHeaders(enc('Subject: s\r\n\t\r\nMessage-ID: <body@x>'))).toEqual({
        ok: true,
        references: [],
      });
    });

    it('treats a bare-CR-only line as empty and not as a separator', () => {
      expect(readThreadHeaders(enc('Subject: s\r\r\n\r\r\nMessage-ID: <body@x>\r\n'))).toEqual({
        ok: true,
        references: [],
      });
      // A lone CR inside a value is not a line separator: In-Reply-To is not read as a header
      // (and its token makes the Message-ID value hold two tokens).
      expect(readThreadHeaders(enc('Message-ID: <a@b>\rIn-Reply-To: <p@q>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
      expect(readThreadHeaders(enc('Subject: s\rIn-Reply-To: <p@q>\r\n\r\n'))).toEqual({
        ok: true,
        references: [],
      });
    });

    it('reads nothing from empty input', () => {
      expect(readThreadHeaders(new Uint8Array(0))).toEqual({ ok: true, references: [] });
    });

    it('reads nothing after a leading blank line', () => {
      expect(readThreadHeaders(enc('\r\nMessage-ID: <a@b>\r\n\r\n'))).toEqual({
        ok: true,
        references: [],
      });
    });

    it('reads nothing when the first line is a continuation', () => {
      expect(readThreadHeaders(enc(' Message-ID: <a@b>\r\nIn-Reply-To: <p@q>\r\n\r\n'))).toEqual({
        ok: true,
        references: [],
      });
    });

    it('does not attach a continuation line after the section ended', () => {
      const r = readThreadHeaders(enc('Subject: s\r\nbody line\r\n References: <z@z>\r\n'));
      expect(r).toEqual({ ok: true, references: [] });
    });

    it('does not read Resent-Message-ID or Original-Message-ID as Message-ID', () => {
      const r = readThreadHeaders(
        enc('Resent-Message-ID: <r@x>\r\nOriginal-Message-ID: <o@x>\r\n\r\n'),
      );
      expect(r).toEqual({ ok: true, references: [] });
    });

    it('is a duplicate when one copy is empty', () => {
      expect(readThreadHeaders(enc('Message-ID: <a@b>\r\nMessage-ID:\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'duplicate_header',
      });
    });

    it('handles mixed CRLF and LF endings', () => {
      const r = readThreadHeaders(
        enc('Message-ID: <a@b>\nIn-Reply-To: <p@q>\r\nReferences: <r1@x>\n <r2@x>\r\n\n'),
      );
      expect(r).toEqual({
        ok: true,
        messageId: '<a@b>',
        inReplyTo: '<p@q>',
        references: ['<r1@x>', '<r2@x>'],
      });
    });
  });

  describe('change D: quoted phrases and comments', () => {
    it('skips an ID inside a quoted phrase in In-Reply-To', () => {
      const r = readThreadHeaders(enc('In-Reply-To: "msg <q@x> from Bob" <real@y>\r\n\r\n'));
      expect(r).toEqual({ ok: true, inReplyTo: '<real@y>', references: [] });
    });

    it('skips IDs inside nested comments and escaped characters', () => {
      expect(parseMessageIdList('(a (nested <n@x>) <c@x>) <ok@y>')).toEqual(['<ok@y>']);
      expect(parseMessageIdList('(a \\) <e@x>) <ok@y>')).toEqual(['<ok@y>']);
      expect(parseMessageIdList('"a \\" <e@x>" <ok@y>')).toEqual(['<ok@y>']);
    });

    it('extracts nothing after an unbalanced quote or parenthesis', () => {
      expect(parseMessageIdList('<a@b> "oops <c@d>')).toEqual(['<a@b>']);
      expect(parseMessageIdList('<a@b> (oops <c@d>')).toEqual(['<a@b>']);
      expect(parseMessageId('"oops <c@d>')).toBeUndefined();
    });

    it('does not strip quote or paren characters that are part of an ID', () => {
      expect(parseMessageId('<a"b@c>')).toBe('<a"b@c>');
      expect(parseMessageId('<a(b@c>')).toBe('<a(b@c>');
    });

    it('strips a comment before counting Message-ID tokens', () => {
      const r = readThreadHeaders(enc('Message-ID: (was <old@x>) <new@y>\r\n\r\n'));
      expect(r).toEqual({ ok: true, messageId: '<new@y>', references: [] });
    });

    it('rejects a Message-ID with an unbalanced quote even after a valid token (stricter wins)', () => {
      expect(readThreadHeaders(enc('Message-ID: <a@b> "tail\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
    });
  });

  describe('non-ASCII bytes', () => {
    it('rejects raw byte 0xE1 inside the brackets and does not collapse it to ASCII', () => {
      const bytes = Uint8Array.from([
        ...enc('Message-ID: <a'),
        0xe1,
        ...enc('b@c>\r\n\r\n'),
      ]);
      expect(readThreadHeaders(bytes)).toEqual({ ok: false, reason: 'bad_message_id' });
      // 0xE1 & 0x7f is 'a': an ascii-masking decoder would wrongly accept <aab@c>.
      const lookalike = Uint8Array.from([...enc('In-Reply-To: <'), 0xe1, ...enc('@c>\r\n\r\n')]);
      expect(readThreadHeaders(lookalike)).toEqual({ ok: true, references: [] });
    });

    it('rejects a UTF-8 e-acute inside the brackets', () => {
      expect(readThreadHeaders(enc('Message-ID: <café@x>\r\n\r\n'))).toEqual({
        ok: false,
        reason: 'bad_message_id',
      });
      expect(readThreadHeaders(enc('References: <café@x> <cafe@x>\r\n\r\n'))).toEqual({
        ok: true,
        references: ['<cafe@x>'],
      });
    });
  });

  describe('change E: rendering', () => {
    it('round-trips a 256-character ID as Message-ID, parent and reference', () => {
      const id = idOfLength(256);
      const text = renderThreadHeaders({ messageId: id, inReplyTo: id, references: [id] });
      expect(readThreadHeaders(enc(`${text}\r\n`))).toEqual({
        ok: true,
        messageId: id,
        inReplyTo: id,
        references: [id],
      });
    });

    it('moves a first reference of 67 to 77 characters to a continuation line', () => {
      for (const len of [67, 68, 77]) {
        const id = idOfLength(len);
        const text = renderThreadHeaders({ messageId: '<m@h>', references: [id, '<b@h>'] });
        expect(text).toContain(`References:\r\n ${id}`);
        for (const line of text.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
        const r = readThreadHeaders(enc(`${text}\r\n`));
        expect(r.ok && r.references).toEqual([id, '<b@h>']);
      }
    });

    it('keeps a first reference of 66 characters on the References line', () => {
      const id = idOfLength(66);
      const text = renderThreadHeaders({ messageId: '<m@h>', references: [id] });
      expect(text).toContain(`References: ${id}\r\n`);
      expect('References: '.length + 66).toBe(78);
    });

    it('leaves a first reference longer than 77 characters on the References line', () => {
      const id = idOfLength(78);
      const text = renderThreadHeaders({ messageId: '<m@h>', references: [id] });
      expect(text).toContain(`References: ${id}\r\n`);
      const r = readThreadHeaders(enc(`${text}\r\n`));
      expect(r.ok && r.references).toEqual([id]);
    });
  });

  describe('Message-ID: nothing but one token and comments', () => {
    const bad = { ok: false, reason: 'bad_message_id' };
    it('must not merge two distinct RFC-valid IDs that share an early-closing prefix', () => {
      expect(readThreadHeaders(enc('Message-ID: <"a@b>\\""@d>\r\n\r\n'))).toEqual(bad);
      expect(readThreadHeaders(enc('Message-ID: <"a@b>\\""@e>\r\n\r\n'))).toEqual(bad);
    });

    it('rejects text after the token', () => {
      expect(readThreadHeaders(enc('Message-ID: <a@b>c@d>\r\n\r\n'))).toEqual(bad);
      expect(readThreadHeaders(enc('Message-ID: <a@b>junk\r\n\r\n'))).toEqual(bad);
    });

    it('rejects a quoted phrase or free text around the token', () => {
      expect(readThreadHeaders(enc('Message-ID: "phrase" <a@b>\r\n\r\n'))).toEqual(bad);
      expect(readThreadHeaders(enc('Message-ID: junk <a@b>\r\n\r\n'))).toEqual(bad);
    });

    it('still accepts balanced comments and spaces or tabs around the token', () => {
      const ok = { ok: true, messageId: '<a@b>', references: [] };
      expect(readThreadHeaders(enc('Message-ID: (comment) <a@b> (another)\r\n\r\n'))).toEqual(ok);
      expect(readThreadHeaders(enc('Message-ID: \t  <a@b> \t \r\n\r\n'))).toEqual(ok);
      expect(readThreadHeaders(enc('Message-ID: (a (nested) \\) c)<a@b>\r\n\r\n'))).toEqual(ok);
    });

    it('rejects an unbalanced comment around the token', () => {
      expect(readThreadHeaders(enc('Message-ID: (open <a@b>\r\n\r\n'))).toEqual(bad);
      expect(readThreadHeaders(enc('Message-ID: <a@b> (open\r\n\r\n'))).toEqual(bad);
    });
  });

  describe('known residual in reference headers', () => {
    it('keeps tokens before an unbalanced point (needs a full RFC parser to fix)', () => {
      // KNOWN RESIDUAL: this is the interior of one exotic RFC-valid ID; pinned, not endorsed.
      const r = readThreadHeaders(enc('In-Reply-To: <"a> <b@c> "@d>\r\n\r\n'));
      expect(r).toEqual({ ok: true, inReplyTo: '<b@c>', references: [] });
    });
  });

  describe('readHeaderSection', () => {
    const section = (s: string) => readHeaderSection(Buffer.from(s, 'latin1'));

    it('returns every field in order with the offset just after the empty line', () => {
      expect(section('From: a@b\r\nSubject: hi\r\n\r\nbody')).toEqual({
        fields: [
          ['from', ' a@b'],
          ['subject', ' hi'],
        ],
        bodyOffset: 26,
      });
      expect(section('From: a@b\nSubject: hi\n\nbody')).toEqual({
        fields: [
          ['from', ' a@b'],
          ['subject', ' hi'],
        ],
        bodyOffset: 23,
      });
    });

    it('lowercases names, drops spaces and tabs before the colon and keeps values as written', () => {
      expect(section('SUBJECT \t:  Hi There \r\nX-a:b:c\r\nEmpty:\r\n\r\n').fields).toEqual([
        ['subject', '  Hi There '],
        ['x-a', 'b:c'],
        ['empty', ''],
      ]);
    });

    it('appends continuation lines as written, with no separator', () => {
      expect(section('Subject: Hi\r\n there\r\n\tagain\r\nMessage-ID:\n <a@b>\n\n').fields).toEqual([
        ['subject', ' Hi there\tagain'],
        ['message-id', ' <a@b>'],
      ]);
    });

    it('returns each occurrence of a repeated header', () => {
      expect(section('To: a\r\nReceived: x\r\nTo: b\r\nto: c\r\n\r\n').fields).toEqual([
        ['to', ' a'],
        ['received', ' x'],
        ['to', ' b'],
        ['to', ' c'],
      ]);
    });

    it('ends at a whitespace-only or CR-only line, with the offset after that line', () => {
      for (const blank of [' ', '\t', ' \t ', '\r', ' \r\t']) {
        const text = `A: b\r\n${blank}\r\nC: d\r\n`;
        expect(section(text)).toEqual({ fields: [['a', ' b']], bodyOffset: 6 + blank.length + 2 });
        expect(section(`A: b\n${blank}\nC: d\n`).bodyOffset).toBe(5 + blank.length + 1);
      }
    });

    it('ends at a line with no colon, or with a colon first, which is itself body text', () => {
      expect(section('A: b\r\nno colon\r\nC: d\r\n')).toEqual({ fields: [['a', ' b']], bodyOffset: 6 });
      expect(section('A: b\n: x\n')).toEqual({ fields: [['a', ' b']], bodyOffset: 5 });
      expect(section('no colon at all')).toEqual({ fields: [], bodyOffset: 0 });
    });

    it('ends at a continuation line with no field before it, which is itself body text', () => {
      expect(section(' x: y\r\nA: b\r\n')).toEqual({ fields: [], bodyOffset: 0 });
      expect(section('\tx\r\n')).toEqual({ fields: [], bodyOffset: 0 });
    });

    it('gives the input length when the input ends inside the headers', () => {
      expect(section('A: b\r\n')).toEqual({ fields: [['a', ' b']], bodyOffset: 6 });
      expect(section('A: b')).toEqual({ fields: [['a', ' b']], bodyOffset: 4 });
      expect(section('A: b\r\n c')).toEqual({ fields: [['a', ' b c']], bodyOffset: 8 });
      expect(section('A: b\r\n  ')).toEqual({ fields: [['a', ' b']], bodyOffset: 8 });
      expect(section('')).toEqual({ fields: [], bodyOffset: 0 });
      expect(section('\r\n')).toEqual({ fields: [], bodyOffset: 2 });
      expect(section('\n\nbody')).toEqual({ fields: [], bodyOffset: 1 });
    });

    it('keeps a lone CR and a CR before CRLF inside the line', () => {
      expect(section('A: b\rC: d\r\n\r\n').fields).toEqual([['a', ' b\rC: d']]);
      expect(section('A: b\r\r\nC: d\r\n\r\n').fields).toEqual([
        ['a', ' b\r'],
        ['c', ' d'],
      ]);
      // A CR that ends the input is not a line ending.
      expect(section('A: b\r')).toEqual({ fields: [['a', ' b\r']], bodyOffset: 5 });
    });

    it('keeps bytes one-to-one and reads a view by its own bounds', () => {
      const whole = Buffer.from([0x58, 0x58, 0x41, 0x3a, 0xc3, 0xa9, 0xff, 0x0a, 0x0a, 0x62, 0x58]);
      const view = new Uint8Array(whole.buffer, whole.byteOffset + 2, 8);
      expect(readHeaderSection(view)).toEqual({ fields: [['a', 'Ã©ÿ']], bodyOffset: 7 });
    });

    it('agrees with a split-based reading of the same bytes, and the offset lands on the boundary', () => {
      // The reader as it was before it reported an offset.
      const bySplit = (text: string): Array<[string, string]> => {
        const fields: Array<[string, string]> = [];
        for (const line of text.split(/\r\n|\n/)) {
          if (/^[ \t\r]*$/.test(line)) break;
          if (line[0] === ' ' || line[0] === '\t') {
            const last = fields[fields.length - 1];
            if (!last) break;
            last[1] += line;
            continue;
          }
          const colon = line.indexOf(':');
          if (colon <= 0) break;
          fields.push([line.slice(0, colon).replace(/[ \t]+$/, '').toLowerCase(), line.slice(colon + 1)]);
        }
        return fields;
      };
      const alphabet = ['A', 'b', ':', ' ', '\t', '\r', '\n', '\r\n', 'X-y: z', '\n ', '\r\n\r\n'];
      let seed = 12345;
      const next = (n: number): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      for (let round = 0; round < 5000; round++) {
        let text = '';
        for (let i = next(14); i > 0; i--) text += alphabet[next(alphabet.length)];
        const { fields, bodyOffset } = section(text);
        expect(fields).toEqual(bySplit(text));
        expect(bodyOffset).toBeGreaterThanOrEqual(0);
        expect(bodyOffset).toBeLessThanOrEqual(text.length);
        // The offset is the start of the input, its end, or the start of a line.
        expect(bodyOffset === 0 || bodyOffset === text.length || text[bodyOffset - 1] === '\n').toBe(true);
        // Nothing after the offset was read as a header: the bytes before it give the same fields.
        expect(section(text.slice(0, bodyOffset)).fields).toEqual(fields);
      }
    });

    it('reads a long run of spaces before a colon in linear time', () => {
      const raw = Buffer.concat([Buffer.from('x'), Buffer.alloc(2 * 1024 * 1024, 0x20), Buffer.from('y:v\r\n\r\n')]);
      const started = process.hrtime.bigint();
      const { fields, bodyOffset } = readHeaderSection(raw);
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2000);
      expect(fields).toHaveLength(1);
      expect(fields[0][1]).toBe('v');
      expect(bodyOffset).toBe(raw.length);
    });
  });
});
