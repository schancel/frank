import { toHex } from '@frank/codec'
import { installCanonicalDirectory } from './evm-chain'
import { DirectMessageAlreadyAttemptedError } from './active-chain'
import {
  fixture, mailboxes, mockBalances, mockFunded, offlineChain,
  type Fixture, type InboxRecord,
} from './canonical-two-wallets.testutil'

jest.mock('../evm-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule())
jest.mock('../evm-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule())
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule())

// Public send/recovery boundary, with real sealing, signing and durable wallet stores.
// Only the node and relay are offline stand-ins; no real funds or network are used.
describe('paid message authorization before durable construction', () => {
  let f: Fixture
  let inbox: InboxRecord[]
  beforeEach(async () => {
    offlineChain.reset()
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    f = await fixture()
    inbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), inbox)
    f.setMailbox(inbox)
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    mockBalances.set((await f.alice.getReceiveAddress()).raw.toLowerCase(), 0n)
    mockBalances.set(f.alice.identity.address.raw.toLowerCase(), 0n)
    const [source] = f.alice.pool.ensureSize(1)
    await f.alice.pool.flush()
    mockBalances.set(source.address.toLowerCase(), 64_000n)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await f.close()
  })

  it.each([false, true])('rejecting authorization cannot replay, with durable barrier=%s', async barrier => {
    let digest = ''
    const durable = jest.fn(async () => {
      expect(f.alice.getNativeOperations!().length).toBeGreaterThan(0)
    })
    const request = {
      wallet: f.alice,
      recipient: f.bob.identity.address,
      items: [{ type: 'text' as const, text: 'authorized only after approval' }],
      stampValue: 1_000n,
      messageId: '00000000-0000-4000-8000-000000000999',
      ...(barrier ? { onEnvelopeDurable: durable } : {}),
    }
    await expect(f.chain.directMessages.send({
      ...request,
      onBeforeExposure: value => { digest = value; throw new Error('authorization rejected') },
    })).rejects.toThrow('authorization rejected')
    expect(digest).not.toBe('')
    expect(durable).not.toHaveBeenCalled()
    expect(f.alice.getNativeOperations!()).toEqual([])
    for (let i = 0; i < 2; i++)
      expect(await f.chain.directMessages.reconcileAttempts({
        wallet: f.alice, payloadDigests: [digest], maxPutAttempts: 2,
      })).toEqual({ [digest]: 'unknown' })
    expect(inbox).toHaveLength(0)

    // Rejection created no attempt: the same stable ID can be authorized normally.
    const result = await f.chain.directMessages.send({
      ...request,
      onBeforeExposure: () => { expect(f.alice.getNativeOperations!()).toEqual([]) },
    })
    if (barrier) expect(durable).toHaveBeenCalledTimes(1)
    expect(inbox).toHaveLength(1)
    await expect(f.chain.directMessages.send(request)).rejects.toBeInstanceOf(DirectMessageAlreadyAttemptedError)
    await f.chain.directMessages.reconcileAttempts({
      wallet: f.alice, payloadDigests: [result.payloadDigest], maxPutAttempts: 2,
    })
    expect(inbox).toHaveLength(1)
  })
})
