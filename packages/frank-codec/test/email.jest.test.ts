import {
  FrankCodecError,
  defaultContext,
  validateFrame,
  encodeEmailMessageItem,
  isEmailMessageItemFrame,
  projectEmailMessageItem,
  validateEmailMessageItem,
  TYPE_EMAIL_MESSAGE_ITEM,
  MAX_EMAIL_MESSAGE_ITEM_FRAME_BYTES,
  MAX_EMAIL_RECIPIENTS,
  MAX_EMAIL_ATTACHMENTS,
} from '../src'
import type {
  CanonicalEmailMessageItem,
  EmailParty,
  EmailAttachment,
  AccountRef,
} from '../src'
import { bytesOf, fr } from '../fixtures/builders'

const ctx = defaultContext()

function sampleAccount(seed: number): AccountRef {
  const k = new Uint8Array(33)
  k[0] = 0x02
  k.set(bytesOf(32, seed), 1)
  return { keyType: 1, keyBytes: k }
}

describe('Type 26: Email Message Item', () => {
  const aliceParty: EmailParty = {
    address: 'alice@example.com',
    name: 'Alice Smith',
    frankAccount: sampleAccount(1),
  }

  const bobParty: EmailParty = {
    address: 'bob@frank.org',
    name: 'Bob Jones',
    frankAccount: sampleAccount(2),
  }

  const charlieParty: EmailParty = {
    address: 'charlie@external.com',
    name: 'Charlie Brown',
  }

  const sampleAttachment: EmailAttachment = {
    filename: 'document.pdf',
    contentType: 'application/pdf',
    content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
  }

  it('encodes, validates, and projects a comprehensive email message item', () => {
    const email: CanonicalEmailMessageItem = {
      messageId: '<msg-12345@example.com>',
      from: aliceParty,
      to: [bobParty],
      cc: [charlieParty],
      subject: 'Quarterly Review & Budget',
      textBody: 'Hi Bob, please review the attached PDF.\n\nBest,\nAlice',
      htmlBody:
        '<p>Hi Bob, please review the attached PDF.</p><p>Best,<br>Alice</p>',
      inReplyTo: '<msg-00000@example.com>',
      references: ['<msg-00000@example.com>', '<msg-00001@example.com>'],
      attachments: [sampleAttachment],
      replyTo: aliceParty,
    }

    const frameBytes = encodeEmailMessageItem(email)
    expect(frameBytes.length).toBeGreaterThan(0)
    expect(frameBytes.length).toBeLessThanOrEqual(
      MAX_EMAIL_MESSAGE_ITEM_FRAME_BYTES,
    )

    const validated = validateEmailMessageItem(frameBytes, ctx)
    expect(validated.typeId).toBe(TYPE_EMAIL_MESSAGE_ITEM)
    expect(isEmailMessageItemFrame(validated)).toBe(true)

    const typed = validated.typed!
    expect(typed.type).toBe(26)
    expect(typed.messageId).toBe('<msg-12345@example.com>')
    expect(typed.from.address).toBe('alice@example.com')
    expect(typed.from.name).toBe('Alice Smith')
    expect(typed.from.frankAccount?.keyType).toBe(1)
    expect(typed.from.frankAccount?.keyBytes).toEqual(
      aliceParty.frankAccount!.keyBytes,
    )

    expect(typed.to).toHaveLength(1)
    expect(typed.to[0].address).toBe('bob@frank.org')
    expect(typed.to[0].name).toBe('Bob Jones')
    expect(typed.to[0].frankAccount?.keyBytes).toEqual(
      bobParty.frankAccount!.keyBytes,
    )

    expect(typed.cc).toHaveLength(1)
    expect(typed.cc![0].address).toBe('charlie@external.com')
    expect(typed.cc![0].name).toBe('Charlie Brown')
    expect(typed.cc![0].frankAccount).toBeUndefined()

    expect(typed.subject).toBe('Quarterly Review & Budget')
    expect(typed.textBody).toContain('Hi Bob')
    expect(typed.htmlBody).toContain('<p>Hi Bob')
    expect(typed.inReplyTo).toBe('<msg-00000@example.com>')
    expect(typed.references).toEqual([
      '<msg-00000@example.com>',
      '<msg-00001@example.com>',
    ])

    expect(typed.attachments).toHaveLength(1)
    expect(typed.attachments![0].filename).toBe('document.pdf')
    expect(typed.attachments![0].contentType).toBe('application/pdf')
    expect(typed.attachments![0].content).toEqual(sampleAttachment.content)

    expect(typed.replyTo?.address).toBe('alice@example.com')

    const projected = projectEmailMessageItem(validated)
    expect(projected.messageId).toBe(typed.messageId)
    expect(projected.subject).toBe(typed.subject)
  })

  it('supports minimal 1-on-1 email without optional fields', () => {
    const minimalEmail: CanonicalEmailMessageItem = {
      messageId: '<simple-1@example.com>',
      from: { address: 'sender@example.com' },
      to: [{ address: 'recipient@example.com' }],
      subject: 'Hello',
      textBody: 'World',
    }

    const frameBytes = encodeEmailMessageItem(minimalEmail)
    const validated = validateEmailMessageItem(frameBytes, ctx)

    expect(validated.typed?.messageId).toBe('<simple-1@example.com>')
    expect(validated.typed?.from.address).toBe('sender@example.com')
    expect(validated.typed?.from.name).toBeUndefined()
    expect(validated.typed?.to[0].address).toBe('recipient@example.com')
    expect(validated.typed?.cc).toBeUndefined()
    expect(validated.typed?.htmlBody).toBeUndefined()
    expect(validated.typed?.inReplyTo).toBeUndefined()
    expect(validated.typed?.references).toBeUndefined()
    expect(validated.typed?.attachments).toBeUndefined()
    expect(validated.typed?.replyTo).toBeUndefined()
  })

  it('rejects a 400-character CJK subject before producing a frame', () => {
    expect(() =>
      encodeEmailMessageItem({
        messageId: '<test@example.com>',
        from: aliceParty,
        to: [bobParty],
        subject: '界'.repeat(400),
        textBody: '',
      }),
    ).toThrow('subject must be 0..1024 UTF-8 bytes')
  })

  describe('UTF-8 text bounds match the decoder', () => {
    const fields: Array<{
      field: string
      min: number
      max: number
      set: (email: CanonicalEmailMessageItem, value: string) => void
    }> = [
      {
        field: 'subject',
        min: 0,
        max: 1024,
        set: (e, v) => {
          e.subject = v
        },
      },
      {
        field: 'textBody',
        min: 0,
        max: 262144,
        set: (e, v) => {
          e.textBody = v
        },
      },
      {
        field: 'htmlBody',
        min: 0,
        max: 524288,
        set: (e, v) => {
          e.htmlBody = v
        },
      },
      {
        field: 'party address',
        min: 3,
        max: 320,
        set: (e, v) => {
          e.from.address = v
        },
      },
      {
        field: 'party name',
        min: 1,
        max: 256,
        set: (e, v) => {
          e.to[0].name = v
        },
      },
      {
        field: 'attachment filename',
        min: 1,
        max: 256,
        set: (e, v) => {
          e.attachments![1].filename = v
        },
      },
      {
        field: 'attachment contentType',
        min: 1,
        max: 128,
        set: (e, v) => {
          e.attachments![1].contentType = v
        },
      },
      {
        field: 'attachment contentId',
        min: 1,
        max: 128,
        set: (e, v) => {
          e.attachments![1].contentId = v
        },
      },
    ]

    function email(): CanonicalEmailMessageItem {
      return {
        messageId: '<msg@a.b>',
        from: { address: 'a@b' },
        to: [{ address: 'c@d' }],
        cc: [{ address: 'e@f', name: '界' }],
        replyTo: { address: 'g@h', name: '😀' },
        subject: '',
        textBody: '',
        attachments: [
          {
            filename: 'first',
            contentType: 'text/plain',
            content: new Uint8Array([1]),
          },
          {
            filename: 'second',
            contentType: 'text/plain',
            // raw-cbor-key: attachment bytes, not a map entry
            content: new Uint8Array([2, 3]),
          },
        ],
      }
    }

    describe.each(fields)('$field', ({ field, min, max, set }) => {
      it.each(['a', '界', '😀'])(
        'round-trips at the byte limit and rejects one byte over (%s)',
        character => {
          const width = new TextEncoder().encode(character).length
          const boundary =
            character.repeat(Math.floor(max / width)) + 'a'.repeat(max % width)
          const item = email()
          set(item, boundary)
          const frame = encodeEmailMessageItem(item)
          if (field === 'htmlBody') {
            // The enclosing CBOR text budget remains stricter than the HTML field bound.
            expect(() => validateEmailMessageItem(frame)).toThrow(
              'text string longer than 262144',
            )
            set(item, character.repeat(Math.floor(262144 / width)))
          }
          expect(
            validateEmailMessageItem(encodeEmailMessageItem(item)).typed,
          ).toMatchObject(item)
          set(item, boundary + 'a')
          expect(() => encodeEmailMessageItem(item)).toThrow(
            `${field} must be ${min}..${max} UTF-8 bytes`,
          )
        },
      )

      it('preserves the empty-string bound', () => {
        const item = email()
        set(item, '')
        if (min === 0) {
          expect(() =>
            validateEmailMessageItem(encodeEmailMessageItem(item)),
          ).not.toThrow()
        } else {
          expect(() => encodeEmailMessageItem(item)).toThrow(
            `${field} must be ${min}..${max} UTF-8 bytes`,
          )
        }
      })
    })

    it('counts a CJK address by bytes at the lower bound', () => {
      const item = email()
      item.from.address = '界'
      expect(
        validateEmailMessageItem(encodeEmailMessageItem(item)).typed.from
          .address,
      ).toBe('界')
    })

    describe.each([
      {
        field: 'messageId',
        wireKey: 0,
        set: (e: CanonicalEmailMessageItem, v: string) => {
          e.messageId = v
        },
        setRaw: (m: Map<number, unknown>, v: string) => {
          m.set(0, v)
        },
      },
      {
        field: 'inReplyTo',
        wireKey: 7,
        set: (e: CanonicalEmailMessageItem, v: string) => {
          e.inReplyTo = v
        },
        setRaw: (m: Map<number, unknown>, v: string) => {
          m.set(7, v)
        },
      },
      {
        field: 'reference',
        wireKey: 8,
        set: (e: CanonicalEmailMessageItem, v: string) => {
          e.references = ['<first@a.b>', v]
        },
        setRaw: (m: Map<number, unknown>, v: string) => {
          m.set(8, ['<first@a.b>', v])
        },
      },
    ])('RFC 5322 Message-ID grammar ($field)', ({ field, set, setRaw }) => {
      it('accepts exact 5-byte and 256-byte <local@domain> IDs and rejects out-of-range or malformed IDs in both encoder and decoder', () => {
        const minValid = '<a@b>'
        const maxValid = `<${'a'.repeat(252)}@b>`
        expect(minValid.length).toBe(5)
        expect(maxValid.length).toBe(256)
        for (const valid of [minValid, maxValid]) {
          const item = email()
          set(item, valid)
          const encoded = encodeEmailMessageItem(item)
          expect(validateEmailMessageItem(encoded).typed).toMatchObject(item)
        }

        const overMax = `<${'a'.repeat(253)}@b>`
        expect(overMax.length).toBe(257)
        for (const outOfBounds of ['', '<a>', overMax]) {
          const item = email()
          set(item, outOfBounds)
          expect(() => encodeEmailMessageItem(item)).toThrow(
            `${field} must be 5..256 UTF-8 bytes`,
          )
        }

        const baseFrame = validateEmailMessageItem(
          encodeEmailMessageItem(email()),
        )
        const baseMap = baseFrame.payload as Map<bigint, unknown>
        for (const badId of [
          '',
          '<a>',
          overMax,
          'message',
          'local@domain',
          '<missing-at>',
          '<two@at@signs>',
          '<has space@domain>',
          '<nested<@domain>',
          '<界@example.com>',
        ]) {
          const item = email()
          set(item, badId)
          expect(() => encodeEmailMessageItem(item)).toThrow(FrankCodecError)

          const rawMap = new Map<number, unknown>()
          for (const [k, v] of baseMap) rawMap.set(Number(k), v)
          setRaw(rawMap, badId)
          const rawFrame = fr(TYPE_EMAIL_MESSAGE_ITEM, rawMap as any)
          expect(() => validateFrame(rawFrame, ctx)).toThrow(FrankCodecError)
        }
      })
    })
  })

  it('rejects invalid recipient arrays or addresses', () => {
    expect(() =>
      encodeEmailMessageItem({
        messageId: '<test@example.com>',
        from: { address: 'a@b.com' },
        to: [], // Empty 'to' list
        subject: 'Sub',
        textBody: 'Body',
      }),
    ).toThrow('to must contain 1..64 recipients')

    expect(() =>
      encodeEmailMessageItem({
        messageId: '<test@example.com>',
        from: { address: 'ab' }, // Too short address (< 3 chars)
        to: [{ address: 'valid@example.com' }],
        subject: 'Sub',
        textBody: 'Body',
      }),
    ).toThrow('party address must be 3..320 UTF-8 bytes')
  })

  it('rejects frames with unallocated key types in frankAccount', () => {
    const invalidAccount: AccountRef = {
      keyType: 99, // Unallocated key type
      keyBytes: new Uint8Array(33),
    }

    const email: CanonicalEmailMessageItem = {
      messageId: '<test@example.com>',
      from: { address: 'sender@example.com', frankAccount: invalidAccount },
      to: [{ address: 'rcpt@example.com' }],
      subject: 'Test',
      textBody: 'Body',
    }

    const frameBytes = encodeEmailMessageItem(email)
    expect(() => validateEmailMessageItem(frameBytes, ctx)).toThrow(
      FrankCodecError,
    )
  })
})
