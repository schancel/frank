import { bytesToHex } from '@frank/cashweb/groups/group-crypto'
import {
  GroupWriteDeferredError,
  GroupWriteRefusedError,
} from '@frank/cashweb/groups/group-relay-client'
import {
  GROUP_WRITE_BURN_ADDRESS,
  groupWritePaymentPlan,
  type GroupWritePaymentWire,
  type GroupWritePolicy,
  type StoredGroupWritePayment,
} from '@frank/cashweb/groups/group-write-payment'
import {
  GroupWritePaidRefusalError,
  GroupWritePaymentUnavailableError,
  GroupWritePaymentUnresolvedError,
  deliverPaidGroupWrite,
  type GroupWritePayer,
} from './write-payment'
import { groupWriteTestPayer } from './write-payment.testutil'

const GROUP = '11'.repeat(32)
const ENVELOPE = {
  epoch: 2,
  nonce: '33'.repeat(24),
  ciphertext: '44'.repeat(80),
  write_sig: '55'.repeat(64),
}
const POLICY: GroupWritePolicy = {
  network: 'monad-testnet',
  priceWei: 1_000n,
  hostOrigin: 'https://relay.example',
  payee: { kind: 'burn', address: GROUP_WRITE_BURN_ADDRESS },
}

function record(initial?: StoredGroupWritePayment) {
  let stored = initial
  const writes: StoredGroupWritePayment[] = []
  return {
    get stored() {
      return stored
    },
    writes,
    persist: async (next: StoredGroupWritePayment) => {
      writes.push(next)
      stored = next
    },
  }
}

/** The hosting relay as the writer sees it: it records every submission in `events`. */
function relay(
  events: string[],
  answers: Array<'ok' | 'timeout' | 'refuse' | 'gap' | 'unfunded'>,
) {
  const submitted: GroupWritePaymentWire[] = []
  return {
    submitted,
    submit: async (payment: GroupWritePaymentWire) => {
      submitted.push(payment)
      events.push('relay')
      const answer = answers.shift() ?? 'ok'
      if (answer === 'timeout') throw new Error('timeout of 15000ms exceeded')
      if (answer === 'gap')
        throw new GroupWriteDeferredError(
          'group_payment_not_ready',
          'nonce_gap',
        )
      if (answer === 'unfunded')
        throw new GroupWriteDeferredError(
          'group_payment_not_ready',
          'insufficient_balance',
        )
      if (answer === 'refuse')
        throw new GroupWriteRefusedError(
          402,
          'group_payment_invalid',
          'underpaid',
        )
      return { server_seq: 1 }
    },
  }
}

function deliver(
  message: ReturnType<typeof record>,
  wallet: GroupWritePayer | undefined,
  submit: (payment: GroupWritePaymentWire) => Promise<{ server_seq: number }>,
  policy: () => Promise<GroupWritePolicy> = async () => POLICY,
) {
  return deliverPaidGroupWrite({
    groupIdHex: GROUP,
    envelope: ENVELOPE,
    stored: message.stored,
    policy,
    persist: message.persist,
    wallet,
    submit,
  })
}

describe('deliverPaidGroupWrite', () => {
  test('persists the plan and the bytes, submits them, and broadcasts only after the relay holds the write', async () => {
    const payer = groupWriteTestPayer()
    const host = relay(payer.events, ['ok'])
    const message = record()
    const delivered = await deliver(message, payer.wallet, host.submit)
    expect(delivered).toEqual({
      state: 'delivered',
      receipt: { server_seq: 1 },
      settled: true,
    })
    const plan = groupWritePaymentPlan(POLICY, GROUP, ENVELOPE)
    expect(message.writes[0]).toEqual({
      network: 'monad-testnet',
      destination: plan.destination,
      amountWei: '1000',
      calldata: bytesToHex(plan.calldata),
      operationId: expect.stringMatching(/^group-write-[0-9a-f]{64}$/),
    })
    expect(message.writes[1]).toEqual({
      ...message.writes[0],
      rawTransaction: host.submitted[0]!.raw_transaction,
    })
    // Recorded as submitted before the relay sees it: from then on the plan is final.
    expect(message.writes[2]).toEqual({ ...message.writes[1], submitted: true })
    // Sign, relay, then the wallet's authorization and broadcast: never before the relay.
    expect(payer.events).toEqual([
      'construct:1',
      'relay',
      `send:${message.writes[0]!.operationId}`,
    ])
  })

  test('a timeout then a retry gives one payment: the same bytes, signed once, broadcast after delivery', async () => {
    const payer = groupWriteTestPayer()
    const host = relay(payer.events, ['timeout', 'ok'])
    const message = record()
    const policy = jest.fn(async () => POLICY)
    await expect(
      deliver(message, payer.wallet, host.submit, policy),
    ).rejects.toThrow('timeout')
    // The bytes may be out (the relay broadcasts what it stores); the wallet has not.
    expect(payer.events).toEqual(['construct:1', 'relay'])
    // The host's price changes meanwhile; the stored write keeps its plan and bytes.
    policy.mockResolvedValue({ ...POLICY, priceWei: 5_000n })
    expect(
      (await deliver(message, payer.wallet, host.submit, policy)).state,
    ).toBe('delivered')
    expect(policy).toHaveBeenCalledTimes(1)
    expect(payer.sets.size).toBe(1)
    expect(host.submitted).toHaveLength(2)
    expect(host.submitted[1]).toEqual(host.submitted[0])
    expect(payer.events.filter(event => event.startsWith('send'))).toHaveLength(
      1,
    )
    expect(payer.events.at(-1)).toMatch(/^send:/)
    // Plan, bytes, submitted, and the attempt without an answer.
    expect(message.writes).toHaveLength(4)
    expect(message.stored).toMatchObject({ submitted: true, uncertain: true })
  })

  test('a refused write is never broadcast, and its coin goes back when the chain shows no payment', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    const refused = await deliver(
      message,
      payer.wallet,
      relay(payer.events, ['refuse']).submit,
    )
    expect(refused).toMatchObject({ state: 'refused', outcome: 'released' })
    expect(payer.events.some(event => event.startsWith('send'))).toBe(false)
    expect(message.stored).toMatchObject({ released: true })
    expect(message.stored!.releasing).toBeUndefined()
    // Final: a later call submits nothing.
    const later = relay(payer.events, ['ok'])
    expect(await deliver(message, payer.wallet, later.submit)).toEqual({
      state: 'refused',
      outcome: 'released',
    })
    expect(later.submitted).toHaveLength(0)
  })

  test('a refused write whose payment the chain shows is tracked as spent and retried until held', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    const host = relay(payer.events, ['refuse', 'ok'])
    // The node holds the payment (another copy of the bytes got out).
    const submit = async (payment: GroupWritePaymentWire) => {
      payer.seenOnChain.add(message.stored!.operationId)
      return host.submit(payment)
    }
    await expect(deliver(message, payer.wallet, submit)).rejects.toBeInstanceOf(
      GroupWritePaidRefusalError,
    )
    // Authorized so the wallet reconciles it to its mined state; the coin is not released.
    expect(payer.events.at(-1)).toBe(`send:${message.stored!.operationId}`)
    expect(message.stored).toMatchObject({ spent: true })
    expect(message.stored?.released).toBeUndefined()
    // The paid write is owed: the same bytes go again, and this time the relay holds it.
    expect(await deliver(message, payer.wallet, submit)).toMatchObject({
      state: 'delivered',
      settled: true,
    })
    expect(host.submitted.map(payment => payment.raw_transaction)).toEqual(
      Array(2).fill(message.stored!.rawTransaction),
    )
    // One release was asked for, at the refusal; the wallet kept the coin, as the chain shows
    // the payment, and none was asked for again.
    expect(
      payer.events.filter(event => event.startsWith('release')),
    ).toHaveLength(1)
  })

  test('a payment the host cannot accept yet keeps the write pending, retried with the same bytes', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    const host = relay(payer.events, ['gap', 'unfunded', 'ok'])
    for (const reason of ['nonce_gap', 'insufficient_balance']) {
      const error = await deliver(message, payer.wallet, host.submit).catch(
        e => e,
      )
      expect(error).toBeInstanceOf(GroupWriteDeferredError)
      expect(error.reason).toBe(reason)
      // Not a refusal and not an unknown outcome: nothing released, nothing sent, and a later
      // definitive refusal could still release the coin.
      expect(message.stored?.uncertain).toBeUndefined()
      expect(payer.events.some(event => /^(release|send)/.test(event))).toBe(
        false,
      )
    }
    expect(await deliver(message, payer.wallet, host.submit)).toMatchObject({
      state: 'delivered',
      settled: true,
    })
    expect(payer.sets.size).toBe(1)
    expect(new Set(host.submitted.map(p => p.raw_transaction)).size).toBe(1)
    expect(host.submitted).toHaveLength(3)
  })

  test('after an attempt without an answer, a refusal never releases the coin', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    const host = relay(payer.events, ['timeout', 'refuse', 'refuse'])
    await expect(deliver(message, payer.wallet, host.submit)).rejects.toThrow(
      'timeout',
    )
    // The chain does not show the payment: it may still land, so the write stays to retry.
    await expect(
      deliver(message, payer.wallet, host.submit),
    ).rejects.toBeInstanceOf(GroupWritePaymentUnresolvedError)
    expect(payer.events.some(event => event.startsWith('release'))).toBe(false)
    expect(payer.events.some(event => event.startsWith('send'))).toBe(false)
    expect(payer.sets.size).toBe(1)
    // Once the chain shows it, the wallet tracks it as spent and the write stays to retry.
    payer.seenOnChain.add(message.stored!.operationId)
    await expect(
      deliver(message, payer.wallet, host.submit),
    ).rejects.toBeInstanceOf(GroupWritePaidRefusalError)
    expect(message.stored).toMatchObject({ spent: true })
    expect(payer.events.filter(event => event.startsWith('release'))).toEqual(
      [],
    )
    expect(host.submitted.map(payment => payment.raw_transaction)).toEqual(
      Array(3).fill(message.stored!.rawTransaction),
    )
  })

  test('a restart between the release and its record finishes the release', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    let crash = false
    const persist = async (next: StoredGroupWritePayment) => {
      if (crash && next.released) throw new Error('process stopped')
      await message.persist(next)
    }
    crash = true
    await expect(
      deliverPaidGroupWrite({
        groupIdHex: GROUP,
        envelope: ENVELOPE,
        stored: undefined,
        policy: async () => POLICY,
        persist,
        wallet: payer.wallet,
        submit: relay(payer.events, ['refuse']).submit,
      }),
    ).rejects.toThrow('process stopped')
    expect(message.stored).toMatchObject({ releasing: true })
    const restarted = record(message.stored)
    const submit = jest.fn()
    expect(await deliver(restarted, payer.wallet, submit)).toEqual({
      state: 'refused',
      outcome: 'released',
    })
    expect(restarted.stored).toMatchObject({ released: true })
    expect(submit).not.toHaveBeenCalled()
  })

  test('a plan never submitted is replaced when the host raises its price', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    // Signed, then the process stopped before the bytes went to the relay.
    const persist = async (next: StoredGroupWritePayment) => {
      if (next.submitted) throw new Error('process stopped')
      await message.persist(next)
    }
    await expect(
      deliverPaidGroupWrite({
        groupIdHex: GROUP,
        envelope: ENVELOPE,
        stored: undefined,
        policy: async () => POLICY,
        persist,
        wallet: payer.wallet,
        submit: jest.fn(),
      }),
    ).rejects.toThrow('process stopped')
    const first = message.stored!
    expect(first.rawTransaction).toBeDefined()
    const raised = { ...POLICY, priceWei: 5_000n }
    const host = relay(payer.events, ['ok'])
    expect(
      (await deliver(message, payer.wallet, host.submit, async () => raised))
        .state,
    ).toBe('delivered')
    // The old coin went back and a new operation pays the new price.
    expect(payer.events).toContain(`release:${first.operationId}`)
    expect(message.stored!.operationId).toBe(`${first.operationId}-1`)
    expect(message.stored).toMatchObject({ amountWei: '5000', generation: 1 })
    expect(host.submitted[0]!.raw_transaction).not.toBe(first.rawTransaction)
    // Once submitted, the plan is final whatever the host's terms.
    const policy = jest.fn(async () => ({ ...POLICY, priceWei: 9_000n }))
    await deliver(
      message,
      payer.wallet,
      relay(payer.events, ['ok']).submit,
      policy,
    )
    expect(policy).not.toHaveBeenCalled()
  })

  test('a stored plan whose set the wallet will not release is not replaced', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    const persist = async (next: StoredGroupWritePayment) => {
      if (next.submitted) throw new Error('process stopped')
      await message.persist(next)
    }
    await expect(
      deliverPaidGroupWrite({
        groupIdHex: GROUP,
        envelope: ENVELOPE,
        stored: undefined,
        policy: async () => POLICY,
        persist,
        wallet: payer.wallet,
        submit: jest.fn(),
      }),
    ).rejects.toThrow('process stopped')
    const first = message.stored!
    // The node shows the signed set, so the wallet keeps its claim.
    payer.seenOnChain.add(first.operationId)
    const submit = jest.fn()
    await expect(
      deliver(message, payer.wallet, submit, async () => ({
        ...POLICY,
        priceWei: 5_000n,
      })),
    ).rejects.toThrow('could not be released')
    expect(message.stored).toEqual(first)
    expect(submit).not.toHaveBeenCalled()
    // A plan whose set was never constructed has nothing to release and is replaced.
    const unsigned = record({
      network: first.network,
      destination: first.destination,
      amountWei: first.amountWei,
      calldata: first.calldata,
      operationId: `${first.operationId}-unsigned`,
    })
    expect(
      (
        await deliver(
          unsigned,
          payer.wallet,
          relay(payer.events, ['ok']).submit,
          async () => ({
            ...POLICY,
            priceWei: 5_000n,
          }),
        )
      ).state,
    ).toBe('delivered')
    expect(unsigned.stored).toMatchObject({ amountWei: '5000', generation: 1 })
  })

  test('a restart between signing and relay submission resumes with the same bytes', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    const crash = new Error('process stopped before the relay call')
    await expect(
      deliver(message, payer.wallet, async () => {
        throw crash
      }),
    ).rejects.toBe(crash)
    const signed = message.stored!.rawTransaction
    expect(signed).toBeDefined()
    // A new start of the same account: the stored record and the wallet's journal survive.
    const resumed = record(message.stored)
    const host = relay(payer.events, ['ok'])
    expect((await deliver(resumed, payer.wallet, host.submit)).state).toBe(
      'delivered',
    )
    expect(host.submitted[0]!.raw_transaction).toBe(signed)
    expect(payer.sets.size).toBe(1)
    expect(resumed.writes).toHaveLength(0)
  })

  test('the wallet authorization failing after delivery leaves the write to be settled by a retry', async () => {
    const payer = groupWriteTestPayer()
    const send = payer.wallet.sendTransaction!
    payer.wallet.sendTransaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('journal busy'))
      .mockImplementation(send)
    const message = record()
    const host = relay(payer.events, ['ok', 'ok'])
    expect(await deliver(message, payer.wallet, host.submit)).toMatchObject({
      state: 'delivered',
      settled: false,
    })
    expect(await deliver(message, payer.wallet, host.submit)).toMatchObject({
      state: 'delivered',
      settled: true,
    })
    expect(host.submitted[1]).toEqual(host.submitted[0])
  })

  test('another device of the account derives the same operation for the same write', async () => {
    const a = record()
    const b = record()
    for (const message of [a, b]) {
      const payer = groupWriteTestPayer()
      await deliver(message, payer.wallet, relay(payer.events, ['ok']).submit)
    }
    expect(a.writes[0]!.operationId).toBe(b.writes[0]!.operationId)
  })

  test('a wallet on another network or without the capability signs nothing', async () => {
    for (const wallet of [
      groupWriteTestPayer('ethereum-sepolia').wallet,
      { chainIdentifier: 'monad-testnet' },
    ]) {
      const message = record()
      const submit = jest.fn()
      await expect(deliver(message, wallet, submit)).rejects.toBeInstanceOf(
        GroupWritePaymentUnavailableError,
      )
      expect(submit).not.toHaveBeenCalled()
      // The plan is kept so the write is retried against the same host terms.
      expect(message.writes).toHaveLength(1)
    }
  })

  test('bytes that differ from the stored ones are never handed on', async () => {
    const payer = groupWriteTestPayer()
    const message = record()
    await deliver(message, payer.wallet, relay(payer.events, ['ok']).submit)
    const stored = {
      ...message.stored!,
      rawTransaction: message.stored!.rawTransaction!.replace(/..$/, '00'),
    }
    const submit = jest.fn()
    await expect(
      deliver(record(stored), groupWriteTestPayer().wallet, submit),
    ).rejects.toThrow('differs from the one already signed')
    expect(submit).not.toHaveBeenCalled()
  })
})
