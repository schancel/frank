// Real pinned Mera with a synthetic authenticator; no browser/profile credentials.
// Run: node --import tsx --test app/src/accounts/mera-passkey.node-test.ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import type { WebAuthnClient } from '@category-labs/mera'
import {
  getMeraAccountRoot,
  MERA_ACCOUNT_PRF_DOMAIN,
  MeraAccountError,
} from './mera-passkey'

beforeEach(() => {
  Object.defineProperties(globalThis, {
    crypto: { configurable: true, value: webcrypto },
    isSecureContext: { configurable: true, value: true },
    PublicKeyCredential: { configurable: true, value: class {} },
    navigator: {
      configurable: true,
      value: { credentials: { create() {}, get() {} } },
    },
    location: { configurable: true, value: { hostname: 'frank.test' } },
  })
})

function authenticator() {
  const requests: {
    creates: WebAuthnClient.CreateCredentialRequest[]
    gets: WebAuthnClient.GetCredentialRequest[]
  } = { creates: [], gets: [] }
  const output = (rpId: string, salt: Uint8Array) =>
    new Uint8Array(
      createHash('sha256')
        .update('synthetic-credential-only')
        .update(rpId)
        .update(salt)
        .digest(),
    )
  const client: WebAuthnClient = {
    async createCredential(request) {
      requests.creates.push(request)
      return {
        credentialId: Uint8Array.of(1, 2, 3),
        prfEnabled: true,
        prfOutput: output(request.rp.id, request.prfSalt),
      }
    },
    async getCredential(request) {
      requests.gets.push(request)
      return {
        credentialId: Uint8Array.of(1, 2, 3),
        prfOutput: output(request.rpId, request.prfSalt),
      }
    },
  }
  return { client, requests }
}

test('real Mera creates once and discovers the same root on repeated fresh-local-state login', async () => {
  const { client, requests } = authenticator()
  const created = await getMeraAccountRoot('create', client)
  for (let device = 0; device < 2; device++) {
    // The client retains no credential metadata, root, or local state between requests.
    assert.deepEqual(await getMeraAccountRoot('login', client), created)
  }
  assert.equal(requests.creates.length, 1)
  assert.equal(requests.gets.length, 2)
  const creation = requests.creates[0]!
  assert.equal(creation.rp.id, 'frank.test')
  assert.equal(creation.residentKey, 'required')
  assert.equal(creation.userVerification, 'required')
  const expectedSalt = createHash('sha256')
    .update(MERA_ACCOUNT_PRF_DOMAIN)
    .digest()
  assert.deepEqual(Buffer.from(creation.prfSalt), expectedSalt)
  for (const request of requests.gets) {
    assert.equal(request.rpId, creation.rp.id)
    assert.equal(request.userVerification, 'required')
    assert.equal(request.allowCredential, undefined)
    assert.deepEqual(Buffer.from(request.prfSalt), expectedSalt)
    assert.notDeepEqual(request.challenge, creation.challenge)
  }
  created.fill(0)
})

test('real Mera creation fallback assertion uses the same salt and selected credential', async () => {
  const { client, requests } = authenticator()
  const fallbackClient: WebAuthnClient = {
    ...client,
    createCredential: async request => {
      requests.creates.push(request)
      return { credentialId: Uint8Array.of(1, 2, 3), prfEnabled: true }
    },
  }
  const root = await getMeraAccountRoot('create', fallbackClient)
  assert.equal(root.length, 32)
  assert.deepEqual(
    requests.gets[0]!.allowCredential?.credentialId,
    Uint8Array.of(1, 2, 3),
  )
  assert.deepEqual(requests.gets[0]!.prfSalt, requests.creates[0]!.prfSalt)
  root.fill(0)
})

test('unsupported environment never asks for a credential', async () => {
  const { client, requests } = authenticator()
  Object.defineProperty(globalThis, 'isSecureContext', { value: false })
  await assert.rejects(getMeraAccountRoot('login', client), {
    code: 'unsupported',
  })
  assert.equal(requests.gets.length + requests.creates.length, 0)
})

test('real Mera missing or invalid PRF fails without substituting random bytes', async () => {
  for (const prfOutput of [undefined, new Uint8Array(31)]) {
    const { client } = authenticator()
    const failing: WebAuthnClient = {
      ...client,
      getCredential: async () => ({
        credentialId: Uint8Array.of(1),
        prfOutput,
      }),
    }
    await assert.rejects(getMeraAccountRoot('login', failing), { code: 'prf' })
  }
})

test('real Mera cancellation becomes a bounded public error', async () => {
  const { client } = authenticator()
  const cancelled: WebAuthnClient = {
    ...client,
    getCredential: async () => {
      throw new DOMException('synthetic private cause', 'NotAllowedError')
    },
  }
  await assert.rejects(getMeraAccountRoot('login', cancelled), error => {
    assert.ok(error instanceof MeraAccountError)
    assert.equal(error.code, 'cancelled')
    assert.equal('cause' in error, false)
    return true
  })
})
