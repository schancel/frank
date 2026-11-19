/**
 * The table-join authorization (`frank/table-join/v1`, `table-join.ts`): pinned digest and
 * signature for a public test key, and refusal of the same signature for any other joiner, lock,
 * table, game, contract or network, or from any other account.
 */
import { Wallet } from 'ethers'
import {
  TABLE_JOIN_DOMAIN,
  signTableJoinWith,
  tableJoinDigest,
  verifyTableJoin,
  type TableJoinAuthorization,
} from './table-join'

/** A public test key (the scalar 1), nobody's account. */
const account = new Wallet('0x' + '01'.padStart(64, '0'))
const auth: TableJoinAuthorization = {
  chainIdentifier: 'monad-testnet',
  contract: '0x67C3231b8F28309a84004643C592FFc9eAd939cB',
  game: 'poker',
  tableId: '0f'.repeat(16),
  lockId: '0x' + 'ef'.repeat(32),
  joiner: '0x' + '12'.repeat(20),
}

/** Pinned: changing any of these is a new authorization version (AGENTS.md §6). */
const GOLDEN = {
  digest: '0x4c8cda9968c92329801c8c9a833eaffaf66a1d71aef6190fbd14e18cd2a60495',
  signature:
    '0xa8535501f220b69207dfa131d62873251ae42455f629457b38967403ec203454641308f30fe07798b07a0fc3336782a6d0818611c6c4b46d75c77abbb915fcf71c',
}

describe('table-join authorization (frank/table-join/v1)', () => {
  it('is the pinned digest and signature', () => {
    expect(TABLE_JOIN_DOMAIN).toBe('frank/table-join/v1')
    expect(tableJoinDigest(auth)).toBe(GOLDEN.digest)
    const signature = signTableJoinWith(account, auth)
    expect(signature).toBe(GOLDEN.signature)
    expect(verifyTableJoin(auth, account.address, signature)).toBe(true)
    // The lock id's letter case does not change what is signed.
    expect(
      tableJoinDigest({ ...auth, lockId: auth.lockId.toUpperCase().replace('0X', '0x') }),
    ).toBe(GOLDEN.digest)
  })

  it.each([
    ['another joiner', { joiner: '0x' + '34'.repeat(20) }],
    ['another lock', { lockId: '0x' + 'ee'.repeat(32) }],
    ['another table', { tableId: '0e'.repeat(16) }],
    ['another game', { game: 'liars-dice' }],
    ['another contract', { contract: '0x' + 'ab'.repeat(20) }],
    ['another network', { chainIdentifier: 'monad-regtest' }],
  ])('the signature does not authorize %s', (_, change) => {
    const signature = signTableJoinWith(account, auth)
    expect(verifyTableJoin({ ...auth, ...change }, account.address, signature)).toBe(false)
  })

  it('is refused for another account, and for malformed signatures', () => {
    const signature = signTableJoinWith(account, auth)
    expect(verifyTableJoin(auth, '0x' + '22'.repeat(20), signature)).toBe(false)
    expect(verifyTableJoin(auth, account.address, '0x1234')).toBe(false)
    expect(verifyTableJoin(auth, account.address, signature.slice(0, -2))).toBe(false)
    expect(() => tableJoinDigest({ ...auth, tableId: 'zz' })).toThrow()
  })
})
