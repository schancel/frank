import { SigningKey, getBytes } from 'ethers'

import { canonicalStampDestination } from '@frank/cashweb/relay/canonical-dm-stamp'

import { paymentsToSelf } from './canonical-dm'

const NETWORK = 'monad-testnet'
const key = (hex: string) => ({
  keyType: 1 as const,
  keyBytes: getBytes(SigningKey.computePublicKey('0x' + hex.repeat(32), true)),
})
const mine = key('11')
const previous = key('22')
const someoneElse = key('33')
const sharedPoint = key('44').keyBytes
const child = (stampKey: ReturnType<typeof key>, childIndex: number) => ({
  network: NETWORK,
  childIndex,
  address: canonicalStampDestination({
    network: NETWORK,
    stampKey,
    sharedPoint,
    childIndex,
  }).address,
})
const self = { stampKey: mine, previousStamp: null } as any

describe('paymentsToSelf', () => {
  it("keeps a payment to the wallet's own stamp child address", () => {
    const paid = [child(mine, 0), child(mine, 1)]
    expect(paymentsToSelf(NETWORK, self, sharedPoint, paid)).toEqual(paid)
  })

  it('drops a payment the sender addressed to a key of its own', () => {
    const paid = [child(mine, 0), child(someoneElse, 1)]
    expect(paymentsToSelf(NETWORK, self, sharedPoint, paid)).toEqual([paid[0]])
  })

  it('drops a payment whose address is the child of another index or shared point', () => {
    const wrongIndex = { ...child(mine, 0), childIndex: 1 }
    const otherPoint = {
      network: NETWORK,
      childIndex: 0,
      address: canonicalStampDestination({
        network: NETWORK,
        stampKey: mine,
        sharedPoint: key('55').keyBytes,
        childIndex: 0,
      }).address,
    }
    expect(
      paymentsToSelf(NETWORK, self, sharedPoint, [wrongIndex, otherPoint]),
    ).toEqual([])
  })

  it("keeps a payment to the wallet's previous stamp key", () => {
    const paid = [child(previous, 0)]
    expect(paymentsToSelf(NETWORK, self, sharedPoint, paid)).toEqual([])
    expect(
      paymentsToSelf(
        NETWORK,
        { stampKey: mine, previousStamp: previous } as any,
        sharedPoint,
        paid,
      ),
    ).toEqual(paid)
  })

  it('drops a stamp relabelled to another network, even with its address re-derived there', () => {
    // The reviewer's case: the sender names another chain and pays the address derived for it.
    // That account is not the one the wallet records as its stamp coin, so it is never reported.
    for (const network of ['xpi-mainnet', 'lotus', 'zz-not-a-chain']) {
      const relabelled = {
        network,
        childIndex: 0,
        address: canonicalStampDestination({
          network,
          stampKey: mine,
          sharedPoint,
          childIndex: 0,
        }).address,
      }
      expect(paymentsToSelf(NETWORK, self, sharedPoint, [relabelled])).toEqual(
        [],
      )
      // The label alone does not move a payment to the wallet's network either.
      expect(
        paymentsToSelf(NETWORK, self, sharedPoint, [
          { ...child(mine, 0), network },
        ]),
      ).toEqual([])
    }
  })
})
