import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { SolanaPaymentState } from './state'
import { MemorySolanaPaymentPersistence } from '../storage/solana-payment-state'
import { ExperimentalSolanaContactPayments } from './engine'
import { associatedAccount } from './transaction-policy'
// Public descriptors independently generated and validated by the closed WASM
// custody backend; no seed, scalar, signing prefix or signature is stored here.
import fixture from './source-selection-owned.json'
const address = (bytes: number[]) => new PublicKey(Uint8Array.from(bytes)).toBase58()
const hex = (bytes: number[]) => Buffer.from(bytes).toString('hex')
const primary = address(fixture.primary)
const intent = {
  operationId: '00000000-0000-4000-8000-000000000001',
  chainIdentifier: 'solana-devnet',
  recipientSpendPoint: primary,
  asset: { kind: 'native' as const },
  amount: '100',
  allowDestinationAtaCreation: false,
}
const large = {
  address: primary,
  owner: primary,
  asset: { kind: 'native' as const },
  balance: '101',
  observedSlot: 1,
  signingReference: { kind: 'primary' as const },
}
function owner(state: SolanaPaymentState) {
  const derive = jest.fn(async () => ({
    recipientPoint: primary,
    ephemeralPoint: address(fixture.small[0].descriptor.ephemeral),
    destinationOwner: address(fixture.small[63].publicKey),
  }))
  const sign = jest.fn(async () => {
    throw Error('Unexpected signing')
  })
  const rpc = { async getGenesisHash() { return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }, async getLatestBlockhash() { return { blockhash: primary, lastValidBlockHeight: 10 } }, async getFeeForMessage() { return '1' } }
  const construction = { async feeProbe() { return Uint8Array.of(1) }, async unsignedTransfer({operation,memberIndex,source,blockhash}: Parameters<import('./engine').ExperimentalSolanaPaymentConstruction['unsignedTransfer']>[0]) {
    const member=operation.members[memberIndex]
    return new TransactionMessage({payerKey:new PublicKey(source.owner),recentBlockhash:blockhash,instructions:[SystemProgram.transfer({fromPubkey:new PublicKey(source.owner),toPubkey:new PublicKey(member.destination!.destinationOwner),lamports:BigInt(member.amount)}),new TransactionInstruction({programId:new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),keys:[],data:Buffer.from(`frank:solana-custody-primary:experimental-v1:${'0'.repeat(64)}`)})]}).compileToV0Message().serialize()
  } }
  return {
    payments: new ExperimentalSolanaContactPayments(
      state,
      { deriveDestination: derive, validateReceived: async () => undefined, signTransfer: sign },
      rpc as never,
      construction,
      64
    ),
    derive,
    sign,
  }
}
test('unsigned financial review reconsiders 64 small sources before rejecting a feasible larger source', async () => {
  const smallCount=64, amount='100'
  let random = 0
    const state = new SolanaPaymentState('owned-wallet', 'solana-devnet', new MemorySolanaPaymentPersistence(), () =>
      new Uint8Array(32).fill(++random)
    )
    for (const value of fixture.small.slice(0, Number(smallCount))) {
      const d = value.descriptor,
        key = address(value.publicKey)
      await state.observe({
        address: key,
        owner: key,
        asset: { kind: 'native' },
        balance: '2',
        observedSlot: 1,
        signingReference: {
          kind: 'received',
          descriptor: {
            chainIdentifier: 'solana-devnet',
            asset: { kind: 'native' },
            recipientSpendPoint: address(d.recipient),
            ephemeralPoint: address(d.ephemeral),
            publicKey: key,
            cryptoOperationId32: hex(d.operationId),
            memberIndex: d.memberIndex,
            derivationContext32: hex(d.messageContext),
            recipientAmount: d.recipientAmount,
          },
        },
      })
    }
    await state.observe(large)
    const live = owner(state)
    expect(Object.keys((await state.inspect()).positions)).toHaveLength(Number(smallCount) + 1)
    const reconsidered = await live.payments.quoteReview({ ...intent, amount: String(amount) })
    expect(reconsidered.members.map((member) => member.amount)).toEqual([String(amount)])
    expect(reconsidered.sourceAddresses).toEqual([])
    expect(reconsidered.signed).toEqual([])
    expect(live.derive).toHaveBeenCalledTimes(1)
    expect(live.sign).not.toHaveBeenCalled()
    expect(Object.values((await state.inspect()).positions).every((position) => !position.reservedBy)).toBe(true)
    const controlState = new SolanaPaymentState(
      'control-wallet',
      'solana-devnet',
      new MemorySolanaPaymentPersistence(),
      () => new Uint8Array(32).fill(++random)
    )
    await controlState.observe(large)
    const control = owner(controlState)
    const quote = await control.payments.quoteReview(intent)
    expect(quote.members).toHaveLength(1)
    expect(quote.members[0].amount).toBe('100')
    expect(quote.sourceAddresses).toEqual([])
    expect(quote.signed).toEqual([])
    expect(control.derive).toHaveBeenCalledTimes(1)
    expect(control.sign).not.toHaveBeenCalled()
  }
)

test('feasible small-account exhaustion is preserved and infeasible planning creates no operation', async () => {
  let random = 0
  const state = new SolanaPaymentState('small-preference', 'solana-devnet', new MemorySolanaPaymentPersistence(), () =>
    new Uint8Array(32).fill(++random)
  )
  for (const value of fixture.small.slice(0, 2)) {
    const key = address(value.publicKey)
    await state.observe({ ...large, address: key, owner: key, balance: '2' })
  }
  await state.observe(large)
  const live = owner(state)
  const quote = await live.payments.quoteReview({ ...intent, amount: '2' })
  expect(quote.members.map((member) => member.amount)).toEqual(['1', '1'])
  const impossible = owner(state)
  await expect(
    impossible.payments.quoteReview({ ...intent, operationId: '00000000-0000-4000-8000-000000000002', amount: '104' })
  ).rejects.toMatchObject({ requirement: 'insufficient-value' })
  expect(impossible.derive).not.toHaveBeenCalled()
  expect(impossible.sign).not.toHaveBeenCalled()
  expect(Object.keys((await state.inspect()).operations)).toEqual([intent.operationId])
})
