/** Actual TS transport through two Rust cfg(test) routers; run from ignored Rust harness. */
import assert from 'node:assert/strict'
import {
  GroupRelayClient,
  createGroupOnRelay,
  rotateGroupEpochOnRelay,
} from './group-relay-client'
import {
  openGroupMessage,
  sealGroupMessage,
  verifyEpochFrame,
} from './group-crypto'
import { GROUP_TEST_ACCOUNTS, groupTestSigningKey } from './group-test.testutil'

const originUrl = process.env.FRANK_GROUP_HTTP_ORIGIN_URL
const homeUrl = process.env.FRANK_GROUP_HTTP_HOME_URL
const integration = originUrl && homeUrl ? test : test.skip
integration(
  'real TS foreign-home mirror preserves unread backlog and follows rotation',
  async () => {
    const origin = new GroupRelayClient(originUrl!)
    const homeA = new GroupRelayClient(originUrl!, {
      homeRelayUrl: homeUrl!,
      subscriberTag: async () => 'aa'.repeat(32),
    })
    const homeB = new GroupRelayClient(originUrl!, {
      homeRelayUrl: homeUrl!,
      subscriberTag: async () => 'bb'.repeat(32),
    })
    const [alice, bob, charlie] = GROUP_TEST_ACCOUNTS
    const created = await createGroupOnRelay({
      client: origin,
      groupName: 'Foreign boundary',
      creatorAddress: alice.address,
      creatorIdentityPubKeyHex: alice.publicKeyHex,
      members: [bob, charlie],
    })
    const id = created.identity.groupIdHex
    const seal = (text: string, epochKeys = created.epochKeys) =>
      sealGroupMessage({
        epochKeys,
        senderIndex: 1,
        senderEpochKeyPair: groupTestSigningKey(
          bob.address,
          id,
          epochKeys.epoch,
        ),
        senderAddress: bob.address,
        payload: text,
        timestampMs: 1700000001234,
      })
    const initialEnvelope = seal('Initial')
    const initialReceipt = await origin.sendGroupMessage(id, initialEnvelope)
    assert.deepEqual(await origin.sendGroupMessage(id, initialEnvelope), initialReceipt)
    assert.equal(
      (await homeA.fetchGroupMessages(id, created.epochKeys.readTokenHex))
        .messages.length,
      1,
    )
    assert.equal(
      (await homeB.fetchGroupMessages(id, created.epochKeys.readTokenHex))
        .messages.length,
      1,
    )
    assert.deepEqual(await homeA.sendGroupMessage(id, initialEnvelope), initialReceipt)
    assert.deepEqual(await homeB.sendGroupMessage(id, initialEnvelope), initialReceipt)
    const repeatedProxyResponse = await fetch(`${homeUrl}/groups/${id}/messages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Group-Upstream-Relay': originUrl! },
      body: JSON.stringify({ group_id: id, ...initialEnvelope }),
    })
    assert.equal(repeatedProxyResponse.status, 200)
    assert.equal(repeatedProxyResponse.headers.get('x-group-append-disposition'), 'existing')
    assert.equal(JSON.stringify(await repeatedProxyResponse.json()), JSON.stringify(initialReceipt))
    // The second subscriber promotes the mirror. New upstream rows remain unread when a send is routed home.
    for (const text of ['Unread 2', 'Unread 3', 'Unread 4'])
      await origin.sendGroupMessage(id, seal(text))
    assert.equal(
      (await homeA.sendGroupMessage(id, seal('Routed 5'))).server_seq,
      5,
    )
    const backlog = await homeA.fetchGroupMessages(
      id,
      created.epochKeys.readTokenHex,
      1,
    )
    assert.deepEqual(
      backlog.messages.map(row => row.server_seq),
      [2, 3, 4, 5],
    )
    assert.deepEqual(
      backlog.messages.map(
        envelope =>
          openGroupMessage({
            envelope,
            epochKeys: created.epochKeys,
            roster: created.roster,
          }).payloadText,
      ),
      ['Unread 2', 'Unread 3', 'Unread 4', 'Routed 5'],
    )
    const rotated = await rotateGroupEpochOnRelay({
      client: origin,
      groupIdHex: id,
      groupPubKeyHex: created.identity.groupPubKeyHex,
      prevEpoch: 0,
      prevEpochHashHex: created.epochHash,
      prevEpochSecret: created.epochKeys.epochSecret,
      freshEntropy: new Uint8Array(32).fill(0x92),
      groupName: 'Foreign boundary',
      members: [{ ...alice, role: 'admin' }, bob],
      authorityPrivateKey: created.identity.groupSecretKey,
    })
    // An accepted historical retry returns the original receipt, even after membership/key rotation.
    assert.deepEqual(await homeA.sendGroupMessage(id, initialEnvelope), initialReceipt)
    // This is the app order: check latest certificate before polling the mailbox with the newly authorized secret.
    const latest = await homeA.getLatestEpoch(id)
    assert.equal(latest.epoch, 1)
    assert(verifyEpochFrame(latest, id, created.identity.groupPubKeyHex))
    await origin.sendGroupMessage(id, seal('After rotation', rotated.epochKeys))
    const after = await homeA.fetchGroupMessages(
      id,
      rotated.epochKeys.readTokenHex,
      5,
    )
    assert.deepEqual(
      after.messages.map(row => row.server_seq),
      [6],
    )
    assert.equal(
      openGroupMessage({
        envelope: after.messages[0],
        epochKeys: rotated.epochKeys,
        roster: rotated.roster,
      }).payloadText,
      'After rotation',
    )
    assert(
      verifyEpochFrame(
        await homeA.getEpoch(id, 0),
        id,
        created.identity.groupPubKeyHex,
      ),
    )
  },
  30_000,
)
