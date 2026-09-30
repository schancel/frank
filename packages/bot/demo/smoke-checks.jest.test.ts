import { MessageItem } from '@frank/cashweb/types/messages'

import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { classifyReply } from './smoke-checks'

const text = (t: string): MessageItem[] => [{ type: 'text', text: t }]

describe('classifyReply', () => {
  it('qwen must answer in labelled stub mode', () => {
    expect(classifyReply('qwen', text(`${STUB_REPLY_PREFIX} You said: "hi"`)).ok).toBe(true)
    expect(classifyReply('qwen', text('Welcome to Frank!')).ok).toBe(false)
    expect(classifyReply('qwen', []).detail).toMatch(/nothing/)
  })

  it('vendor must send a non-empty catalog', () => {
    const catalog = (n: number): MessageItem[] => [
      {
        type: 'digital-goods',
        action: 'catalog',
        catalog: Array.from({ length: n }, (_, i) => ({
          itemId: `i${i}`,
          description: 'd',
          priceWei: '1',
        })),
      },
    ]
    expect(classifyReply('vendor', catalog(2)).ok).toBe(true)
    expect(classifyReply('vendor', catalog(0)).ok).toBe(false)
    expect(classifyReply('vendor', text('hi')).ok).toBe(false)
  })

  it('raffle must announce a round', () => {
    expect(
      classifyReply('raffle', [{ type: 'raffle', raffleId: 'r', action: 'announce' }]).ok,
    ).toBe(true)
    expect(classifyReply('raffle', [{ type: 'raffle', raffleId: 'r', action: 'draw' }]).ok).toBe(
      false,
    )
  })

  it('blackjack must return the tagged dealer error', () => {
    expect(
      classifyReply('blackjack', text('Blackjack: deal is a dealer-only action [game="g"]')).ok,
    ).toBe(true)
    expect(classifyReply('blackjack', text('something else')).ok).toBe(false)
  })

  it('an unknown bot fails closed', () => {
    expect(classifyReply('mystery', text('x')).ok).toBe(false)
  })
})
