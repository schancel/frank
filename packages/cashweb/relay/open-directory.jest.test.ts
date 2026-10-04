/**
 * The open directory against a stand-in relay, with real Level admission stores and the real
 * codec. Each "device" has its own storage directory.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toHex, verifyPreviewDirectoryEvidence } from '@frank/codec'
import {
  OpenDirectoryError,
  openDirectory,
  type OpenDirectory,
} from './open-directory'
import { nodeDirectoryStorage } from './open-directory-node'
import {
  createFakeRelay,
  testAccount,
  type FakeRelay,
} from './open-directory-fake-relay.testutil'

const NETWORK = 'monad-testnet'
const SECOND = 1_000_000_000n
const DAY = 86_400n * SECOND
const START = 1_800_000_000n * SECOND
const stamp = (ns: bigint) => ({
  seconds: ns / SECOND,
  nanoseconds: Number(ns % SECOND),
})

let root: string
let clock: bigint
let wall: number
let relay: FakeRelay
const opened: OpenDirectory[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'open-directory-'))
  clock = START
  wall = 1_000_000
  jest.spyOn(Date, 'now').mockImplementation(() => wall)
  relay = createFakeRelay()
})
afterEach(async () => {
  for (const directory of opened.splice(0)) await directory.close()
  jest.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** One device of one account: own storage, signing with that account's key. */
function device(
  account: ReturnType<typeof testAccount>,
  name: string,
  on: FakeRelay = relay,
) {
  const signed: bigint[] = []
  const directory = openDirectory({
    network: NETWORK,
    relayBaseUrl: on.endpoint,
    nowNs: () => clock,
    fetch: on.fetch,
    ...nodeDirectoryStorage(join(root, name)),
    self: {
      subject: account.subject,
      signRevisionZero(input) {
        signed.push(0n)
        return account.sign({
          network: NETWORK,
          revision: 0n,
          predecessor: null,
          ...input,
        })
      },
      signNextRevision(input) {
        signed.push(input.revision)
        return account.sign({ network: NETWORK, ...input })
      },
    },
  })
  opened.push(directory)
  return { directory, signed }
}
const code = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    if (error instanceof OpenDirectoryError) return error.code
    throw error
  }
  return 'no error'
}
const puts = () => relay.requests.filter(r => r.method === 'PUT').length
/** A relay-side chain for an account that this test signs directly. */
function chainOf(
  account: ReturnType<typeof testAccount>,
  revisions: number,
  on: FakeRelay = relay,
  issued = START - 3600n * SECOND,
) {
  const chain: Uint8Array[] = []
  let predecessor: Uint8Array | null = null
  for (let revision = 0; revision < revisions; revision++) {
    const bytes = account.sign({
      network: NETWORK,
      revision: BigInt(revision),
      predecessor,
      issuedAt: stamp(issued + BigInt(revision) * SECOND),
      expiresAt: stamp(issued + 365n * DAY),
      relay: on.binding,
    })
    predecessor = verifyPreviewDirectoryEvidence(bytes, NETWORK).statementHash
    chain.push(bytes)
  }
  return chain
}

describe('own entry', () => {
  it('publishes revision zero for a new account with one signature and no user step', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    await expect(directory.selfCurrent()).rejects.toMatchObject({
      code: 'unpublished',
    })
    const published = await directory.publish()
    expect(published.address).toBe(alice.address)
    expect(published.endpoint).toBe(relay.endpoint)
    expect(published.current.revision).toBe(0n)
    expect(signed).toEqual([0n])
    expect(relay.chain(alice.subject)).toHaveLength(1)
    const statement = verifyPreviewDirectoryEvidence(
      relay.chain(alice.subject)[0],
      NETWORK,
    ).statement
    // Long validity, issued slightly in the past, bound to the relay's own tuple.
    expect(statement.expiry.seconds - statement.timestamp.seconds).toBe(
      365n * 86_400n,
    )
    expect(statement.timestamp.seconds).toBe(START / SECOND - 600n)
    expect(toHex(statement.relays[0].relayId)).toBe(
      toHex(relay.binding.relayId),
    )
    expect((await directory.selfCurrent()).revision).toBe(0n)
    // Publishing again signs nothing and stores nothing new.
    await directory.publish()
    expect(signed).toEqual([0n])
    expect(puts()).toBe(1)
  })

  it('adopts the entry the relay already has when the account is restored on a second device', async () => {
    const alice = testAccount(1)
    await device(alice, 'phone').directory.publish()
    const laptop = device(alice, 'laptop')
    const adopted = await laptop.directory.publish()
    expect(laptop.signed).toEqual([])
    expect(puts()).toBe(1)
    expect(relay.chain(alice.subject)).toHaveLength(1)
    expect(toHex(adopted.current.evidence.attestation)).toBe(
      toHex(relay.chain(alice.subject)[0]),
    )
  })

  it('adopts instead of forking when another device wins the first publish', async () => {
    const alice = testAccount(1)
    const phone = device(alice, 'phone'),
      laptop = device(alice, 'laptop')
    await phone.directory.publish()
    // The laptop asked just before the phone published, so it saw "no entry" and signs its own
    // revision zero. The relay answers 409 and the laptop adopts the phone's entry.
    let asked = false
    relay.tamper = path =>
      !asked && path.endsWith(`/${alice.subject}/head`)
        ? ((asked = true), 404)
        : undefined
    const adopted = await laptop.directory.publish()
    expect(laptop.signed).toEqual([0n])
    expect(relay.chain(alice.subject)).toHaveLength(1)
    expect(toHex(adopted.current.evidence.attestation)).toBe(
      toHex(relay.chain(alice.subject)[0]),
    )
  })

  it('reports an unreachable relay and publishes on a later attempt', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    relay.down = true
    expect(await code(directory.publish())).toBe('unreachable')
    expect(signed).toEqual([])
    relay.down = false
    await directory.publish()
    expect(relay.chain(alice.subject)).toHaveLength(1)
  })

  it('reopens its admitted entry after a restart without signing again', async () => {
    const alice = testAccount(1)
    const first = device(alice, 'alice')
    await first.directory.publish()
    await first.directory.close()
    const second = device(alice, 'alice')
    const again = await second.directory.publish()
    expect(second.signed).toEqual([])
    expect(again.current.revision).toBe(0n)
    expect(puts()).toBe(1)
  })

  it('renews with revision one when less than thirty days remain, and not before', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    await directory.publish()
    clock = START + 300n * DAY
    await directory.publish()
    expect(signed).toEqual([0n])
    clock = START + 340n * DAY
    const renewed = await directory.publish()
    expect(signed).toEqual([0n, 1n])
    expect(renewed.current.revision).toBe(1n)
    expect(relay.chain(alice.subject)).toHaveLength(2)
    const statement = verifyPreviewDirectoryEvidence(
      relay.chain(alice.subject)[1],
      NETWORK,
    ).statement
    expect(statement.expiry.seconds).toBe(
      (clock - 600n * SECOND + 365n * DAY) / SECOND,
    )
  })

  it('renews an entry that already expired, chaining from it', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    await directory.publish()
    clock = START + 400n * DAY
    const renewed = await directory.publish()
    expect(signed).toEqual([0n, 1n])
    expect(renewed.current.revision).toBe(1n)
    expect((await directory.selfCurrent()).revision).toBe(1n)
  })

  it('signs a new revision naming the new relay when the account moves', async () => {
    const alice = testAccount(1)
    await device(alice, 'old').directory.publish()
    const other = createFakeRelay({
      endpoint: 'https://relay-b.example',
      relayId: '0b'.repeat(16),
    })
    // Replication carried the entry to the new relay.
    other.replicate(relay.chain(alice.subject))
    const moved = device(alice, 'new', other)
    const entry = await moved.directory.publish()
    expect(moved.signed).toEqual([1n])
    expect(entry.endpoint).toBe('https://relay-b.example')
    expect(other.chain(alice.subject)).toHaveLength(2)
  })

  it('hands its retained chain to a relay that does not have it, signing nothing new', async () => {
    const alice = testAccount(1)
    const first = device(alice, 'alice')
    await first.directory.publish()
    await first.directory.close()
    const original = relay.chain(alice.subject)[0]
    relay = createFakeRelay()
    const second = device(alice, 'alice')
    await second.directory.publish()
    expect(second.signed).toEqual([])
    expect(toHex(relay.chain(alice.subject)[0])).toBe(toHex(original))
  })
})

describe('one signature per revision', () => {
  const putBodies = () =>
    relay.requests.filter(r => r.method === 'PUT').map(r => r.body)

  it('re-sends the identical revision zero after a failed publish', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    relay.putFault = 'lose'
    expect(await code(directory.publish())).toBe('unreachable')
    clock += 3600n * SECOND
    expect(await code(directory.publish())).toBe('unreachable')
    relay.putFault = undefined
    clock += 3600n * SECOND
    await directory.publish()
    expect(signed).toEqual([0n])
    const bodies = putBodies()
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies).size).toBe(1)
    expect(toHex(relay.chain(alice.subject)[0])).toBe(bodies[0])
  })

  it('sends the identical bytes after a crash between signing and sending', async () => {
    const alice = testAccount(1)
    const first = device(alice, 'alice')
    // The process dies inside the PUT: the request never completes and nothing is stored.
    relay.putFault = 'lose'
    await code(first.directory.publish())
    await first.directory.close()
    relay.putFault = undefined
    clock += 86_400n * SECOND
    const second = device(alice, 'alice')
    await second.directory.publish()
    expect(first.signed).toEqual([0n])
    expect(second.signed).toEqual([])
    const bodies = putBodies()
    expect(bodies[bodies.length - 1]).toBe(bodies[0])
    expect(relay.chain(alice.subject)).toHaveLength(1)
  })

  it('adopts its own entry when the relay stored it but answered with an error', async () => {
    const alice = testAccount(1)
    const first = device(alice, 'alice')
    relay.putFault = 'keep'
    expect(await code(first.directory.publish())).toBe('unreachable')
    await first.directory.close()
    relay.putFault = undefined
    const second = device(alice, 'alice')
    const entry = await second.directory.publish()
    expect(second.signed).toEqual([])
    expect(putBodies()).toHaveLength(1)
    expect(toHex(entry.current.evidence.attestation)).toBe(putBodies()[0])
  })

  it('signs a renewal once and re-sends those bytes until the relay takes them', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    await directory.publish()
    clock = START + 340n * DAY
    relay.putFault = 'lose'
    // The current entry is still valid, so messaging keeps working on it meanwhile.
    expect((await directory.publish()).current.revision).toBe(0n)
    clock += DAY
    expect((await directory.publish()).current.revision).toBe(0n)
    relay.putFault = undefined
    clock += DAY
    expect((await directory.publish()).current.revision).toBe(1n)
    expect(signed).toEqual([0n, 1n])
    const renewals = putBodies().slice(1)
    expect(renewals).toHaveLength(3)
    expect(new Set(renewals).size).toBe(1)
    expect(relay.chain(alice.subject)).toHaveLength(2)
  })
})

describe('two devices of one account renewing at the same time', () => {
  it('end on the same head with one accepted statement and no fork', async () => {
    const alice = testAccount(1)
    const phone = device(alice, 'phone')
    await phone.directory.publish()
    const laptop = device(alice, 'laptop')
    await laptop.directory.publish()
    clock = START + 340n * DAY
    // The laptop signs its renewal but the relay never gets it.
    relay.putFault = 'lose'
    await laptop.directory.publish()
    relay.putFault = undefined
    expect(laptop.signed).toEqual([1n])
    // The phone renews from the head the relay holds and is accepted.
    clock += 3600n * SECOND
    const atPhone = await phone.directory.publish()
    expect(phone.signed).toEqual([0n, 1n])
    expect(atPhone.current.revision).toBe(1n)
    // The laptop's next attempt still believes the relay is at revision zero (its read raced the
    // phone's write), re-sends its saved bytes once, gets 409, drops them and adopts the phone's.
    let stale = true
    const zero = relay.chain(alice.subject)[0]
    relay.tamper = path =>
      stale && path.endsWith(`/${alice.subject}/head`)
        ? ((stale = false), zero)
        : undefined
    const before = relay.requests.filter(r => r.method === 'PUT').length
    clock += 3600n * SECOND
    const atLaptop = await laptop.directory.publish()
    expect(relay.requests.filter(r => r.method === 'PUT')).toHaveLength(
      before + 1,
    )
    expect(toHex(atLaptop.current.evidence.attestation)).toBe(
      toHex(atPhone.current.evidence.attestation),
    )
    expect(relay.chain(alice.subject)).toHaveLength(2)
    // The dropped statement is never sent again and nothing more is signed.
    clock += 3600n * SECOND
    await laptop.directory.publish()
    expect(laptop.signed).toEqual([1n])
    expect(relay.requests.filter(r => r.method === 'PUT')).toHaveLength(
      before + 1,
    )
    // A third party sees one chain.
    const bob = device(testAccount(2), 'bob')
    await bob.directory.publish()
    expect((await bob.directory.lookup(alice.address)).current.revision).toBe(
      1n,
    )
  })

  it('re-reads the head just before signing and renews from what another device published', async () => {
    const alice = testAccount(1)
    const phone = device(alice, 'phone')
    await phone.directory.publish()
    const laptop = device(alice, 'laptop')
    await laptop.directory.publish()
    clock = START + 340n * DAY
    await phone.directory.publish()
    // The laptop's first read of this publish is stale; the read before signing is not.
    let stale = true
    const zero = relay.chain(alice.subject)[0]
    relay.tamper = path =>
      stale && path.endsWith(`/${alice.subject}/head`)
        ? ((stale = false), zero)
        : undefined
    const entry = await laptop.directory.publish()
    expect(laptop.signed).toEqual([])
    expect(entry.current.revision).toBe(1n)
    expect(relay.chain(alice.subject)).toHaveLength(2)
  })
})

describe('what the relay says about itself is not trusted blindly', () => {
  it('signs nothing when the relay names another host as its endpoint', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    relay.infoOverride = { endpoint: 'https://somewhere-else.example' }
    expect(await code(directory.publish())).toBe('relay-info')
    expect(signed).toEqual([])
    expect(puts()).toBe(0)
  })

  it('signs nothing when the relay binding lasts less than thirty days', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    relay.infoOverride = { bindingExpiry: (clock + 29n * DAY).toString() }
    expect(await code(directory.publish())).toBe('relay-info')
    expect(signed).toEqual([])
    relay.infoOverride = { bindingExpiry: (clock + 31n * DAY).toString() }
    await directory.publish()
    expect(signed).toEqual([0n])
  })

  it('signs at most one move per day however often the relay changes its tuple', async () => {
    const alice = testAccount(1)
    const { directory, signed } = device(alice, 'alice')
    await directory.publish()
    relay.infoOverride = { relayId: '01'.repeat(16) }
    await directory.publish()
    expect(signed).toEqual([0n, 1n])
    for (const id of ['02', '03', '04']) {
      relay.infoOverride = { relayId: id.repeat(16) }
      clock += 3600n * SECOND
      expect(await code(directory.publish())).toBe('relay-info')
    }
    expect(signed).toEqual([0n, 1n])
    clock += DAY
    await directory.publish()
    expect(signed).toEqual([0n, 1n, 2n])
  })

  it('does not report a move as done when the relay did not take it', async () => {
    const alice = testAccount(1)
    const { directory } = device(alice, 'alice')
    await directory.publish()
    relay.infoOverride = { relayId: '01'.repeat(16) }
    relay.putFault = 'lose'
    expect(await code(directory.publish())).toBe('unreachable')
    relay.putFault = undefined
    const entry = await directory.publish()
    expect(entry.current.revision).toBe(1n)
  })

  it('reads whether the relay forwards, and treats silence as no', async () => {
    const alice = testAccount(1)
    const { directory } = device(alice, 'alice')
    await directory.publish()
    expect(await directory.forwarding()).toBe(false)
    relay.infoOverride = { forwarding: true }
    wall += 61_000
    expect(await directory.forwarding()).toBe(true)
    relay.down = true
    wall += 61_000
    expect(await directory.forwarding()).toBe(false)
  })
})

describe('other accounts', () => {
  it('finds any published address and pins it; an unpublished one is a typed error', async () => {
    const alice = testAccount(1),
      bob = testAccount(2),
      carol = testAccount(3)
    const a = device(alice, 'alice')
    await a.directory.publish()
    await device(bob, 'bob').directory.publish()
    const found = await a.directory.lookup(
      bob.address.toUpperCase().replace('0X', '0x'),
    )
    expect(found.subject).toBe(bob.subject)
    expect(found.address).toBe(bob.address)
    expect(found.current.revision).toBe(0n)
    expect(await code(a.directory.lookup(carol.address))).toBe('not-published')
    expect(await a.directory.peerCurrent({ address: carol.address })).toBe(
      undefined,
    )
    // By key, as an inbox does for a sender it has never seen.
    expect(
      (await a.directory.peerCurrent({ subject: bob.subject }))?.address,
    ).toBe(bob.address)
    expect(await a.directory.peerCurrent({ subject: carol.subject })).toBe(
      undefined,
    )
  })

  it('finds an account that lives on another relay through replication', async () => {
    const alice = testAccount(1),
      bob = testAccount(2)
    const other = createFakeRelay({
      endpoint: 'https://relay-b.example',
      relayId: '0b'.repeat(16),
    })
    relay.peers.push(other)
    await device(bob, 'bob', other).directory.publish()
    const a = device(alice, 'alice')
    await a.directory.publish()
    const found = await a.directory.lookup(bob.address)
    expect(found.endpoint).toBe('https://relay-b.example')
  })

  it('refuses an entry signed by a key that does not hash to the requested address', async () => {
    const alice = testAccount(1),
      bob = testAccount(2),
      mallory = testAccount(9)
    const a = device(alice, 'alice')
    await a.directory.publish()
    // A perfectly valid entry, but it is Mallory's, served for Bob's address.
    const [malloryEntry] = chainOf(mallory, 1)
    relay.tamper = path =>
      path.endsWith(`/address/${bob.address}`) ? malloryEntry : undefined
    expect(await code(a.directory.lookup(bob.address))).toBe('invalid')
    // An entry that names Bob's key but is signed by Mallory.
    const forged = mallory.sign({
      network: NETWORK,
      revision: 0n,
      predecessor: null,
      issuedAt: stamp(START - 10n * SECOND),
      expiresAt: stamp(START + DAY),
      relay: relay.binding,
      claimSubject: bob.subject,
    })
    relay.tamper = path =>
      path.endsWith(`/address/${bob.address}`) ? forged : undefined
    expect(await code(a.directory.lookup(bob.address))).toBe('invalid')
    // Nothing was pinned: the real Bob is accepted afterwards.
    relay.tamper = undefined
    wall += 60_000
    await device(bob, 'bob').directory.publish()
    expect((await a.directory.lookup(bob.address)).subject).toBe(bob.subject)
  })

  it('refuses an older entry after a newer one was accepted', async () => {
    const alice = testAccount(1),
      bob = testAccount(2)
    const chain = chainOf(bob, 2)
    relay.replicate(chain)
    const a = device(alice, 'alice')
    await a.directory.publish()
    expect((await a.directory.lookup(bob.address)).current.revision).toBe(1n)
    relay.tamper = path =>
      path.endsWith(`/${bob.subject}/head`) ? chain[0] : undefined
    wall += 60_000
    expect(await code(a.directory.lookup(bob.address))).toBe('rollback')
    // The same refusal after a restart on the same storage.
    await a.directory.close()
    const again = device(alice, 'alice')
    await again.directory.publish()
    relay.tamper = path =>
      path.endsWith(`/address/${bob.address}`) ? chain[0] : undefined
    expect(await code(again.directory.lookup(bob.address))).toBe('rollback')
  })

  it('refuses a second, different chain for an address after first contact', async () => {
    const alice = testAccount(1),
      bob = testAccount(2)
    relay.replicate(chainOf(bob, 1))
    const a = device(alice, 'alice')
    await a.directory.publish()
    await a.directory.lookup(bob.address)
    const [other] = chainOf(bob, 1, relay, START - 1800n * SECOND)
    relay.tamper = path =>
      path.endsWith(`/${bob.subject}/head`) ? other : undefined
    wall += 60_000
    expect(await code(a.directory.lookup(bob.address))).toBe('fork')
    await a.directory.close()
    const again = device(alice, 'alice')
    await again.directory.publish()
    relay.tamper = path =>
      path.endsWith(`/address/${bob.address}`) ? other : undefined
    expect(await code(again.directory.lookup(bob.address))).toBe('fork')
  })

  it('enrols a peer first met at a later revision and catches up across a gap', async () => {
    const alice = testAccount(1),
      bob = testAccount(2)
    const chain = chainOf(bob, 5)
    relay.replicate(chain.slice(0, 3))
    const a = device(alice, 'alice')
    await a.directory.publish()
    expect((await a.directory.lookup(bob.address)).current.revision).toBe(2n)
    relay.replicate(chain.slice(3))
    wall += 60_000
    expect((await a.directory.lookup(bob.address)).current.revision).toBe(4n)
  })

  it('does not use an expired entry', async () => {
    const alice = testAccount(1),
      bob = testAccount(2)
    const expired = bob.sign({
      network: NETWORK,
      revision: 0n,
      predecessor: null,
      issuedAt: stamp(START - 2n * DAY),
      expiresAt: stamp(START - DAY),
      relay: relay.binding,
    })
    relay.replicate([expired])
    const a = device(alice, 'alice')
    await a.directory.publish()
    expect(await code(a.directory.lookup(bob.address))).toBe('expired')
  })

  it('asks the relay again only after the refresh interval', async () => {
    const alice = testAccount(1),
      bob = testAccount(2)
    relay.replicate(chainOf(bob, 1))
    const a = device(alice, 'alice')
    await a.directory.publish()
    await a.directory.lookup(bob.address)
    const before = relay.requests.length
    await a.directory.lookup(bob.address)
    await a.directory.peerCurrent({ subject: bob.subject })
    expect(relay.requests.length).toBe(before)
    wall += 31_000
    await a.directory.lookup(bob.address)
    expect(relay.requests.length).toBe(before + 1)
  })

  it('reports a too-long history as such, not as a forgery, and can try again', async () => {
    const alice = testAccount(1),
      bob = testAccount(2)
    const chain = chainOf(bob, 70)
    relay.replicate(chain)
    const a = device(alice, 'alice')
    await a.directory.publish()
    expect(await code(a.directory.lookup(bob.address))).toBe('history-too-long')
    // Nothing was pinned by the failed attempt: a readable chain for the address is accepted.
    relay = createFakeRelay()
    relay.replicate(chain.slice(0, 3))
    await a.directory.close()
    const again = device(alice, 'alice')
    await again.directory.publish()
    expect((await again.directory.lookup(bob.address)).current.revision).toBe(
      2n,
    )
  })

  it('blames the device clock for an entry issued in its future and for a clock that went back', async () => {
    const alice = testAccount(1),
      bob = testAccount(2),
      carol = testAccount(3)
    relay.replicate(chainOf(bob, 1, relay, START + 3600n * SECOND))
    relay.replicate(chainOf(carol, 1))
    const a = device(alice, 'alice')
    await a.directory.publish()
    expect(await code(a.directory.lookup(bob.address))).toBe('clock')
    await a.directory.lookup(carol.address)
    clock = START - 7200n * SECOND
    wall += 60_000
    expect(await code(a.directory.lookup(carol.address))).toBe('clock')
  })
})
