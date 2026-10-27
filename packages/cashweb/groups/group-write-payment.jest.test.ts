/** The writer's half of a paid group write, checked against the vectors the relay's verifier
 * (`backend/cashweb/cashweb-registry/src/group_write_payment_tests.rs`) is checked against. */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { getBytes } from 'ethers'
import { bytesToHex, computeGroupIdFromPubKey } from './group-crypto'
import {
  assertGroupWritePayment,
  groupWriteCalldata,
  groupWriteCommitment,
  groupWritePaymentPlan,
  groupWritePriceDigest,
  parseGroupWritePolicy,
  signGroupWritePrice,
} from './group-write-payment'

const BURN = '0x000000000000000000000000000000000000dEaD'
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

const policyBody = {
  network: 'monad-testnet',
  price_wei: '5000',
  price_version: 2,
  min_price_wei: '1000',
  host_origin: 'https://relay.example',
  payee: '0x000000000000000000000000000000000000dead',
}

describe('group write payment', () => {
  test('commitment and calldata match the independent vectors', () => {
    const c = commitment()
    expect(bytesToHex(c)).toBe(COMMITMENT)
    expect(bytesToHex(groupWriteCalldata(c))).toBe(`4752505701${COMMITMENT}`)
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
      destination: BURN,
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

  test("a policy names the relay the client writes to, its address and the group's price", () => {
    expect(parseGroupWritePolicy(policyBody, 'https://relay.example/')).toEqual(
      {
        network: 'monad-testnet',
        priceWei: 5000n,
        priceVersion: 2,
        minPriceWei: 1000n,
        hostOrigin: 'https://relay.example',
        payee: BURN,
      },
    )
    for (const bad of [
      { ...policyBody, host_origin: 'https://other.example' },
      { ...policyBody, price_wei: '0' },
      { ...policyBody, price_wei: 1000 },
      { ...policyBody, price_wei: '999' }, // below the relay's own minimum
      { ...policyBody, min_price_wei: undefined },
      { ...policyBody, price_version: -1 },
      { ...policyBody, price_version: '2' },
      // The removed payee kinds.
      { ...policyBody, payee: { kind: 'burn', address: BURN } },
      {
        ...policyBody,
        payee: {
          kind: 'xpub',
          xpub: 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',
        },
      },
      { ...policyBody, payee: '0x1234' },
    ])
      expect(() =>
        parseGroupWritePolicy(bad, 'https://relay.example'),
      ).toThrow()
  })

  test("a write's plan pays the relay's address the group's price", () => {
    const policy = parseGroupWritePolicy(policyBody, 'https://relay.example')
    const sk = new Uint8Array(32).fill(7)
    const groupIdHex = computeGroupIdFromPubKey(secp256k1.getPublicKey(sk, true))
    const plan = groupWritePaymentPlan(policy, groupIdHex, {
      epoch: 0,
      nonce: '01'.repeat(24),
      ciphertext: '00ff',
      write_sig: '',
    } as never)
    expect(plan.destination).toBe(BURN)
    expect(plan.amountWei).toBe(5000n)
    expect(plan.network).toBe('monad-testnet')
  })

  test('the price digest matches the independent vector', () => {
    // Computed with Python's hashlib, as the relay's test pins it.
    expect(
      bytesToHex(
        groupWritePriceDigest({
          network: 'monad-testnet',
          groupIdHex: '11'.repeat(32),
          version: 2,
          priceWei: 5_000_000_000_000_000n,
        }),
      ),
    ).toBe('065e08125716f2a2fd1909ec95209a43cf738b259a76d967f591c8827c1ab757')
  })

  test("a price is signed low-S by the group's root key and refused for another group", () => {
    const sk = new Uint8Array(32).fill(7)
    const pub = secp256k1.getPublicKey(sk, true)
    const groupIdHex = computeGroupIdFromPubKey(pub)
    const record = signGroupWritePrice({
      network: 'monad-testnet',
      groupIdHex,
      version: 1,
      priceWei: 3000n,
      rootSecretKey: sk,
    })
    expect(record).toMatchObject({
      group_id: groupIdHex,
      network: 'monad-testnet',
      version: 1,
      price_wei: '3000',
    })
    const signature = secp256k1.Signature.fromCompact(record.admin_sig)
    expect(signature.hasHighS()).toBe(false)
    expect(
      secp256k1.verify(
        signature,
        groupWritePriceDigest({
          network: 'monad-testnet',
          groupIdHex,
          version: 1,
          priceWei: 3000n,
        }),
        pub,
      ),
    ).toBe(true)
    expect(() =>
      signGroupWritePrice({
        network: 'monad-testnet',
        groupIdHex: '22'.repeat(32),
        version: 1,
        priceWei: 3000n,
        rootSecretKey: sk,
      }),
    ).toThrow()
    for (const [version, priceWei] of [
      [0, 3000n],
      [1, 0n],
    ] as const)
      expect(() =>
        signGroupWritePrice({
          network: 'monad-testnet',
          groupIdHex,
          version,
          priceWei,
          rootSecretKey: sk,
        }),
      ).toThrow()
  })
})
