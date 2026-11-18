/**
 * @jest-environment node
 */
/**
 * INTEGRATION: reading a GenericHTLC lock back from a node (`fetchSwapLock`).
 *
 * Real: a local dev node of a real EVM client (`anvil`) running the compiled GenericHTLC
 * (`packages/contracts/artifacts`) at the address the registry gives `monad-testnet`, real
 * lock, withdraw and refund transactions, and ethers' JSON-RPC provider reading them back.
 *
 * Needs an `anvil` binary (see `test/jest/utils/anvil.ts`). Without one the suite reports
 * itself as NOT RUN.
 */
import { Contract, Wallet, ZeroAddress, sha256 } from 'ethers'
import { createPinia, setActivePinia } from 'pinia'
import GenericHTLCArtifact from '@frank/contracts/artifacts/GenericHTLC.json'
import {
  encodeEvmHtlcLock,
  resolveHtlcContract,
} from '@frank/wallet/swap-escrow'
import {
  findAnvil,
  startAnvil,
  type AnvilNode,
} from '../../test/jest/utils/anvil'
import { useSwapEscrow } from './useSwapEscrow'

jest.mock('../utils/clients', () => ({
  useMonadWallet: () => {
    throw new Error('the test passes its own provider')
  },
}))

const CHAIN = 'monad-testnet'
const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: useSwapEscrow.anvil needs an anvil binary (set ANVIL_BIN).',
  )
const suite = anvilBin ? describe : describe.skip

suite('fetchSwapLock against GenericHTLC (anvil)', () => {
  jest.setTimeout(60_000)
  let node: AnvilNode
  const htlcAddress = resolveHtlcContract(CHAIN).contractAddress
  const recipient = Wallet.createRandom()
  const refundTo = Wallet.createRandom()
  const preimage = '0x' + '5a'.repeat(32)
  const hashLock = sha256(preimage)
  let counter = 0

  beforeAll(async () => {
    node = await startAnvil(anvilBin!)
    await node.provider.send('anvil_setCode', [
      htlcAddress,
      GenericHTLCArtifact.deployedBytecode,
    ])
  })
  afterAll(() => node?.stop())
  beforeEach(() => setActivePinia(createPinia()))

  async function lock(amountWei: bigint, durationSeconds: number) {
    const lockId = '0x' + (++counter).toString(16).padStart(64, '0')
    const tx = encodeEvmHtlcLock({
      lockId,
      recipient: recipient.address,
      refundAddress: refundTo.address,
      hashLock,
      durationSeconds,
      amountWei,
      contractAddress: htlcAddress,
    })
    await (await node.dev.sendTransaction(tx)).wait()
    return lockId
  }
  const fetch = (lockId: string) =>
    useSwapEscrow().fetchSwapLock({
      chain: CHAIN,
      lockId,
      customProvider: node.provider,
    })

  it('reads an open lock with its real amount, parties and expiry', async () => {
    const amount = 123_456_789_000_000_000n
    const lockId = await lock(amount, 3600)
    const latest = await node.provider.getBlock('latest')

    const record = await fetch(lockId)

    expect(record).toEqual({
      lockId,
      sender: node.dev.address,
      recipient: recipient.address,
      refundAddress: refundTo.address,
      token: ZeroAddress,
      hashLock,
      amount,
      expiresAt: latest!.timestamp + 3600,
      withdrawn: false,
      refunded: false,
      isExpired: false,
      status: 'locked',
    })
  })

  it('reads a withdrawn lock as withdrawn', async () => {
    const lockId = await lock(10n ** 15n, 3600)
    const htlc = new Contract(htlcAddress, GenericHTLCArtifact.abi, node.dev)
    await (await htlc.withdraw(lockId, preimage)).wait()

    expect(await fetch(lockId)).toMatchObject({
      status: 'withdrawn',
      withdrawn: true,
      amount: 10n ** 15n,
    })
  })

  it("reads expiry by the chain's clock, then a refunded lock as refunded", async () => {
    const lockId = await lock(10n ** 15n, 60)
    expect((await fetch(lockId))?.status).toBe('locked')

    await node.advanceTime(61)
    expect(await fetch(lockId)).toMatchObject({
      status: 'expired',
      isExpired: true,
    })

    const htlc = new Contract(htlcAddress, GenericHTLCArtifact.abi, node.dev)
    await (await htlc.refund(lockId)).wait()
    expect(await fetch(lockId)).toMatchObject({
      status: 'refunded',
      refunded: true,
      withdrawn: false,
    })
  })

  it('reads a lock that does not exist as unfunded', async () => {
    expect((await fetch('0x' + 'ee'.repeat(32)))?.status).toBe('unfunded')
  })
})
