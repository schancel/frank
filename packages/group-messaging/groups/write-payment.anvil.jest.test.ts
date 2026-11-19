/**
 * INTEGRATION: two devices of one account pay for the same group write from the same coin, on a
 * real EVM node (anvil).
 *
 * Real: the node, the wallet's provider, signing, the typed custody, coin list and LevelDB
 * transaction-set journal, and the wallet's own recovery pass. The other device's payment is
 * signed here with the coin's own key at the nonce this device's set starts at, and the host
 * relay, which accepted it, broadcasts it.
 *
 * Not real, and said so: the host relay is the `submit` callback below, answering `existing`
 * with the receipt that names the other device's payment. The relay's side of that answer is
 * checked against the real Rust router in `packages/cashweb/groups/group-http.jest.test.ts`.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN, or fails
 * under FRANK_REQUIRE_NODES=1.
 */
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { JsonRpcProvider, Transaction, Wallet, getBytes, hexlify } from 'ethers'
import {
  assertGroupWritePayment,
  groupWritePaymentPlan,
  groupWritePaymentTxHash,
  type GroupWritePaymentWire,
  type GroupWritePolicy,
  type StoredGroupWritePayment,
} from '@frank/cashweb/groups/group-write-payment'
import { fixture, type Fixture } from '@frank/wallet/chain/canonical-two-wallets.testutil'
import { installCanonicalDirectory } from '@frank/wallet/chain/evm-chain'
import { evmWalletInternals } from '@frank/wallet/evm-wallet'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { anvilBinary, findAnvil, nodeSuiteReady } from '@frank/wallet/node-binaries.testutil'
import { deliverPaidGroupWrite } from './write-payment'

const mockNode = { url: '' }
jest.mock('@frank/wallet/evm-provider', () => {
  const actual = jest.requireActual('@frank/wallet/evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({ rpcUrl: mockNode.url, chainId: options.chainId }),
  }
})
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineMailboxModule(),
)

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
const HOST: GroupWritePolicy = {
  network: 'monad-testnet',
  priceWei: 10n ** 12n,
  priceVersion: 0,
  minPriceWei: 10n ** 12n,
  hostOrigin: 'https://relay.example',
  payee: BURN_ADDRESS,
}
const GROUP = '11'.repeat(32)
const ENVELOPE = {
  epoch: 0,
  nonce: '33'.repeat(24),
  ciphertext: '33'.repeat(80),
  write_sig: '55'.repeat(64),
}

const anvilBin = findAnvil()
const suite = nodeSuiteReady('write-payment.anvil', [anvilBinary(anvilBin)]) ? describe : describe.skip

suite('two devices of one account pay for one group write from the same coin (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let f: Fixture
  let alice: EvmChainWalletHandle
  const mine = (blocks = 1) => chain.send('anvil_mine', [`0x${blocks.toString(16)}`])

  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    node = spawn(
      anvilBin!,
      ['--port', String(port), '--chain-id', '10143', '--base-fee', '0', '--gas-price', '1000000000', '--silent'],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(mockNode.url, 10143, { staticNetwork: true, cacheTimeout: -1 })
    for (let attempt = 0; ; attempt++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (error) {
        if (attempt > 100) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    f = await fixture({ transactionSetPolicy: undefined })
    alice = f.alice
    // The wallet's recovery pass runs with messaging, which needs the account's directory entry.
    installCanonicalDirectory(alice, await f.directoryFor('alice', f.alice, f.bob))
    const main = alice.mainAccount!.address
    await (await new Wallet(DEV_KEY, chain).sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await mine(5)
    await alice.refreshTransactionSetInventory!()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  const coins = () => evmWalletInternals(alice).coinList!
  const keyOf = (account: string) =>
    coins().all().find(coin => coin.account === account.toLowerCase())!.privateKey

  function record() {
    let stored: StoredGroupWritePayment | undefined
    return {
      get stored() {
        return stored
      },
      persist: async (next: StoredGroupWritePayment) => {
        stored = next
      },
    }
  }
  const deliver = (
    message: ReturnType<typeof record>,
    submit: (payment: GroupWritePaymentWire) => Promise<{ server_seq: number; payment_tx_hash: string }>,
  ) =>
    deliverPaidGroupWrite({
      groupIdHex: GROUP,
      envelope: ENVELOPE,
      stored: message.stored,
      policy: async () => HOST,
      persist: message.persist,
      wallet: alice,
      submit,
    })

  it("the second device's set, whose nonce the first device's payment took, is never broadcast and lets its account go once the chain decides it", async () => {
    const message = record()
    let first: GroupWritePaymentWire | undefined
    let sourceAccount = ''
    let ownHashes: string[] = []
    const held = () => ({ server_seq: 1, payment_tx_hash: groupWritePaymentTxHash(first!) })
    // This device has signed its set, and has not broadcast anything. The other device built its
    // own set from the same coin a moment earlier; the host accepted that one's payment, at the
    // nonce this device's set starts at, and broadcast it.
    const delivered = await deliver(message, async payment => {
      const operation = await alice.transactionSetPreparer!.readOperation(message.stored!.operationId)
      ownHashes = operation!.members.map(member => member.signed!.transactionHash)
      const ours = Transaction.from(`0x${payment.raw_transaction}`)
      sourceAccount = ours.from!
      const startsAt = Math.min(
        ...operation!.members
          .filter(member => member.source.address.toLowerCase() === sourceAccount.toLowerCase())
          .map(member => Transaction.from(member.unsignedTransaction).nonce),
      )
      const plan = groupWritePaymentPlan(HOST, GROUP, ENVELOPE)
      const signed = await new Wallet(keyOf(sourceAccount)).signTransaction({
        type: 2,
        chainId: 10143n,
        nonce: startsAt,
        to: plan.destination,
        value: plan.amountWei,
        data: hexlify(plan.calldata),
        gasLimit: 60_000n,
        maxFeePerGas: 2n * 10n ** 9n,
        maxPriorityFeePerGas: 10n ** 9n,
      })
      first = assertGroupWritePayment(plan, getBytes(signed))
      expect(first.raw_transaction).not.toBe(payment.raw_transaction)
      await (await chain.broadcastTransaction(signed)).wait()
      return held()
    })
    expect(delivered).toMatchObject({ state: 'delivered' })
    expect(message.stored).toMatchObject({ fundedElsewhere: true })

    // The wallet's own recovery pass decides the set on chain evidence; the write is retried
    // (with the same bytes, answered `existing`) until its payment settles.
    let settled = delivered.state === 'delivered' && delivered.settled
    for (let pass = 0; !settled && pass < 20; pass++) {
      await mine(2)
      await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [] })
      const again = await deliver(message, async () => held())
      settled = again.state === 'delivered' && again.settled
    }
    expect(settled).toBe(true)
    // One payment for one write: only the other device's is on chain, nothing of this device's
    // set was ever handed to the node, and it is not counted as paid.
    for (const hash of ownHashes) expect(await chain.getTransaction(hash)).toBeNull()
    expect(await chain.getTransaction(Transaction.from(`0x${first!.raw_transaction}`).hash!)).not.toBeNull()
    expect(message.stored!.spent).toBeUndefined()
    // The account is the wallet's to spend again.
    expect(coins().isAccountReserved(sourceAccount)).toBe(false)
  })
})
