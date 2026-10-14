import { GROUP_TEST_ACCOUNTS, groupTestSigningKey } from './group-test.testutil'
import type { AxiosInstance } from 'axios'
import {
  decryptGroupRoster,
  openGroupMessage,
  sealGroupMessage,
  verifyEpochFrame,
} from './group-crypto'
import {
  GroupRelayClient,
  createGroupOnRelay,
  rotateGroupEpochOnRelay,
  type StoredGroupMessageWire,
} from './group-relay-client'

/**
 * In-memory simulation of the cashweb-registry `/groups/:group_id/*` HTTP endpoints
 * verifying CAS (`If-Match`), `X-Group-Read-Token`, and outer write signatures.
 */
function createMockGroupRelayAxios() {
  const epochs = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, StoredGroupMessageWire[]>()
  const calls: Array<{
    method: string
    url: string
    body?: unknown
    headers?: Record<string, string>
    params?: Record<string, unknown>
  }> = []

  const axiosMock = {
    put: jest.fn(
      async (
        url: string,
        body: Record<string, unknown>,
        config?: { headers?: Record<string, string> },
      ) => {
        calls.push({
          method: 'PUT',
          url,
          body,
          headers: config?.headers,
        })
        const epochMatch = url.match(/\/groups\/([0-9a-f]{64})\/epochs$/)
        if (epochMatch) {
          const groupId = epochMatch[1]
          const current = epochs.get(groupId)
          const epochNum = Number(body.epoch ?? 0)
          if (epochNum === 0) {
            if (current) {
              const err = new Error('Group already exists') as Error & {
                response?: { status: number }
              }
              err.response = { status: 409 }
              throw err
            }
          } else {
            const ifMatch = config?.headers?.['If-Match']
            if (!current || current.epoch_hash !== ifMatch) {
              const err = new Error('CAS mismatch') as Error & {
                response?: { status: number }
              }
              err.response = { status: 409 }
              throw err
            }
          }
          const stored = {
            ...body,
            group_id: groupId,
          }
          epochs.set(groupId, stored)
          return {
            data: {
              ...body,
              epoch: epochNum,
              epoch_hash: String(body.epoch_hash ?? ''),
            },
          }
        }

        const msgMatch = url.match(/\/groups\/([0-9a-f]{64})\/messages$/)
        if (msgMatch) {
          const groupId = msgMatch[1]
          const list = messages.get(groupId) ?? []
          const serverSeq = list.length + 1
          const row: StoredGroupMessageWire = {
            group_id: groupId,
            server_seq: serverSeq,
            epoch: Number(body.epoch),
            nonce: String(body.nonce),
            ciphertext: String(body.ciphertext),
            write_sig: String(body.write_sig),
            versionstamp: serverSeq.toString(16).padStart(20, '0'),
            server_time_ms: 1700000000000 + serverSeq,
          }
          list.push(row)
          messages.set(groupId, list)
          return {
            data: {
              ...row,
            },
          }
        }
        throw new Error(`Unhandled PUT URL: ${url}`)
      },
    ),
    get: jest.fn(
      async (
        url: string,
        config?: {
          headers?: Record<string, string>
          params?: Record<string, unknown>
        },
      ) => {
        calls.push({
          method: 'GET',
          url,
          headers: config?.headers,
          params: config?.params,
        })
        const epochMatch = url.match(/\/groups\/([0-9a-f]{64})\/epochs$/)
        if (epochMatch) {
          const groupId = epochMatch[1]
          const stored = epochs.get(groupId)
          if (!stored) {
            const err = new Error('Not found') as Error & {
              response?: { status: number }
            }
            err.response = { status: 404 }
            throw err
          }
          return { data: stored }
        }
        const msgMatch = url.match(/\/groups\/([0-9a-f]{64})\/messages$/)
        if (msgMatch) {
          const groupId = msgMatch[1]
          const afterSeq = Number(config?.params?.after_seq ?? 0)
          const limit = Number(config?.params?.limit ?? 100)
          const list = (messages.get(groupId) ?? [])
            .filter(m => m.server_seq > afterSeq)
            .slice(0, limit)
          const currentEpoch = Number(epochs.get(groupId)?.epoch ?? 0)
          return {
            data: {
              group_id: groupId,
              epoch: currentEpoch,
              messages: list,
            },
          }
        }
        throw new Error(`Unhandled GET URL: ${url}`)
      },
    ),
  }

  return {
    axiosInstance: axiosMock as unknown as AxiosInstance,
    calls,
    epochs,
    messages,
  }
}

describe('GroupRelayClient', () => {
  const [alice, bob, charlie] = GROUP_TEST_ACCOUNTS
  const [aliceAddress, bobAddress, charlieAddress] = [
    alice.address,
    bob.address,
    charlie.address,
  ]

  it('creates epoch 0 on the relay, fetches and decrypts the roster, and verifies signatures', async () => {
    const mock = createMockGroupRelayAxios()
    const client = new GroupRelayClient('https://relay.frank.example/', {
      axiosInstance: mock.axiosInstance,
    })

    const created = await createGroupOnRelay({
      client,
      groupName: 'Protocol Architects',
      creatorAddress: aliceAddress,
      creatorIdentityPubKeyHex: alice.publicKeyHex,
      members: [bob, charlie],
    })

    expect(created.epochKeys.epoch).toBe(0)
    expect(created.roster.members).toHaveLength(3)
    expect(created.roster.members[0]?.address).toBe(aliceAddress)
    expect(created.roster.members[0]?.role).toBe('admin')
    expect(created.roster.members[1]?.address).toBe(bobAddress)
    expect(created.roster.members[2]?.address).toBe(charlieAddress)

    const fetchedFrame = await client.getLatestEpoch(
      created.identity.groupIdHex,
    )
    expect(
      verifyEpochFrame(
        fetchedFrame,
        created.identity.groupIdHex,
        created.identity.groupPubKeyHex,
      ),
    ).toBe(true)

    const decryptedRoster = decryptGroupRoster(
      fetchedFrame.encrypted_roster,
      created.epochKeys,
    )
    expect(decryptedRoster).toEqual(created.roster)
  })

  it('seals, publishes, fetches, and opens group messages with per-member attribution', async () => {
    const mock = createMockGroupRelayAxios()
    const client = new GroupRelayClient('https://relay.frank.example', {
      axiosInstance: mock.axiosInstance,
    })

    const created = await createGroupOnRelay({
      client,
      groupName: 'Core Dev Group',
      creatorAddress: aliceAddress,
      creatorIdentityPubKeyHex: alice.publicKeyHex,
      members: [bob],
    })

    const bobSigningKey = groupTestSigningKey(
      bobAddress,
      created.identity.groupIdHex,
      0,
    )
    const sealed = sealGroupMessage({
      epochKeys: created.epochKeys,
      senderIndex: 1,
      senderEpochKeyPair: bobSigningKey,
      senderAddress: bobAddress,
      payload: 'Hello from Bob inside sealed group!',
      timestampMs: 1700000001234,
    })

    const sendRes = await client.sendGroupMessage(
      created.identity.groupIdHex,
      sealed,
    )
    expect(sendRes.server_seq).toBe(1)

    const fetched = await client.fetchGroupMessages(
      created.identity.groupIdHex,
      created.epochKeys.readTokenHex,
      0,
      50,
    )
    expect(fetched.messages).toHaveLength(1)

    const opened = openGroupMessage({
      envelope: fetched.messages[0],
      epochKeys: created.epochKeys,
      roster: created.roster,
    })
    expect(opened.senderIndex).toBe(1)
    expect(opened.senderAddress).toBe(bobAddress)
    expect(opened.payloadText).toBe('Hello from Bob inside sealed group!')
  })

  it('rotates group epoch with If-Match CAS header and rejects stale CAS hashes', async () => {
    const mock = createMockGroupRelayAxios()
    const client = new GroupRelayClient('https://relay.frank.example', {
      axiosInstance: mock.axiosInstance,
    })

    const created = await createGroupOnRelay({
      client,
      groupName: 'Epoch Rotation Test',
      creatorAddress: aliceAddress,
      creatorIdentityPubKeyHex: alice.publicKeyHex,
      members: [bob, charlie],
    })

    // Rotate to epoch 1 removing charlieAddress
    const rotated = await rotateGroupEpochOnRelay({
      client,
      groupIdHex: created.identity.groupIdHex,
      groupPubKeyHex: created.identity.groupPubKeyHex,
      prevEpoch: 0,
      prevEpochHashHex: created.epochHash,
      prevEpochSecret: created.epochKeys.epochSecret,
      groupName: 'Epoch Rotation Test',
      members: [{ ...alice, role: 'admin' }, bob],
      authorityPrivateKey: created.identity.groupSecretKey,
    })

    expect(rotated.epoch).toBe(1)
    expect(rotated.roster.members).toHaveLength(2)
    expect(rotated.roster.members.map(m => m.address)).toEqual([
      aliceAddress,
      bobAddress,
    ])

    // Verify If-Match header was sent on the second PUT /epochs call
    const putEpochCalls = mock.calls.filter(
      c => c.method === 'PUT' && c.url.endsWith('/epochs'),
    )
    expect(putEpochCalls).toHaveLength(2)
    expect(putEpochCalls[1]?.headers?.['If-Match']).toBe(created.epochHash)

    // Attempting another rotation with the stale epoch 0 hash must fail with 409 Conflict
    await expect(
      rotateGroupEpochOnRelay({
        client,
        groupIdHex: created.identity.groupIdHex,
        prevEpoch: 0,
        prevEpochHashHex: created.epochHash,
        prevEpochSecret: created.epochKeys.epochSecret,
        groupName: 'Stale Rotation',
        members: [{ ...alice, role: 'admin' }],
        authorityPrivateKey: created.identity.groupSecretKey,
      }),
    ).rejects.toThrow('CAS mismatch')
  })
})
