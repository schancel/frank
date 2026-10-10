import { reservedUsernamesTomlLine } from '../src/reserved-usernames'

const key = (first: number, fill: number) =>
  Uint8Array.from([first, ...new Array(32).fill(fill)])

describe('reservedUsernamesTomlLine', () => {
  it('renders one inline table line for the relay directory section', () => {
    expect(
      reservedUsernamesTomlLine([
        { username: 'qwen', compressedPubKey: key(2, 0xab) },
        { username: '@Liars-Dice', compressedPubKey: key(3, 0x01) },
      ]),
    ).toBe(
      `reserved_usernames = { "qwen" = "02${'ab'.repeat(
        32,
      )}", "liars-dice" = "03${'01'.repeat(32)}" }`,
    )
  })

  it('is empty when there is nothing to reserve', () => {
    expect(reservedUsernamesTomlLine([])).toBe('')
  })

  it('refuses a name the relay would refuse, a key that is not a key, and a repeated name', () => {
    expect(() =>
      reservedUsernamesTomlLine([
        { username: 'ab', compressedPubKey: key(2, 1) },
      ]),
    ).toThrow('Not a valid username')
    expect(() =>
      reservedUsernamesTomlLine([
        { username: 'has space', compressedPubKey: key(2, 1) },
      ]),
    ).toThrow('Not a valid username')
    expect(() =>
      reservedUsernamesTomlLine([
        { username: 'qwen', compressedPubKey: key(4, 1) },
      ]),
    ).toThrow('Not a compressed public key')
    expect(() =>
      reservedUsernamesTomlLine([
        { username: 'qwen', compressedPubKey: new Uint8Array(20) },
      ]),
    ).toThrow('Not a compressed public key')
    expect(() =>
      reservedUsernamesTomlLine([
        { username: 'qwen', compressedPubKey: key(2, 1) },
        { username: 'QWEN', compressedPubKey: key(3, 1) },
      ]),
    ).toThrow('reserved twice')
  })
})
