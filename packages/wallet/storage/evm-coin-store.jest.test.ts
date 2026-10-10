import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  EVM_COIN_NAMESPACE,
  LevelRecordStore,
  messagePaymentOf,
  observeEvmCoin,
  PAYMENT_NOT_RECEIVED_AFTER_MS,
  PENDING_COIN_MAX_BACKOFF_MS,
  pendingCoinDue,
  receivedPaymentOf,
  spendableCoinTotal,
  spendableCoins,
  type EvmCoin,
} from './evm-coin-store'

const coin = (overrides: Partial<EvmCoin> = {}): EvmCoin => ({
  address: '0x' + 'a1'.repeat(20),
  privateKey: '0x' + '01'.repeat(32),
  origin: 'stealth',
  state: 'pending',
  amountWei: '0',
  claimedAmountWei: '5000',
  transactions: ['99'.repeat(32)],
  payloadDigest: 'cd'.repeat(32),
  ephemeralPubKey: '02' + '22'.repeat(32),
  discoveredAtMs: 1,
  ...overrides,
})

// The coin's message arrived at 1 ms.
const EARLY = 1 + PAYMENT_NOT_RECEIVED_AFTER_MS - 1
const LATE = 1 + PAYMENT_NOT_RECEIVED_AFTER_MS

describe('received coins', () => {
  it('a coin never read is pending, holds nothing and is not spendable, whatever was claimed', () => {
    const fresh = coin({ claimedAmountWei: '1000000' })
    expect(receivedPaymentOf(fresh)).toMatchObject({
      status: 'pending',
      amountWei: 0n,
      claimedAmountWei: 1_000_000n,
      spendable: false,
    })
    expect(spendableCoinTotal([fresh])).toBe(0n)
  })

  it('the amount is what the chain shows, more or less than the claim', () => {
    const less = observeEvmCoin(coin({ claimedAmountWei: '5000' }), {
      balanceWei: 1_200n,
      transfer: 'included',
      atMs: 10,
    })
    expect(less).toMatchObject({
      state: 'unspent',
      amountWei: '1200',
      receivedAmountWei: '1200',
      checkedAtMs: 10,
    })
    expect(receivedPaymentOf(less)).toMatchObject({
      status: 'received',
      amountWei: 1_200n,
      receivedAmountWei: 1_200n,
      claimedAmountWei: 5_000n,
      spendable: true,
    })
    const more = observeEvmCoin(coin({ claimedAmountWei: '5000' }), {
      balanceWei: 9_000n,
      transfer: 'included',
      atMs: 10,
    })
    expect(receivedPaymentOf(more).amountWei).toBe(9_000n)
    expect(spendableCoinTotal([less, more])).toBe(10_200n)
  })

  it('money at the address is not enough: the named transfer must be included', () => {
    // Someone else funded the account; the transfer the message named is nowhere.
    const unproven = observeEvmCoin(coin(), {
      balanceWei: 5_000n,
      transfer: 'unseen',
      atMs: 10,
    })
    expect(unproven.state).toBe('pending')
    expect(receivedPaymentOf(unproven, LATE)).toMatchObject({
      status: 'not-received',
      spendable: false,
    })
    expect(spendableCoinTotal([unproven])).toBe(0n)
    expect(spendableCoins([unproven])).toEqual([])
    // A message that named no transfer at all has only the balance to go by.
    const unnamed = observeEvmCoin(coin({ transactions: [] }), {
      balanceWei: 5_000n,
      transfer: 'none',
      atMs: 10,
    })
    expect(unnamed.state).toBe('unspent')
  })

  it('nothing is received without an amount the chain showed arriving', () => {
    // A named transaction that is mined and pays this account nothing (someone else's
    // transaction, or a zero-value transfer), with an empty account: proof of nothing.
    const forged = observeEvmCoin(coin({ claimedAmountWei: '1000000' }), {
      balanceWei: 0n,
      transfer: 'included',
      transferValueWei: 0n,
      atMs: 10,
    })
    expect(forged.state).toBe('pending')
    expect(forged.receivedAmountWei).toBeUndefined()
    expect(receivedPaymentOf(forged, EARLY)).toMatchObject({
      status: 'pending',
      amountWei: 0n,
      claimedAmountWei: 1_000_000n,
      spendable: false,
    })
    expect(receivedPaymentOf(forged, LATE).status).toBe('not-received')
    expect(messagePaymentOf([forged], forged.payloadDigest!, LATE)).toMatchObject({
      status: 'not-received',
      receivedWei: 0n,
    })
    // The same with no value reported at all.
    expect(
      observeEvmCoin(coin(), { balanceWei: 0n, transfer: 'included', atMs: 10 })
        .state,
    ).toBe('pending')

    // A verified transfer that DID pay this account, found already spent (another device):
    // received, at what that transaction paid, not at what the sender wrote.
    const spentElsewhere = observeEvmCoin(coin({ claimedAmountWei: '1000000' }), {
      balanceWei: 0n,
      transfer: 'included',
      transferValueWei: 700n,
      atMs: 10,
    })
    expect(spentElsewhere).toMatchObject({
      state: 'spent',
      receivedAmountWei: '700',
    })
    expect(receivedPaymentOf(spentElsewhere)).toMatchObject({
      status: 'received',
      receivedAmountWei: 700n,
      spendable: false,
    })

    // A stored coin that somehow says spent with no amount is still not "received".
    const { receivedAmountWei: _none, ...bare } = spentElsewhere
    expect(receivedPaymentOf(bare as EvmCoin, EARLY).status).toBe('pending')
  })

  it('a transfer the node knows stays pending; one it still does not know long after the message was not received', () => {
    const waiting = observeEvmCoin(coin(), {
      balanceWei: 0n,
      transfer: 'seen',
      atMs: 10,
    })
    expect(waiting.state).toBe('pending')
    expect(receivedPaymentOf(waiting).status).toBe('pending')

    const missing = observeEvmCoin(coin(), {
      balanceWei: 0n,
      transfer: 'unseen',
      atMs: 10,
    })
    expect(missing.state).toBe('pending')
    // Early on it may simply not have been broadcast yet.
    expect(receivedPaymentOf(missing, EARLY).status).toBe('pending')
    // Past the bound, the claim is called what it is. The stored coin is still pending, so it
    // is still re-checked.
    expect(receivedPaymentOf(missing, LATE)).toMatchObject({
      status: 'not-received',
      amountWei: 0n,
      claimedAmountWei: 5_000n,
      spendable: false,
    })
    // A transfer the node knows is on its way however long it takes.
    expect(receivedPaymentOf(waiting, LATE).status).toBe('pending')
    expect(spendableCoinTotal([waiting, missing])).toBe(0n)
    expect(spendableCoins([waiting, missing])).toEqual([])

    // It can still arrive later.
    const arrived = observeEvmCoin(missing, {
      balanceWei: 5_000n,
      transfer: 'included',
      atMs: 20,
    })
    expect(arrived.state).toBe('unspent')
    expect(arrived.transferSeen).toBeUndefined()
  })

  it('a claim that never arrives is asked about less and less often, and is still found late', () => {
    const MIN = 60_000
    const unseen = (checkedAtMs: number) =>
      observeEvmCoin(coin(), { balanceWei: 0n, transfer: 'unseen', atMs: checkedAtMs })
    // Never read, or early, or known to the node: always due.
    expect(pendingCoinDue(coin(), 5 * MIN)).toBe(true)
    expect(pendingCoinDue(unseen(2 * MIN), 2 * MIN + 1)).toBe(true)
    const known = observeEvmCoin(coin(), {
      balanceWei: 0n,
      transfer: 'seen',
      atMs: 100 * MIN,
    })
    expect(pendingCoinDue(known, 100 * MIN + 1)).toBe(true)
    // An hour old and unknown to the node: next look an eighth of its age after the last.
    const hourOld = unseen(60 * MIN)
    expect(pendingCoinDue(hourOld, 60 * MIN + 5 * MIN)).toBe(false)
    expect(pendingCoinDue(hourOld, 60 * MIN + 9 * MIN)).toBe(true)
    // Very old: at most the cap between looks, never "never".
    const old = unseen(30 * 24 * 60 * MIN)
    expect(pendingCoinDue(old, 30 * 24 * 60 * MIN + PENDING_COIN_MAX_BACKOFF_MS - 1)).toBe(false)
    expect(pendingCoinDue(old, 30 * 24 * 60 * MIN + PENDING_COIN_MAX_BACKOFF_MS)).toBe(true)
    // And when it does arrive, that look makes it received.
    expect(
      observeEvmCoin(old, { balanceWei: 9n, transfer: 'included', transferValueWei: 9n, atMs: 1 })
        .state,
    ).toBe('unspent')
  })

  it('a transfer that can never land marks the coin failed: kept, shown, never counted', () => {
    const failed = observeEvmCoin(coin(), {
      balanceWei: 0n,
      transfer: 'failed',
      atMs: 10,
    })
    expect(failed.state).toBe('failed')
    expect(receivedPaymentOf(failed)).toMatchObject({
      status: 'failed',
      amountWei: 0n,
      spendable: false,
    })
    expect(spendableCoinTotal([failed])).toBe(0n)
    expect(spendableCoins([failed])).toEqual([])
    // A later reading that learns nothing new does not bring it back.
    expect(
      observeEvmCoin(failed, { balanceWei: 0n, transfer: 'unseen', atMs: 20 })
        .state,
    ).toBe('failed')
  })

  it('a funded account that is empty again was spent: received, and no longer spendable', () => {
    const funded = observeEvmCoin(coin(), {
      balanceWei: 5_000n,
      transfer: 'included',
      atMs: 10,
    })
    const partly = observeEvmCoin(funded, { balanceWei: 2_000n, atMs: 20 })
    expect(partly).toMatchObject({
      state: 'unspent',
      amountWei: '2000',
      receivedAmountWei: '5000',
    })
    const emptied = observeEvmCoin(partly, { balanceWei: 0n, atMs: 30 })
    expect(emptied).toMatchObject({ state: 'spent', amountWei: '0' })
    expect(receivedPaymentOf(emptied)).toMatchObject({
      status: 'received',
      receivedAmountWei: 5_000n,
      spendable: false,
    })
    expect(spendableCoinTotal([emptied])).toBe(0n)
    // The one selection rule: only a verified coin that holds money.
    expect(spendableCoins([coin(), funded, partly, emptied])).toEqual([
      funded,
      partly,
    ])
  })

  it('a message is paid only when every payment it carried is on the chain', () => {
    const digest = 'cd'.repeat(32)
    const landed = observeEvmCoin(
      coin({ address: '0x01', origin: 'stamp', childIndex: 0, claimedAmountWei: '600' }),
      { balanceWei: 600n, transfer: 'included', atMs: 1 },
    )
    const waiting = coin({ address: '0x02', origin: 'stamp', childIndex: 1, claimedAmountWei: '400' })
    const other = coin({ address: '0x03', payloadDigest: 'ee'.repeat(32) })

    expect(messagePaymentOf([other], digest)).toMatchObject({
      status: 'none',
      receivedWei: 0n,
      statedWei: 0n,
    })
    // Accepts the digest with or without a prefix, in either case.
    expect(messagePaymentOf([landed, waiting, other], '0x' + digest.toUpperCase())).toMatchObject({
      status: 'pending',
      receivedWei: 600n,
      statedWei: 1_000n,
    })
    const second = observeEvmCoin(waiting, {
      balanceWei: 400n,
      transfer: 'included',
      atMs: 2,
    })
    expect(messagePaymentOf([landed, second], digest)).toMatchObject({
      status: 'received',
      receivedWei: 1_000n,
      statedWei: 1_000n,
    })
    const never = observeEvmCoin(waiting, {
      balanceWei: 0n,
      transfer: 'failed',
      atMs: 2,
    })
    expect(messagePaymentOf([landed, never], digest)).toMatchObject({
      status: 'failed',
      receivedWei: 600n,
    })
    const overdue = observeEvmCoin(waiting, {
      balanceWei: 0n,
      transfer: 'unseen',
      atMs: 2,
    })
    expect(messagePaymentOf([landed, overdue], digest, EARLY).status).toBe('pending')
    expect(messagePaymentOf([landed, overdue], digest, LATE).status).toBe(
      'not-received',
    )
  })

  it('survives a reopen of the same storage, key included; a new location starts empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evm-coins-'))
    try {
      const stored = observeEvmCoin(coin(), {
        balanceWei: 5_000n,
        transfer: 'included',
        atMs: 10,
      })
      const first = await LevelRecordStore.open<EvmCoin>(root, EVM_COIN_NAMESPACE)
      await first.put(stored.address, stored)
      await first.put('0xgone', coin({ address: '0xgone' }))
      await first.delete('0xgone')
      await first.close()

      const second = await LevelRecordStore.open<EvmCoin>(root, EVM_COIN_NAMESPACE)
      expect(second.all()).toEqual([stored])
      expect(second.get(stored.address)?.privateKey).toBe(stored.privateKey)
      await second.close()

      const other = await LevelRecordStore.open<EvmCoin>(root, 'another-namespace')
      expect(other.all()).toEqual([])
      await other.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
