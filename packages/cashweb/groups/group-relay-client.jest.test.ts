import {
  GROUP_TEST_ACCOUNTS,
  groupTestPaymentFor,
  groupTestSigningKey,
} from './group-test.testutil'
import type { AxiosInstance } from 'axios'
import {
  decryptGroupRoster,
  encryptGroupRoster,
  signEpochFrame,
  deriveNextEpochSecret,
  bytesToHex,
  openGroupMessage,
  sealGroupMessage,
  verifyEpochFrame,
} from './group-crypto'
import {
  GroupRelayClient,
  createGroupOnRelay,
  rotateGroupEpochOnRelay,
  openGroupEpochCertificate,
  groupEpochCertificate,
  GroupWriteDeferredError,
  GroupWriteRefusedError,
  type StoredGroupMessageWire,
} from './group-relay-client'

/** The last message PUT body the simulated relay received. */
let lastMessageBody: Record<string, unknown> | undefined

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
          lastMessageBody = body
          const list = messages.get(groupId) ?? []
          const serverSeq = list.length + 1
          const row: StoredGroupMessageWire = {
            group_id: groupId,
            server_seq: serverSeq,
            epoch: Number(body.epoch),
            nonce: String(body.nonce),
            ciphertext: String(body.ciphertext),
            write_sig: String(body.write_sig),
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

  it('rejects unsupported relay paths at client/config and signed-roster admission', async () => {
    expect(() => new GroupRelayClient('https://relay.example/api')).toThrow(
      /relay URL/,
    )
    expect(
      () =>
        new GroupRelayClient('https://relay.example', {
          homeRelayUrl: 'https://home.example/api',
        }),
    ).toThrow(/relay URL/)
    const mock = createMockGroupRelayAxios()
    const client = new GroupRelayClient('https://relay.example', {
      axiosInstance: mock.axiosInstance,
    })
    const created = await createGroupOnRelay({
      client,
      groupName: 'Valid',
      creatorAddress: alice.address,
      creatorIdentityPubKeyHex: alice.publicKeyHex,
      members: [bob],
    })
    const certificate = signEpochFrame({
      groupIdHex: created.identity.groupIdHex,
      groupPubKeyHex: created.identity.groupPubKeyHex,
      epoch: 0,
      epochKeys: created.epochKeys,
      encryptedRoster: encryptGroupRoster(
        { ...created.roster, homeRelay: 'https://relay.example/api' },
        created.epochKeys,
      ),
      authorityPrivateKey: created.identity.groupSecretKey,
    })
    expect(() =>
      openGroupEpochCertificate({
        groupIdHex: created.identity.groupIdHex,
        groupPubKeyHex: created.identity.groupPubKeyHex,
        epochSecretHex: created.epochKeys.epochSecretHex,
        certificate: groupEpochCertificate(certificate),
      }),
    ).toThrow(/relay URL/)
  })

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

    const payment = groupTestPaymentFor(
      {
        network: 'monad-testnet',
        priceWei: 1000n,
        priceVersion: 0,
        minPriceWei: 1000n,
        hostOrigin: client.relayUrl,
        payee: '0x000000000000000000000000000000000000dEaD',
      },
      created.identity.groupIdHex,
      sealed,
    )
    const sendRes = await client.sendGroupMessage(
      created.identity.groupIdHex,
      sealed,
      payment,
    )
    expect(sendRes.server_seq).toBe(1)
    expect(lastMessageBody?.payment).toEqual(payment)

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
    expect(rotated.epochSecretHex).not.toBe(
      bytesToHex(
        deriveNextEpochSecret(
          created.epochKeys.epochSecret,
          created.identity.groupIdHex,
          1,
        ),
      ),
    )
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

describe('group write refusals', () => {
  /** A relay whose every write PUT answers `status` with `body`. */
  function answering(status: number, body: unknown) {
    const put = jest.fn(async () => {
      // What axios rejects with for an HTTP error answer.
      throw Object.assign(
        new Error(`Request failed with status code ${status}`),
        {
          isAxiosError: true,
          response: { status, data: body },
        },
      )
    })
    return new GroupRelayClient('https://relay.example', {
      axiosInstance: { put } as unknown as AxiosInstance,
    })
  }
  const write = (client: GroupRelayClient) =>
    client.sendGroupMessage(
      '11'.repeat(32),
      {
        epoch: 0,
        nonce: '22'.repeat(24),
        ciphertext: '33'.repeat(8),
        write_sig: '44'.repeat(64),
      },
      { network: 'monad-testnet', raw_transaction: '00' },
    )

  test('only a refusal before anything was stored is definitive', async () => {
    for (const [status, body] of [
      [402, { error: 'group_payment_invalid', reason: 'underpaid' }],
      [402, { error: 'group_payment_unfunded', reason: 'stale_nonce' }],
      [402, { error: 'group_payment_required', reason: 'missing' }],
      [403, { error: 'invalid write_sig' }],
      [404, { error: 'group not found' }],
    ] as const)
      await expect(write(answering(status, body))).rejects.toBeInstanceOf(
        GroupWriteRefusedError,
      )
    // A gateway error, a malformed-request answer, a 402 that is not the host's payment
    // refusal, or a retryable check: the write may still have been stored.
    for (const [status, body] of [
      [400, { error: 'bad input' }],
      [402, { error: 'payment required' }],
      [408, {}],
      [429, {}],
      [502, { error: 'upstream relay unreachable' }],
      [503, { error: 'group_writes_unavailable' }],
      [504, { error: 'upstream relay timed out' }],
    ] as const) {
      const error = await write(answering(status, body)).catch(e => e)
      expect(error).not.toBeInstanceOf(GroupWriteRefusedError)
      expect(error).not.toBeInstanceOf(GroupWriteDeferredError)
      expect(error.response?.status).toBe(status)
    }
  })

  test('a payment the host cannot accept yet defers the write, never refuses it', async () => {
    for (const [body, reason] of [
      [{ error: 'group_payment_not_ready', reason: 'nonce_gap' }, 'nonce_gap'],
      [
        { error: 'group_payment_not_ready', reason: 'insufficient_balance' },
        'insufficient_balance',
      ],
      [
        {
          error: 'group_payment_check_unavailable',
          reason: 'node_unavailable',
        },
        'node_unavailable',
      ],
    ] as const) {
      const error = await write(answering(503, body)).catch(e => e)
      expect(error).toBeInstanceOf(GroupWriteDeferredError)
      expect(error.reason).toBe(reason)
    }
  })
})
