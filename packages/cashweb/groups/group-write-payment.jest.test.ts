/** The writer's half of a paid group write, checked against the vectors the relay's verifier
 * (`backend/cashweb/cashweb-registry/src/group_write_payment_tests.rs`) is checked against. */
import { getBytes } from 'ethers'
import { bytesToHex } from './group-crypto'
import {
  GROUP_WRITE_BURN_ADDRESS,
  assertGroupWritePayment,
  groupWriteCalldata,
  groupWriteCommitment,
  groupWritePayeeAddress,
  groupWriteXpubIndex,
  parseGroupWritePolicy,
} from './group-write-payment'

const XPUB =
  'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8'
const COMMITMENT =
  'ee77f57679731ff0f06f5ff5dfc59c3a5401b3491c763822bfe2ffa15334f190'
/** Signed by ethers v6 with key 0x42…42: chain 10143, nonce 7, 1e12 wei to the burn address. */
const ETHERS_BURN_TX =
  '02f89782279f07847735940085174876e80082ea6094000000000000000000000000000000000000dead85e8d4a51000a54752505701ee77f57679731ff0f06f5ff5dfc59c3a5401b3491c763822bfe2ffa15334f190c001a05627eaa26d6623bb689fa47b88ce5b2166cda57cdb37a1581bb250b0310f98afa06b8f6715431f88d8d1e4bcd8719860892caee568e0391a1f5153c359b62d8d0f'

function commitment(
  overrides: Partial<Parameters<typeof groupWriteCommitment>[0]> = {},
) {
  return groupWriteCommitment({
    network: 'monad-testnet',
    hostOrigin: 'https://relay.example',
    groupIdHex: '11'.repeat(32),
    epoch: 3,
    signingDigest: new Uint8Array(32).fill(0x22),
    ...overrides,
  })
}

describe('group write payment', () => {
  test('commitment, calldata and xpub children match the independent vectors', () => {
    const c = commitment()
    expect(bytesToHex(c)).toBe(COMMITMENT)
    expect(bytesToHex(groupWriteCalldata(c))).toBe(`4752505701${COMMITMENT}`)
    expect(groupWriteXpubIndex(c)).toBe(1_853_355_382)
    expect(
      groupWritePayeeAddress({ kind: 'xpub', xpub: XPUB }, c).toLowerCase(),
    ).toBe('0xb028a08facaae7f24adb103cc38b8ba433d629b4')
    expect(
      groupWritePayeeAddress(
        { kind: 'xpub', xpub: XPUB },
        new Uint8Array(32),
      ).toLowerCase(),
    ).toBe('0x4b7115ad9623a528f1845eaf85d166de1e869bfb')
    expect(
      groupWritePayeeAddress(
        { kind: 'xpub', xpub: XPUB },
        new Uint8Array(32).fill(0xff),
      ).toLowerCase(),
    ).toBe('0x4e515434b67eab43ca645b490c27dec06fc0e31f')
  })

  test('every committed fact changes the commitment', () => {
    const base = bytesToHex(commitment())
    for (const changed of [
      commitment({ network: 'monad-regtest' }),
      commitment({ hostOrigin: 'https://other.example' }),
      commitment({ groupIdHex: '12'.repeat(32) }),
      commitment({ epoch: 4 }),
      commitment({ signingDigest: new Uint8Array(32).fill(0x23) }),
    ])
      expect(bytesToHex(changed)).not.toBe(base)
  })

  test('signed bytes are checked against the plan before they leave the writer', () => {
    const raw = getBytes(`0x${ETHERS_BURN_TX}`)
    const plan = {
      network: 'monad-testnet',
      destination: GROUP_WRITE_BURN_ADDRESS,
      amountWei: 1_000_000_000_000n,
      calldata: groupWriteCalldata(commitment()),
    }
    expect(assertGroupWritePayment(plan, raw)).toEqual({
      network: 'monad-testnet',
      raw_transaction: ETHERS_BURN_TX,
    })
    expect(() =>
      assertGroupWritePayment({ ...plan, amountWei: plan.amountWei + 1n }, raw),
    ).toThrow()
    expect(() =>
      assertGroupWritePayment(
        { ...plan, destination: '0x4b7115ad9623a528f1845eaf85d166de1e869bfb' },
        raw,
      ),
    ).toThrow()
    expect(() =>
      assertGroupWritePayment(
        { ...plan, calldata: groupWriteCalldata(commitment({ epoch: 4 })) },
        raw,
      ),
    ).toThrow()
  })

  test('a policy must name the relay the client writes to and a public payee', () => {
    const body = {
      network: 'monad-testnet',
      price_wei: '1000',
      host_origin: 'https://relay.example',
      payee: { kind: 'xpub', xpub: XPUB },
    }
    expect(parseGroupWritePolicy(body, 'https://relay.example/')).toEqual({
      network: 'monad-testnet',
      priceWei: 1000n,
      hostOrigin: 'https://relay.example',
      payee: { kind: 'xpub', xpub: XPUB },
    })
    for (const bad of [
      { ...body, host_origin: 'https://other.example' },
      { ...body, price_wei: '0' },
      { ...body, price_wei: 1000 },
      { ...body, payee: { kind: 'free' } },
      { ...body, payee: { kind: 'burn', address: `0x${'00'.repeat(20)}` } },
      { ...body, payee: { kind: 'xpub', xpub: XPUB.replace(/^xpub/, 'xprv') } },
      { ...body, payee: { kind: 'address', address: '0x1234' } },
    ])
      expect(() =>
        parseGroupWritePolicy(bad, 'https://relay.example'),
      ).toThrow()
  })
})
