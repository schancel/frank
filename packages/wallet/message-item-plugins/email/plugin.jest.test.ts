import { encodeEmailMessageItem } from '@frank/codec'
import type { EmailItem } from '@frank/cashweb/types/messages'

import {
  describePluginContract,
  registryWith,
} from '../shared/plugin-contract.testutil'
import { initEmailPlugin } from './plugin'

const minimal: EmailItem = {
  type: 'email',
  messageId: '<simple-1@example.com>',
  from: { address: 'sender@example.com' },
  to: [{ address: 'recipient@example.com' }],
  subject: 'Hello',
  textBody: 'Body text',
}
const full: EmailItem = {
  type: 'email',
  messageId: '<msg-12345@example.com>',
  from: { address: 'alice@example.com', name: 'Alice Smith' },
  to: [{ address: 'bob@frank.org', name: 'Bob Jones' }],
  cc: [{ address: 'charlie@external.com', name: 'Charlie Brown' }],
  subject: '',
  textBody: 'x'.repeat(80),
  htmlBody: '<p>x</p>',
  inReplyTo: '<msg-00000@example.com>',
  references: ['<msg-00000@example.com>', '<msg-00001@example.com>'],
  attachments: [
    {
      filename: 'document.pdf',
      contentType: 'application/pdf',
      content: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    },
  ],
  replyTo: { address: 'alice@example.com', name: 'Alice Smith' },
}

describePluginContract({
  type: 'email',
  init: initEmailPlugin,
  samples: [
    // Decoding gives the codec's projection, which also carries its `unknownFields` maps -- the
    // same object the receive path produces today.
    { item: minimal, preview: '✉️ Hello: Body text', decodedHasExtras: true },
    {
      item: full,
      preview: `✉️ (No Subject): ${'x'.repeat(60)}`,
      decodedHasExtras: true,
    },
  ],
})

describe('email wire bytes', () => {
  const registry = registryWith('email', initEmailPlugin)

  it('are the bytes the canonical path writes today', () => {
    for (const item of [minimal, full]) {
      expect(registry.encodeItem(item).bytes).toEqual(
        encodeEmailMessageItem({
          messageId: item.messageId,
          from: item.from,
          to: item.to,
          cc: item.cc,
          subject: item.subject,
          textBody: item.textBody,
          htmlBody: item.htmlBody,
          inReplyTo: item.inReplyTo,
          references: item.references,
          attachments: item.attachments,
          replyTo: item.replyTo,
        }),
      )
    }
  })

  it('does not put bcc on the wire, as today', () => {
    const withBcc: EmailItem = {
      ...minimal,
      bcc: [{ address: 'hidden@example.com' }],
    }
    expect(registry.encodeItem(withBcc).bytes).toEqual(
      registry.encodeItem(minimal).bytes,
    )
  })
})
