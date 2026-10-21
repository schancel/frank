/** Real browser-shaped WS transport through two Rust cfg(test) relay routers. */
import NodeWebSocket from 'ws'
import {
  GroupRelayClient,
  createGroupOnRelay,
  rotateGroupEpochOnRelay,
} from './group-relay-client'
import { sealGroupMessage } from './group-crypto'
import { GROUP_TEST_ACCOUNTS, groupTestSigningKey } from './group-test.testutil'

const originUrl = process.env.FRANK_GROUP_HTTP_ORIGIN_URL
const homeUrl = process.env.FRANK_GROUP_HTTP_HOME_URL
const integration = originUrl && homeUrl ? test : test.skip
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 20_000
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for live delivery')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

integration(
  'foreign group wakes, reconnects, catches missed ranges and revokes stale epochs through Home Relay only',
  async () => {
    const origin = new GroupRelayClient(originUrl!)
    const urls: string[] = []
    const sockets: NodeWebSocket[] = []
    const home = new GroupRelayClient(originUrl!, {
      homeRelayUrl: homeUrl!,
      subscriberTag: async () => 'cc'.repeat(32),
      webSocketFactory: (url) => {
        urls.push(url)
        const socket = new NodeWebSocket(url)
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const [alice, bob, charlie] = GROUP_TEST_ACCOUNTS
    const created = await createGroupOnRelay({
      client: origin,
      groupName: 'Live foreign group',
      creatorAddress: alice.address,
      creatorIdentityPubKeyHex: alice.publicKeyHex,
      members: [bob, charlie],
    })
    const id = created.identity.groupIdHex
    const seal = (text: string, keys = created.epochKeys) =>
      sealGroupMessage({
        epochKeys: keys,
        senderIndex: 1,
        senderEpochKeyPair: groupTestSigningKey(bob.address, id, keys.epoch),
        senderAddress: bob.address,
        payload: text,
        timestampMs: 1700000001234,
      })
    let cursor = 0,
      wakes = 0,
      writes = 0
    const receipts = new Map<number, string>()
    const sync = async (token = created.epochKeys.readTokenHex) => {
      wakes++
      while (true) {
        const batch = await home.fetchGroupMessages(id, token, cursor)
        for (const row of batch.messages) {
          expect(receipts.has(row.server_seq)).toBe(false)
          receipts.set(row.server_seq, row.ciphertext)
          writes++
          cursor = row.server_seq
        }
        if (!batch.messages.length) return
      }
    }
    let live = home.subscribeGroupMessages(
      id,
      0,
      created.epochKeys.readTokenHex,
      () => sync(),
    )
    try {
      await waitFor(() => wakes > 0)
      // A second authorized reader promotes this foreign group to a Home Relay mirror.
      await new GroupRelayClient(originUrl!, {
        homeRelayUrl: homeUrl!,
        subscriberTag: async () => 'dd'.repeat(32),
      }).fetchGroupMessages(id, created.epochKeys.readTokenHex)
      // No cross-relay NATS event: the server's bounded foreign probe must repair this missed notification.
      await origin.sendGroupMessage(id, seal('foreign missed wake'))
      await waitFor(() => cursor === 1)
      sockets.at(-1)!.terminate()
      await origin.sendGroupMessage(id, seal('during disconnect'))
      await waitFor(() => sockets.length >= 2 && cursor === 2)
      live.close()
      await origin.sendGroupMessage(id, seal('while stopped'))
      const stoppedWakes = wakes
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(wakes).toBe(stoppedWakes)
      // New subscription represents startup with the original durable receipt-derived cursor.
      live = home.subscribeGroupMessages(
        id,
        0,
        created.epochKeys.readTokenHex,
        () => sync(),
      )
      await waitFor(() => cursor === 3)
      const oldSocket = sockets.at(-1)!
      let revoked = false
      oldSocket.once('close', () => {
        revoked = true
      })
      const rotated = await rotateGroupEpochOnRelay({
        client: origin,
        groupIdHex: id,
        groupPubKeyHex: created.identity.groupPubKeyHex,
        prevEpoch: 0,
        prevEpochHashHex: created.epochHash,
        prevEpochSecret: created.epochKeys.epochSecret,
        freshEntropy: new Uint8Array(32).fill(0x91),
        groupName: 'Live foreign group',
        members: [{ ...alice, role: 'admin' }, bob],
        authorityPrivateKey: created.identity.groupSecretKey,
      })
      await waitFor(() => revoked)
      // Charlie was removed. Omitting the upstream must not authenticate against the
      // promoted mirror's stale old certificate and read capability.
      const omitted = new NodeWebSocket(
        `${homeUrl!.replace(/^http/, 'ws')}/groups/${id}/live`,
      )
      sockets.push(omitted)
      await new Promise<void>((resolve, reject) => {
        omitted.once('open', resolve)
        omitted.once('error', reject)
      })
      let leakedWake = false
      omitted.on('message', () => {
        leakedWake = true
      })
      omitted.send(
        JSON.stringify({
          epoch: 0,
          read_token: created.epochKeys.readTokenHex,
        }),
      )
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          omitted.once('close', resolve)
          deadline = setTimeout(
            () =>
              reject(new Error('Stale mirror subscription remained active')),
            20_000,
          )
        })
      } finally {
        if (deadline) clearTimeout(deadline)
      }
      expect(leakedWake).toBe(false)
      await expect(
        home.fetchGroupMessages(id, created.epochKeys.readTokenHex, cursor),
      ).rejects.toThrow()
      live.close()
      await origin.sendGroupMessage(id, seal('new epoch', rotated.epochKeys))
      live = home.subscribeGroupMessages(
        id,
        1,
        rotated.epochKeys.readTokenHex,
        () => sync(rotated.epochKeys.readTokenHex),
      )
      await waitFor(() => cursor === 4)
      expect(writes).toBe(4)
      expect([...receipts.keys()]).toEqual([1, 2, 3, 4])
      for (const url of urls) {
        const parsed = new URL(url)
        expect(parsed.host).toBe(new URL(homeUrl!).host)
        expect(parsed.search).toBe('')
        expect(parsed.username).toBe('')
        expect(url).not.toContain(created.epochKeys.readTokenHex)
        expect(url).not.toContain(rotated.epochKeys.readTokenHex)
      }
    } finally {
      live.close()
      for (const socket of sockets) socket.terminate()
    }
  },
  90_000,
)

integration(
  'local durable append immediately wakes Home Relay clients',
  async () => {
    const client = new GroupRelayClient(homeUrl!, {
      webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocket,
    })
    const [alice] = GROUP_TEST_ACCOUNTS
    const created = await createGroupOnRelay({
      client,
      groupName: 'Immediate local wake',
      creatorAddress: alice.address,
      creatorIdentityPubKeyHex: alice.publicKeyHex,
    })
    let cursor = 0,
      wakes = 0
    let arrived!: () => void
    const received = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const live = client.subscribeGroupMessages(
      created.identity.groupIdHex,
      0,
      created.epochKeys.readTokenHex,
      async () => {
        wakes++
        const batch = await client.fetchGroupMessages(
          created.identity.groupIdHex,
          created.epochKeys.readTokenHex,
          cursor,
        )
        if (batch.messages.length) {
          cursor = batch.messages.at(-1)!.server_seq
          arrived()
        }
      },
    )
    try {
      await waitFor(() => wakes > 0)
      // Wait out the coalescing interval, leaving the five-second repair probe well in the future.
      await new Promise((resolve) => setTimeout(resolve, 300))
      await client.sendGroupMessage(
        created.identity.groupIdHex,
        sealGroupMessage({
          epochKeys: created.epochKeys,
          senderIndex: 0,
          senderEpochKeyPair: groupTestSigningKey(
            alice.address,
            created.identity.groupIdHex,
            0,
          ),
          senderAddress: alice.address,
          payload: 'local immediate',
          timestampMs: 1700000001234,
        }),
      )
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          received,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () =>
                reject(new Error('Local event bus did not wake immediately')),
              2000,
            )
          }),
        ])
      } finally {
        if (deadline) clearTimeout(deadline)
      }
      expect(cursor).toBe(1)
    } finally {
      live.close()
    }
  },
  30_000,
)
