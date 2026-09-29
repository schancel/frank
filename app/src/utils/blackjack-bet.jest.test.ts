import { parseEther } from 'ethers'

import { parseBetInput } from './blackjack-bet'

describe('parseBetInput', () => {
  it.each(['0.01', '0.1', '1', '1.0', ' 0.5 ', '.5'])('accepts %s', v => {
    expect(parseBetInput(parseEther, v)).toMatchObject({ ok: true })
  })
  it('returns exact wei', () => {
    expect(parseBetInput(parseEther, '0.1')).toEqual({
      ok: true,
      wei: 10n ** 17n,
    })
  })
  it.each([
    ['0', /greater than zero/],
    ['0.0', /greater than zero/],
    ['-1', /greater than zero/],
    ['-0.5', /greater than zero/],
    ['0.009', /minimum/],
    ['1.01', /maximum/],
    ['1000', /maximum/],
    ['', /plain decimal/],
    ['abc', /plain decimal/],
    ['NaN', /plain decimal/],
    ['Infinity', /plain decimal/],
    ['1e3', /plain decimal/],
    ['0.1.2', /plain decimal/],
  ])('rejects %j', (v, msg) => {
    const r = parseBetInput(parseEther, v)
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(msg)
  })
  it('rejects amounts with more than 18 decimals via the parser', () => {
    expect(parseBetInput(parseEther, '0.1234567890123456789').ok).toBe(false)
  })
})
