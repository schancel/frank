import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeCanonical, fromHex, toHex } from '@frank/codec'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import type {
  Checkpoint,
  Context,
  DirectoryStore,
} from '@frank/directory-admission'
import {
  createDirectoryClient,
  DirectoryClientError,
  DirectoryFetch,
} from './directory-client'
const source = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../docs/protocol/proposals/suite1-directory/vectors.json',
    ),
    'utf8',
  ),
)
const corpus = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../docs/protocol/cbor/vectors/directory-admission.json',
    ),
    'utf8',
  ),
)
const record = (id: string) =>
  source.records.find((r: { id: string }) => r.id === id)
const bootstrap = fromHex(record('bootstrap').type2_hex)
const renew = fromHex(record('renew').type2_hex)
const relayMap = decodeCanonical(
  fromHex(source.synthetic_relay_cbor_hex),
) as Map<bigint, any>
const relay = {
  unknownFields: new Map(),
  relayId: relayMap.get(0n),
  endpoint: relayMap.get(1n),
  identity: { keyType: 1, keyBytes: relayMap.get(2n).get(1n) },
  expiry: {
    seconds: relayMap.get(3n).get(0n),
    nanoseconds: Number(relayMap.get(3n).get(1n)),
  },
}
const context = (): Context => ({
  now: { seconds: 1700000100n, nanoseconds: 0 },
  relay,
})
let root: string, store: DirectoryStore, saves: Checkpoint[]
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'directory-client-'))
  saves = []
  store = await openNodeDirectoryStore({
    location: join(root, 'db'),
    anchor: {
      network: corpus.network,
      subject: { keyType: 1, keyBytes: fromHex(corpus.subject) },
      revisionZero: fromHex(record('bootstrap').t1),
    },
    mode: { kind: 'new' },
  })
})
afterEach(async () => {
  await store.close()
  rmSync(root, { recursive: true, force: true })
})
function client(fetcher: DirectoryFetch, currentContext = context) {
  return createDirectoryClient({
    network: corpus.network,
    subject: corpus.subject,
    endpoint: relay.endpoint,
    store,
    context: currentContext,
    fetch: fetcher,
    saveCheckpoint: async checkpoint => {
      saves.push(checkpoint)
    },
  })
}
function fetchBytes(bytes: Uint8Array): DirectoryFetch {
  return async (url, init) => {
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    let read = false
    return {
      status: 200,
      url,
      headers: {
        get: name =>
          name === 'content-type'
            ? 'application/vnd.frank.cbor'
            : name === 'x-frank-directory-evidence'
            ? url.endsWith('/head')
              ? 'fresh-current'
              : 'historical'
            : null,
      },
      body: {
        getReader: () => ({
          read: async () =>
            read
              ? { done: true }
              : ((read = true), { done: false, value: bytes.slice() }),
          cancel: async () => {},
        }),
      },
    }
  }
}
test('exact remote bytes independently enroll; prospective continuity precedes commit and history stays historical', async () => {
  const api = client(fetchBytes(bootstrap))
  const current = await api.current()
  expect(current.kind).toBe('fresh-current')
  expect(current.t1).toBe(record('bootstrap').t1)
  expect(saves[0].kind).toBe('ProspectiveEnrollment')
  expect(saves[saves.length - 1].kind).toBe('CommittedPrefix')
  const history = await api.historical(current.t1)
  expect(history.kind).toBe('historical')
  expect(history.frame).toEqual(bootstrap)
})
test('old duplicate resolves against actual descendant head without resurrecting old current', async () => {
  await client(fetchBytes(bootstrap)).current()
  const api = client(fetchBytes(renew))
  const current = await api.current()
  expect(current.t1).toBe(record('renew').t1)
  // A duplicate server response cannot override the independently retained current head.
  const old = await client(fetchBytes(bootstrap)).current()
  expect(old.t1).toBe(current.t1)
})
test('lost PUT retains exact attempt and prior external checkpoint without an automatic retry', async () => {
  await client(fetchBytes(bootstrap)).current()
  let calls = 0
  const api = client(async () => {
    calls++
    throw new Error('disconnect')
  })
  const attempt = await api.preparePut(renew)
  await expect(api.put(attempt)).rejects.toMatchObject({
    disposition: 'outcome-unknown',
  })
  expect(calls).toBe(1)
  expect(attempt.bytes).toEqual(renew)
  expect(attempt.t1).toBe(record('renew').t1)
  expect(toHex(attempt.priorCheckpoint!.head!)).toBe(record('bootstrap').t1)
})
test('redirected, wrong media, wrong binding, expired and unauthenticated history fail closed', async () => {
  const redirect: DirectoryFetch = async (url, init) => ({
    ...(await fetchBytes(bootstrap)(url, init)),
    url: 'https://other.invalid',
  })
  await expect(client(redirect).current()).rejects.toBeInstanceOf(
    DirectoryClientError,
  )
  const wrongMedia: DirectoryFetch = async (url, init) => ({
    ...(await fetchBytes(bootstrap)(url, init)),
    headers: { get: () => 'application/json' },
  })
  await expect(client(wrongMedia).current()).rejects.toThrow()
  await expect(
    client(fetchBytes(bootstrap), () => ({
      ...context(),
      relay: { ...relay, relayId: new Uint8Array(16) },
    })).current(),
  ).rejects.toThrow()
  await expect(
    client(fetchBytes(bootstrap), () => ({
      ...context(),
      now: { seconds: 1800000000n, nanoseconds: 0 },
    })).current(),
  ).rejects.toThrow()
  await expect(
    client(fetchBytes(bootstrap)).historical(record('bootstrap').t1),
  ).rejects.toThrow()
})
test('failed committed continuity stops further use until caller performs verified reopen', async () => {
  const api = createDirectoryClient({
    network: corpus.network,
    subject: corpus.subject,
    endpoint: relay.endpoint,
    store,
    context,
    fetch: fetchBytes(bootstrap),
    saveCheckpoint: async checkpoint => {
      if (checkpoint.kind === 'CommittedPrefix')
        throw new Error('checkpoint IO')
    },
  })
  await expect(api.current()).rejects.toThrow('checkpoint IO')
  await expect(api.current()).rejects.toThrow('verified reopen')
})

test('65s transport budget returns unknown PUT without retry even if an injected fetch stalls', async () => {
  let calls = 0
  const api = client(() => {
    calls++
    return new Promise(() => {})
  })
  const attempt = await api.preparePut(bootstrap)
  jest.useFakeTimers()
  try {
    const response = api.put(attempt)
    const rejected = expect(response).rejects.toMatchObject({
      disposition: 'outcome-unknown',
    })
    await jest.advanceTimersByTimeAsync(65000)
    await rejected
    expect(calls).toBe(1)
  } finally {
    jest.useRealTimers()
  }
})
