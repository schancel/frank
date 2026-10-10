/**
 * Usernames against the REAL relay binary, through the real TypeScript clients.
 *
 * Starts `cashwebd-exe` on a loopback port with a fresh database and the `[registry.directory]`
 * section, opens two real typed wallets, publishes their directory entries the way a bot does,
 * and then claims, contests, looks up and searches names. No chain is involved: the mailbox and
 * the chain proxies are left off, and nothing here sends a message or a transaction.
 *
 * Needs a built relay: set CASHWEBD_BIN, or build one with
 * `cargo build -p cashwebd-exe` in backend/cashweb. Without either the suite is skipped.
 */
import { ChildProcess, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { deriveDomainRoot } from '@frank/domain-roots'
import {
  UsernameError,
  claimUsername,
  lookupUsername,
  searchUsernames,
  usernamesOfAddresses,
} from '@frank/cashweb/relay/username-client'
import type { OpenDirectory } from '@frank/cashweb/relay/open-directory'
import { InMemoryNativeTransactionAttemptStore } from '@frank/wallet/chain/chain-wallet'
import { createEvmChain } from '@frank/wallet/chain/monad-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import { createRelayUsernameLookup } from '../mail-gateway/src/smtp/inbound-server'
import { openBotDirectory } from './bot-open-directory'

const NETWORK = 'monad-testnet'
const REPO_ROOT = join(__dirname, '..', '..')
const relayBinary =
  process.env.CASHWEBD_BIN ??
  ['debug', 'release']
    .map(profile =>
      join(REPO_ROOT, 'backend', 'cashweb', 'target', profile, 'cashwebd-exe'),
    )
    .find(existsSync)

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const suite = relayBinary ? describe : describe.skip
if (!relayBinary)
  console.warn(
    'usernames-real-relay: SKIPPED, no relay binary (set CASHWEBD_BIN or build cashwebd-exe)',
  )

suite('usernames on the real relay', () => {
  jest.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), 'usernames-real-relay-'))
  let relay: ChildProcess | undefined
  let relayLog = ''
  let relayBaseUrl = ''
  const closers: (() => Promise<unknown>)[] = []

  async function startRelay(port: number) {
    relayBaseUrl = `http://127.0.0.1:${port}`
    const config = join(root, 'cashwebd.toml')
    writeFileSync(
      config,
      `host = "127.0.0.1:${port}"
url = "${relayBaseUrl}"

[registry]
db_path = "${join(root, 'registry.rocksdb')}"
net = "mainnet"
peers = []
public_relay_urls = []

[registry.directory]
network = "${NETWORK}"
relay_id = "0102030405060708090a0b0c0d0e0f10"
relay_identity = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
endpoint = "${relayBaseUrl}"
binding_expiry_ns = "${
        BigInt(Date.now() + 2 * 365 * 24 * 3600 * 1000) * 1_000_000n
      }"

[registry.monad_mailbox]
enabled = false

[registry.pop]
enabled = false
monad_rpc_url = "http://unused.invalid"
hmac_secret = "unused-because-pop-is-disabled"
payment_recipient = "0x0000000000000000000000000000000000000000"
min_value_wei = "0"
`,
    )
    const child = spawn(relayBinary!, [config], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    relay = child
    child.stdout!.on('data', chunk => (relayLog += chunk))
    child.stderr!.on('data', chunk => (relayLog += chunk))
    const deadline = Date.now() + 60_000
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(
          `the relay exited at startup:\n${relayLog.slice(-4000)}`,
        )
      const info = await fetch(`${relayBaseUrl}/relay/v1/info`).catch(
        () => undefined,
      )
      if (info?.ok) return
      if (Date.now() > deadline)
        throw new Error(`the relay did not start:\n${relayLog.slice(-4000)}`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  async function stopRelay() {
    const child = relay
    relay = undefined
    if (!child || child.exitCode !== null) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }

  /** A real typed wallet with fresh random keys, living on the relay under test. */
  async function account(name: string) {
    const seed = randomBytes(32)
    const roots: MonadRootBundle = {
      evm: deriveDomainRoot(seed, 'evm-wallet'),
      authentication: deriveDomainRoot(seed, 'identity-authentication'),
      messaging: deriveDomainRoot(seed, 'messaging-encryption'),
    }
    const wallet = (await createEvmChain({
      networkId: NETWORK,
      rpcChain: NETWORK,
      chainId: 10143,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      relayBaseUrl,
      networkTag: 'MONT',
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      defaultStampValueWei: 1_000n,
      defaultTopicVoteValueWei: 1_000n,
      subAccountPoolSize: 0,
      walletStorageLocation: join(root, `${name}-wallet`),
    }).createWallet(roots)) as EvmChainWalletHandle
    closers.push(() => wallet.close())
    const directory: OpenDirectory = openBotDirectory({
      handle: wallet,
      networkTag: 'MONT',
      relayBaseUrl,
      location: join(root, `${name}-directory`),
    })
    closers.push(() => directory.close())
    return {
      wallet,
      directory,
      address: wallet.identity.address.raw.toLowerCase(),
      subject: Buffer.from(wallet.identity.compressedPubKey).toString('hex'),
      claim: (username: string) =>
        claimUsername({
          relayBaseUrl,
          network: NETWORK,
          signer: wallet.identity,
          username,
        }),
    }
  }

  const refusal = async (attempt: Promise<unknown>) => {
    const error = await attempt.then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(UsernameError)
    return (error as UsernameError).code
  }

  afterAll(async () => {
    for (const close of closers.splice(0).reverse())
      await close().catch(() => undefined)
    await stopRelay()
    rmSync(root, { recursive: true, force: true })
  })

  it('one account registers a name, another cannot take it, and it is found by lookup and by prefix', async () => {
    const port = await freePort()
    await startRelay(port)
    const alice = await account('alice')
    const bob = await account('bob')
    // Unique per run so the assertions about search do not depend on anything else.
    const tag = randomBytes(4).toString('hex')
    const name = `alice-${tag}`

    // Nobody has it yet.
    expect(
      await lookupUsername({ relayBaseUrl, username: name }),
    ).toBeUndefined()
    expect(await searchUsernames({ relayBaseUrl, prefix: 'alice-' })).toEqual(
      [],
    )

    // An account that has not published its directory entry cannot hold a name: a name must
    // resolve to someone who can be messaged.
    expect(await refusal(alice.claim(name))).toBe('not-published')

    await alice.directory.publish()
    await bob.directory.publish()

    // Alice registers the name (typed with an @ and capitals, as a person would).
    const claimed = await alice.claim(`@${name.toUpperCase()}`)
    expect(claimed).toEqual({
      username: name,
      address: alice.address,
      subject: alice.subject,
    })

    // Bob cannot register the same name, and the name still points to Alice.
    expect(await refusal(bob.claim(name))).toBe('taken')
    // Alice claiming it again changes nothing.
    expect(await alice.claim(name)).toEqual(claimed)
    // An invalid name is refused by the relay.
    expect(await refusal(bob.claim('ab'))).toBe('invalid-username')

    // Looking the name up returns Alice's identity...
    const found = await lookupUsername({ relayBaseUrl, username: `@${name}` })
    expect(found).toEqual(claimed)
    // ...and that identity can be messaged: Bob's own directory client resolves the address to
    // Alice's published, verified entry (the lookup every send starts with).
    const entry = await bob.directory.lookup(found!.address)
    expect(entry.subject).toBe(alice.subject)
    expect(entry.address).toBe(alice.address)

    // Found by prefix, and by the address that holds it.
    const bobName = `bob-${tag}`
    expect((await bob.claim(bobName)).address).toBe(bob.address)
    expect(
      (
        await searchUsernames({
          relayBaseUrl,
          prefix: `Alice-${tag.slice(0, 3)}`,
        })
      ).map(user => [user.username, user.address]),
    ).toEqual([[name, alice.address]])
    expect(
      (
        await searchUsernames({ relayBaseUrl, prefix: 'alice-', limit: 10 })
      ).map(user => user.username),
    ).toEqual([name])
    expect(
      (
        await usernamesOfAddresses({
          relayBaseUrl,
          addresses: [bob.address, '0x' + '11'.repeat(20), alice.address],
        })
      ).map(user => user.username),
    ).toEqual([bobName, name])

    // The mail gateway's own inbound lookup resolves the name to Alice's address.
    const gateway = await createRelayUsernameLookup(relayBaseUrl)(name)
    expect(gateway?.accountAddress).toBe(alice.address)
    expect(gateway?.isTombstoned).toBe(false)
    expect(gateway?.isMoved).toBe(false)
    expect(
      await createRelayUsernameLookup(relayBaseUrl)(`nobody-${tag}`),
    ).toBeUndefined()

    // The name survives a relay restart on the same database.
    await stopRelay()
    await startRelay(port)
    expect(await lookupUsername({ relayBaseUrl, username: name })).toEqual(
      claimed,
    )
    expect(await refusal(bob.claim(name))).toBe('taken')

    // Alice changes her name: the old one is released and Bob can then take it.
    const renamed = `alicia-${tag}`
    expect((await alice.claim(renamed)).username).toBe(renamed)
    expect(
      await lookupUsername({ relayBaseUrl, username: name }),
    ).toBeUndefined()
    expect(
      (await lookupUsername({ relayBaseUrl, username: renamed }))?.address,
    ).toBe(alice.address)
    expect((await bob.claim(name)).address).toBe(bob.address)
    expect(
      await lookupUsername({ relayBaseUrl, username: bobName }),
    ).toBeUndefined()
  })
})
