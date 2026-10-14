/** Real TS client ↔ Rust router boundary. No public services, custody or funds. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  GroupRelayClient,
  createGroupOnRelay,
  rotateGroupEpochOnRelay,
  prepareGroupEpochRotation,
} from './group-relay-client'
import {
  openGroupMessage,
  sealGroupMessage,
  verifyEpochFrame,
} from './group-crypto'
import { GROUP_TEST_ACCOUNTS, groupTestSigningKey } from './group-test.testutil'

async function main() {
  const executable = process.env.FRANK_GROUP_HTTP_FIXTURE
  assert(
    executable,
    'Set FRANK_GROUP_HTTP_FIXTURE to the compiled example path',
  )
  const server = spawn(executable, [], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const lines = createInterface({ input: server.stdout! })
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Fixture startup timed out')),
        10_000,
      )
      server.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`Fixture exited ${code}`))
      })
      lines.once('line', line => {
        clearTimeout(timer)
        resolve(line.trim())
      })
    })
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const client = new GroupRelayClient(url)
    const [alice, bob, charlie] = GROUP_TEST_ACCOUNTS
    const created = await createGroupOnRelay({
      client,
      groupName: 'HTTP boundary',
      creatorAddress: alice.address,
      creatorIdentityPubKeyHex: alice.publicKeyHex,
      members: [bob, charlie],
    })
    const id = created.identity.groupIdHex
    const latest = await client.getLatestEpoch(id)
    assert(verifyEpochFrame(latest, id, created.identity.groupPubKeyHex))
    const envelope = sealGroupMessage({
      epochKeys: created.epochKeys,
      senderIndex: 1,
      senderEpochKeyPair: groupTestSigningKey(bob.address, id, 0),
      senderAddress: bob.address,
      payload: new TextEncoder().encode('real HTTP message'),
      timestampMs: 1700000001234,
    })
    const acknowledgement = await client.sendGroupMessage(id, envelope)
    assert.equal(acknowledgement.server_seq, 1)
    assert.match(acknowledgement.versionstamp, /^[0-9a-f]{20}$/)
    assert(Number.isSafeInteger(acknowledgement.server_time_ms))
    await assert.rejects(client.fetchGroupMessages(id, '00'.repeat(32)))
    const reopened = new GroupRelayClient(url)
    const rows = await reopened.fetchGroupMessages(
      id,
      created.epochKeys.readTokenHex,
      0,
      50,
    )
    assert.equal(rows.messages.length, 1)
    assert.equal(
      openGroupMessage({
        envelope: rows.messages[0],
        epochKeys: created.epochKeys,
        roster: created.roster,
      }).payloadText,
      'real HTTP message',
    )
    assert.equal(
      (
        await reopened.fetchGroupMessages(
          id,
          created.epochKeys.readTokenHex,
          1,
          50,
        )
      ).messages.length,
      0,
    )
    await assert.rejects(
      client.sendGroupMessage(id, { ...envelope, write_sig: '00'.repeat(64) }),
    )
    const params = {
      client,
      groupIdHex: id,
      groupPubKeyHex: created.identity.groupPubKeyHex,
      prevEpoch: 0,
      prevEpochHashHex: created.epochHash,
      prevEpochSecret: created.epochKeys.epochSecret,
      freshEntropy: new Uint8Array(32).fill(0x91),
      groupName: 'HTTP boundary',
      members: [{ ...alice, role: 'admin' as const }, bob],
      authorityPrivateKey: created.identity.groupSecretKey,
    }
    const candidate = prepareGroupEpochRotation(params)
    await assert.rejects(
      client.publishEpoch(
        id,
        { ...candidate.epochFrame, authority_sig: '00'.repeat(64) },
        created.epochHash,
      ),
    )
    const rotated = await rotateGroupEpochOnRelay(params)
    assert.equal(rotated.epoch, 1)
    await assert.rejects(client.sendGroupMessage(id, envelope))
    await assert.rejects(
      client.fetchGroupMessages(id, created.epochKeys.readTokenHex),
    )
    await assert.rejects(rotateGroupEpochOnRelay(params))
    assert.equal((await client.getLatestEpoch(id)).epoch, 1)
    assert.equal(
      (await client.fetchGroupMessages(id, rotated.epochKeys.readTokenHex))
        .messages.length,
      1,
    )
    console.log(
      'PASS real TS ↔ Rust HTTP create/read/send/signature/reopen/repeated-sync/removal/CAS boundary',
    )
  } finally {
    server.kill()
  }
}
const integrationTest = process.env.FRANK_GROUP_HTTP_FIXTURE ? test : test.skip
integrationTest('real TS client and Rust HTTP group boundary', main, 20_000)
