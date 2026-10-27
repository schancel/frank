/** Real TS client ↔ Rust router boundary. No public services, custody or funds. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  GroupRelayClient,
  GroupWritePriceRefusedError,
  GroupWriteRefusedError,
  createGroupOnRelay,
  rotateGroupEpochOnRelay,
  prepareGroupEpochRotation,
} from './group-relay-client'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  bytesToHex,
  openGroupMessage,
  sealGroupMessage,
  verifyEpochFrame,
} from './group-crypto'
import { signGroupWritePrice } from './group-write-payment'
import {
  GROUP_TEST_ACCOUNTS,
  groupTestPaymentFor,
  groupTestSigningKey,
  paidSend,
} from './group-test.testutil'

async function main() {
  const executable = process.env.FRANK_GROUP_HTTP_FIXTURE
  assert(
    executable,
    'Set FRANK_GROUP_HTTP_FIXTURE to the compiled example path',
  )
  const server = spawn(executable, [], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
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
    const acknowledgement = await paidSend(client, id, envelope)
    assert.equal(acknowledgement.server_seq, 1)
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
    // A definitive refusal: nothing stored, so the writer may release its payment.
    await assert.rejects(
      paidSend(client, id, { ...envelope, write_sig: '00'.repeat(64) }),
      GroupWriteRefusedError,
    )
    // A new underpaid write is refused with its reason.
    const policy = await client.getWritePolicy(id)
    const underpaid = { ...policy, priceWei: policy.priceWei - 1n }
    const next = sealGroupMessage({
      epochKeys: created.epochKeys,
      senderIndex: 1,
      senderEpochKeyPair: groupTestSigningKey(bob.address, id, 0),
      senderAddress: bob.address,
      payload: new TextEncoder().encode('underpaid message'),
      timestampMs: 1700000001235,
    })
    // A retry of the accepted write gets its receipt before its payment is looked at.
    assert.equal(
      (
        await client.sendGroupMessage(
          id,
          envelope,
          groupTestPaymentFor(underpaid, id, envelope),
        )
      ).server_seq,
      1,
    )
    await assert.rejects(
      client.sendGroupMessage(
        id,
        next,
        groupTestPaymentFor(underpaid, id, next),
      ),
      (error: unknown) =>
        error instanceof GroupWriteRefusedError &&
        error.status === 402 &&
        error.reason === 'underpaid',
    )
    // The creator prices the group. Below the host's minimum is refused before anything
    // changes; the price every member then reads is the creator's.
    assert.equal(policy.priceVersion, 0)
    assert.equal(policy.priceWei, policy.minPriceWei)
    const price = (version: number, priceWei: bigint) =>
      signGroupWritePrice({
        network: policy.network,
        groupIdHex: id,
        version,
        priceWei,
        rootSecretKey: created.identity.groupSecretKey,
      })
    await assert.rejects(
      client.setWritePrice(id, price(1, policy.minPriceWei - 1n)),
      (error: unknown) =>
        error instanceof GroupWritePriceRefusedError &&
        error.reason === 'below_minimum' &&
        error.minPriceWei === policy.minPriceWei,
    )
    await client.setWritePrice(id, price(1, policy.minPriceWei * 3n))
    // Read with the group's key: the Rust relay's record checks out in TypeScript.
    const priced = await reopened.getWritePolicy(
      id,
      created.identity.groupPubKeyHex,
    )
    assert.equal(priced.priceWei, policy.minPriceWei * 3n)
    assert.equal(priced.priceVersion, 1)
    assert.equal(priced.priceRecord?.version, 1)
    // Read with another group's key, it is refused.
    await assert.rejects(
      reopened.getWritePolicy(
        id,
        bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true)),
      ),
    )
    await assert.rejects(
      client.setWritePrice(id, price(1, policy.minPriceWei * 2n)),
      (error: unknown) =>
        error instanceof GroupWritePriceRefusedError &&
        error.reason === 'conflict' &&
        error.current?.version === 1 &&
        error.current.priceWei === policy.minPriceWei * 3n,
    )
    // A write paid at the minimum is now refused; paid at the creator's price it is accepted.
    await assert.rejects(
      client.sendGroupMessage(id, next, groupTestPaymentFor(policy, id, next)),
      (error: unknown) =>
        error instanceof GroupWriteRefusedError &&
        error.status === 402 &&
        error.reason === 'underpaid',
    )
    assert.equal(
      (
        await client.sendGroupMessage(
          id,
          next,
          groupTestPaymentFor(priced, id, next),
        )
      ).server_seq,
      2,
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
    // A retried accepted envelope returns its original receipt; new old-epoch content rejects.
    assert.deepEqual(await paidSend(client, id, envelope), acknowledgement)
    await assert.rejects(
      paidSend(
        client,
        id,
        sealGroupMessage({
          epochKeys: created.epochKeys,
          senderIndex: 1,
          senderEpochKeyPair: groupTestSigningKey(bob.address, id, 0),
          senderAddress: bob.address,
          payload: new TextEncoder().encode('stale epoch message'),
          timestampMs: 1700000001235,
        }),
      ),
    )
    await assert.rejects(
      client.fetchGroupMessages(id, created.epochKeys.readTokenHex),
    )
    await assert.rejects(rotateGroupEpochOnRelay(params))
    assert.equal((await client.getLatestEpoch(id)).epoch, 1)
    assert(
      verifyEpochFrame(
        await client.getEpoch(id, 0),
        id,
        created.identity.groupPubKeyHex,
      ),
    )
    assert.equal(
      (await client.fetchGroupMessages(id, rotated.epochKeys.readTokenHex))
        .messages.length,
      2,
    )
    console.log(
      'PASS real TS ↔ Rust HTTP create/read/send/signature/reopen/repeated-sync/removal/CAS/price boundary',
    )
  } finally {
    server.kill()
  }
}
const integrationTest = process.env.FRANK_GROUP_HTTP_FIXTURE ? test : test.skip
integrationTest('real TS client and Rust HTTP group boundary', main, 20_000)
