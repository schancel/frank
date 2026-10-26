import { encodeCanonical } from '@frank/codec'

import { MessageItemDecodeError } from '@frank/cashweb/message-items/registry'
import {
  describePluginContract,
  registryWith,
  standaloneDecodeContext,
} from '../shared/plugin-contract.testutil'
import { initContactStatePlugin } from './plugin'

const CONTACT = '0x' + 'b2'.repeat(20)

describePluginContract({
  type: 'contact-state',
  init: initContactStatePlugin,
  samples: [
    {
      item: {
        type: 'contact-state',
        address: CONTACT,
        present: true,
        setAt: 1760000000000,
      },
      preview: 'Contact state',
    },
    {
      item: {
        type: 'contact-state',
        address: CONTACT,
        present: false,
        setAt: 1760000000001,
      },
      preview: 'Contact state',
    },
  ],
})

describe('a contact-state note', () => {
  const registry = registryWith('contact-state', initContactStatePlugin)

  it('is refused on receive without the time it was set', () => {
    const bytes = encodeCanonical(
      new Map<bigint, string | boolean>([
        [0n, CONTACT],
        [1n, true],
      ]),
    )
    expect(() =>
      registry.decodeItem('contact-state', bytes, standaloneDecodeContext()),
    ).toThrow(MessageItemDecodeError)
  })

  it('is refused on receive when the address is not one', () => {
    const bytes = encodeCanonical(
      new Map<bigint, string | boolean | number>([
        [0n, 'not an address'],
        [1n, true],
        [2n, 1760000000000],
      ]),
    )
    expect(() =>
      registry.decodeItem('contact-state', bytes, standaloneDecodeContext()),
    ).toThrow(MessageItemDecodeError)
  })
})
