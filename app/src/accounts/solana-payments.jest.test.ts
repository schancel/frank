// Load the pinned SDK's real embedded WASM in Jest/CommonJS. Only the unused async
// URL loader needs import.meta removal; initSync and every cryptographic export stay real.
jest.mock('ecash-lib/dist/ffi/ecash_lib_wasm_browser.js', () => {
  const fs = jest.requireActual('node:fs')
  const ts = jest.requireActual('typescript')
  const source = fs
    .readFileSync(
      require.resolve('ecash-lib/dist/ffi/ecash_lib_wasm_browser.js'),
      'utf8',
    )
    .replace('import.meta.url', "'file:///unused-jest-wasm-loader'")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  new Function('exports', compiled)(exports)
  return exports
})
jest.mock('ecash-lib/dist/ffi/ecash_lib_wasm_bg_browser.js', () => {
  const fs = jest.requireActual('node:fs')
  const source = fs.readFileSync(
    require.resolve('ecash-lib/dist/ffi/ecash_lib_wasm_bg_browser.js'),
    'utf8',
  )
  return { ECASH_LIB_WASM_BASE64: source.match(/`([\s\S]*?)`/)[1] }
})
// Jest executes the actual packaged runtime and generated WASM; only its ESM
// loader syntax is translated. The public unsigned builders remain real.
jest.mock('@frank/wallet/solana-crypto-backend/runtime.mjs', () => {
  const fs = jest.requireActual('node:fs')
  const path = jest.requireActual('node:path')
  const ts = jest.requireActual('typescript')
  const directory = path.resolve(
    __dirname,
    '../../../packages/wallet/solana-crypto-backend',
  )
  const compile = (source: string) =>
    ts.transpileModule(
      source.replace(/import\.meta\.url/g, "'file:///unused-jest-loader'"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText
  const glue = {} as { initSync(input: { module: Uint8Array }): unknown }
  new Function(
    'exports',
    compile(
      fs.readFileSync(path.join(directory, 'generated/backend.js'), 'utf8'),
    ),
  )(glue)
  glue.initSync({
    module: fs.readFileSync(path.join(directory, 'generated/backend_bg.wasm')),
  })
  const runtime = {}
  new Function(
    'exports',
    'require',
    compile(fs.readFileSync(path.join(directory, 'runtime.mjs'), 'utf8')),
  )(runtime, (specifier: string) => {
    if (specifier !== './generated/backend.js')
      throw new Error('Unexpected runtime dependency')
    return glue
  })
  return runtime
})
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { BIP39_RECOVERY_FORMAT } from '@frank/account-vault'
import { DOMAIN_PURPOSES, DERIVATION_REGISTRY_ID } from '@frank/domain-roots'
import type { openExperimentalRecipientCustody } from '@frank/wallet/solana-crypto-backend/runtime.mjs'
jest.mock(
  '../../../packages/wallet/solana-crypto-backend/generated/backend_bg.wasm?url',
  () => 'file:///packaged/backend_bg.wasm',
  { virtual: true },
)
import { IDBFactory } from 'fake-indexeddb'
import {
  PublicKey,
  VersionedTransaction,
  VersionedMessage,
} from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { getBase58Decoder } from '@solana/codecs-strings'
import { getChainRegistryEntry } from '@frank/wallet/chain'
import { IndexedDbSolanaPaymentPersistence } from '@frank/wallet/storage/solana-payment-state'
import { SolanaPaymentState } from '@frank/wallet/solana-contact-payments/state'
import { associatedAccount } from '@frank/wallet/solana-contact-payments/transaction-policy'
import type { SolanaPaymentAsset } from '@frank/wallet/solana-contact-payments/types'
import { receivedSolanaSigningReference } from '@frank/wallet/solana-contact-payments/receipt'
import type { SolanaReceiptClaim } from '@frank/wallet/solana-contact-payments/receipt'
import { createSolanaPaymentContexts } from './solana-payments'
import { createAccountSession, type RuntimeWallet } from './session'
import type { AccountCustody, PublicAccount, CustodySnapshot } from './custody'

type Opener = typeof openExperimentalRecipientCustody
// Execute the checked-in generator output and WASM, changing only the unused ESM URL
// syntax for Jest. No cryptographic implementation or runtime method is replaced.
function packagedOpener(): Opener {
  const directory = resolve(
    __dirname,
    '../../../packages/wallet/solana-crypto-backend',
  )
  const compile = (source: string) =>
    ts.transpileModule(
      source.replace(/import\.meta\.url/g, "'file:///unused-jest-loader'"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText
  const glue = {} as { initSync(input: { module: Uint8Array }): unknown }
  new Function(
    'exports',
    compile(readFileSync(resolve(directory, 'generated/backend.js'), 'utf8')),
  )(glue)
  glue.initSync({
    module: readFileSync(resolve(directory, 'generated/backend_bg.wasm')),
  })
  const runtime = {} as { openExperimentalRecipientCustody: Opener }
  new Function(
    'exports',
    'require',
    compile(readFileSync(resolve(directory, 'runtime.mjs'), 'utf8')),
  )(runtime, (specifier: string) => {
    if (specifier !== './generated/backend.js')
      throw new Error('Unexpected runtime dependency')
    return glue
  })
  return runtime.openExperimentalRecipientCustody
}
const realOpen = packagedOpener()
const input = {
  chainIdentifier: 'solana-devnet',
  wasm: 'file:///packaged/backend_bg.wasm',
}
function sessionFixture(open: Opener = realOpen, historical = false) {
  let account = {
    displayName: 'Public fixture',
    descriptor: 'public',
    receipt: {
      operationId: 'fixture',
      context: {
        accountId: 'actual-account-id',
        ...(historical ? { recoveryFormat: BIP39_RECOVERY_FORMAT } : {}),
      },
    },
  } as PublicAccount
  let snapshot: CustodySnapshot = {
    schema: 1,
    revision: 1,
    active: account,
    pending: null,
  }
  const borrowed: Uint8Array[] = []
  const capability = {
    get account() {
      return account
    },
    close: jest.fn(),
    takeRoots: () =>
      DOMAIN_PURPOSES.map((purpose, index) => {
        const bytes = new Uint8Array(32).fill(index + 1)
        borrowed.push(bytes)
        return { registry: DERIVATION_REGISTRY_ID, purpose, bytes }
      }),
    takeBip39Seed: () => {
      const seed = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
      borrowed.push(seed)
      return seed
    },
  }
  const custody = {
    snapshot: async () => snapshot,
    reconcile: async () => 'ready',
    openActive: async () => capability,
    close: jest.fn(),
  } as unknown as AccountCustody
  const wallets: RuntimeWallet[] = []
  const createWallet = jest.fn(async () => {
    const wallet = {
      chainIdentifier: 'monad-testnet',
      identity: { compressedPubKey: new Uint8Array(33).fill(2) },
      close: jest.fn(async () => undefined),
    } as unknown as RuntimeWallet
    wallets.push(wallet)
    return wallet
  })
  let invalidate!: () => void
  const opener = jest.fn(open)
  const session = createAccountSession({
    open: async () => custody,
    createWallet,
    openSolanaPaymentCustody: opener,
    listen: callback => {
      invalidate = callback
      return () => undefined
    },
  })
  return {
    session,
    opener,
    borrowed,
    createWallet,
    wallets,
    invalidate: () => invalidate(),
    switchAccount: (accountId: string) => {
      account = {
        ...account,
        receipt: {
          ...account.receipt,
          context: { ...account.receipt.context, accountId },
        },
      }
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        active: account,
      }
      invalidate()
    },
  }
}

const native: SolanaPaymentAsset = { kind: 'native' }
const token: Extract<SolanaPaymentAsset, { kind: 'spl' }> = {
  kind: 'spl',
  mint: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
  program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  decimals: 6,
}
const system = (lamports: number) => ({
  owner: '11111111111111111111111111111111',
  executable: false,
  lamports,
  data: ['', 'base64'],
  rentEpoch: 0,
})
function mintAccount() {
  const bytes = Buffer.alloc(82)
  bytes[44] = token.decimals
  bytes[45] = 1
  return {
    owner: token.program,
    executable: false,
    lamports: 100,
    data: [bytes.toString('base64'), 'base64'],
  }
}
function tokenAccount(owner: string, amount: bigint) {
  const bytes = Buffer.alloc(165)
  bytes.set(new PublicKey(token.mint).toBytes())
  bytes.set(new PublicKey(owner).toBytes(), 32)
  bytes.writeBigUInt64LE(amount, 64)
  bytes[108] = 1
  return {
    owner: token.program,
    executable: false,
    lamports: 100,
    data: [bytes.toString('base64'), 'base64'],
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(historical = false) {
  const f = sessionFixture(realOpen, historical)
  const factory = new IDBFactory()
  const accounts = new Map<string, unknown>()
  const originalTransactions = new Map<string, unknown>()
  const statuses = new Map<string, unknown>()
  const submitted: string[] = []
  const namespaces: string[] = []
  let relay = 'https://relay.invalid/'
  let slot = 10
  let genesisOverride: string | undefined
  let hook:
    | ((method: string, params: unknown[], result: unknown) => Promise<unknown>)
    | undefined
  const fetcher = jest.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number
        method: string
        params: unknown[]
      }
      const chainIdentifier = String(url).split('/chain-rpc/')[1].split('/')[0]
      const genesis = getChainRegistryEntry(
        chainIdentifier,
      )?.identityProbes.find(probe => probe.kind === 'genesis-hash')
      let result: unknown
      switch (request.method) {
        case 'getGenesisHash':
          result =
            genesisOverride ??
            (genesis && 'expected' in genesis ? genesis.expected : undefined)
          break
        case 'getLatestBlockhash':
          result = {
            context: { slot },
            value: {
              blockhash: new PublicKey(new Uint8Array(32).fill(5)).toBase58(),
              lastValidBlockHeight: 100,
            },
          }
          break
        case 'getFeeForMessage':
          result = { context: { slot }, value: 5 }
          break
        case 'getMinimumBalanceForRentExemption':
          result = 100
          break
        case 'getMultipleAccounts':
          result = {
            context: { slot },
            value: (request.params[0] as string[]).map(
              address => accounts.get(address) ?? null,
            ),
          }
          break
        case 'getTokenAccountsByOwner':
          result = {
            context: { slot },
            value: [...accounts]
              .filter(
                ([, value]) =>
                  (value as { owner: string }).owner === token.program &&
                  (value as { data: string[] }).data[0].length > 200,
              )
              .map(([pubkey, account]) => ({ pubkey, account }))
              .filter(({ account }) =>
                Buffer.from((account as { data: string[] }).data[0], 'base64')
                  .subarray(32, 64)
                  .equals(
                    Buffer.from(
                      new PublicKey(request.params[0] as string).toBytes(),
                    ),
                  ),
              ),
          }
          break
        case 'getSignatureStatuses':
          result = {
            context: { slot },
            value: (request.params[0] as string[]).map(
              signature => statuses.get(signature) ?? null,
            ),
          }
          break
        case 'getTransaction':
          result = originalTransactions.get(request.params[0] as string) ?? null
          break
        case 'sendTransaction': {
          const original = request.params[0] as string
          submitted.push(original)
          result = getBase58Decoder().decode(
            VersionedTransaction.deserialize(Buffer.from(original, 'base64'))
              .signatures[0],
          )
          break
        }
        default:
          throw new Error('Unexpected RPC ' + request.method)
      }
      if (hook) result = await hook(request.method, request.params, result)
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      } as Response
    },
  ) as jest.MockedFunction<typeof fetch>
  const persistence = (namespace: string) => {
    namespaces.push(namespace)
    return new IndexedDbSolanaPaymentPersistence(namespace, factory)
  }
  const contexts = createSolanaPaymentContexts({
    session: f.session,
    relayBaseUrl: () => relay,
    wasmUrl: input.wasm,
    fetcher,
    persistence,
  })
  return {
    ...f,
    contexts,
    factory,
    accounts,
    statuses,
    originalTransactions,
    submitted,
    namespaces,
    fetcher,
    setRelay: (value: string) => {
      relay = value
    },
    setSlot: (value: number) => {
      slot = value
    },
    setGenesis: (value: string | undefined) => {
      genesisOverride = value
    },
    setHook: (value: typeof hook) => {
      hook = value
    },
    authority: () =>
      new SolanaPaymentState(
        namespaces[namespaces.length - 1],
        input.chainIdentifier,
        persistence(namespaces[namespaces.length - 1]),
      ),
  }
}

test.each([false, true])(
  'explicit open uses actual private WASM factory, preserves primary, validates genesis and read-only reopen (historical=%s)',
  async historical => {
    const f = fixture(historical)
    expect(f.contexts.peek()).toEqual([])
    expect(f.opener).not.toHaveBeenCalled()
    expect(await f.factory.databases()).toEqual([])
    await f.session.initialize()
    const primary = f.session.peekWallet()
    const [a, b] = await Promise.all([
      f.contexts.open(input.chainIdentifier),
      f.contexts.open(input.chainIdentifier),
    ])
    expect(a).toBe(b)
    expect(f.opener).toHaveBeenCalledTimes(1)
    expect(f.session.peekWallet()).toBe(primary)
    expect(a.primaryAddress).toBe(
      new PublicKey(await f.session.getCurvePublicKey('ed25519')).toBase58(),
    )
    expect((await a.inspect()).positions).toEqual({})
    expect(await f.factory.databases()).toEqual([])
    f.accounts.set(a.primaryAddress, system(900))
    await a.refresh(native)
    expect((await a.inspect()).positions[a.primaryAddress].balance).toBe('900')
    const namespace = f.namespaces[0]
    expect(JSON.parse(namespace)).toEqual([
      'frank-solana-payments',
      'actual-account-id',
      Buffer.from(await f.session.getCurvePublicKey('ed25519')).toString('hex'),
      input.chainIdentifier,
    ])
    await a.close()
    expect(f.contexts.peek()).toEqual([])
    await expect(a.inspect()).rejects.toThrow()
    const reopened = await f.contexts.open(input.chainIdentifier)
    expect(f.namespaces[f.namespaces.length - 1]).toBe(namespace)
    expect(
      (await reopened.inspect()).positions[reopened.primaryAddress].balance,
    ).toBe('900')
    await f.contexts.close()
    await f.session.close()
  },
)

test('canonical chain affinity, wrong genesis and unavailable RPC reject before custody or database defaults', async () => {
  const f = fixture()
  expect(() => f.contexts.open(input.chainIdentifier)).toThrow('No account')
  await f.session.initialize()
  for (const chain of ['devnet', 'solana', 'monad-testnet', 'unknown'])
    expect(() => f.contexts.open(chain)).toThrow('unavailable')
  f.setGenesis('wrong')
  await expect(f.contexts.open(input.chainIdentifier)).rejects.toThrow(
    'identity mismatch',
  )
  expect(f.opener).not.toHaveBeenCalled()
  expect(await f.factory.databases()).toEqual([])
  f.setGenesis(undefined)
  f.setHook(async () => {
    throw new Error('offline')
  })
  await expect(f.contexts.open(input.chainIdentifier)).rejects.toThrow(
    'offline',
  )
  f.setHook(undefined)
  const a = await f.contexts.open(input.chainIdentifier)
  const b = await f.contexts.open('solana-mainnet')
  expect(a).not.toBe(b)
  expect(a.primaryAddress).toBe(b.primaryAddress)
  expect(new Set(f.namespaces).size).toBe(2)
  expect((await a.inspect()).chainIdentifier).toBe(input.chainIdentifier)
  expect((await b.inspect()).chainIdentifier).toBe('solana-mainnet')
  await f.contexts.close()
  await f.session.close()
})

test('actual canonical token reads retain exact balances, discovery and verified ATA absence without inventing positions', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  const ata = associatedAccount(owner.primaryAddress, token.mint)
  f.accounts.set(owner.primaryAddress, system(0))
  f.accounts.set(token.mint, mintAccount())
  expect((await owner.refresh(token))[0].assetBalance).toBeNull()
  expect((await owner.inspect()).positions[ata]).toBeUndefined()
  f.accounts.set(ata, tokenAccount(owner.primaryAddress, 18446744073709551615n))
  await owner.refresh(token)
  expect((await owner.inspect()).positions[ata].balance).toBe(
    '18446744073709551615',
  )
  expect((await owner.discoverAssets())[0].assets).toEqual([token])
  f.accounts.delete(ata)
  f.setSlot(11)
  expect((await owner.refresh(token))[0].assetBalance).toBeNull()
  expect((await owner.inspect()).positions[ata].balance).toBe('0')
  f.setHook(async (method, _params, result) => {
    if (method === 'getMultipleAccounts') throw new Error('unavailable')
    return result
  })
  await expect(owner.refresh(native)).rejects.toThrow('unavailable')
  expect((await owner.inspect()).positions[ata].observedSlot).toBe(11)
  await f.contexts.close()
  await f.session.close()
})

test('canonical observations cannot overwrite reservations or newer observed facts', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(1000))
  await owner.refresh(native)
  const state = f.authority()
  const id = '00000000-0000-4000-8000-000000000001'
  await owner.payments.quoteReview({
    operationId: id,
    chainIdentifier: input.chainIdentifier,
    recipientSpendPoint: new PublicKey(
      ed25519.getPublicKey(new Uint8Array(32).fill(8)),
    ).toBase58(),
    asset: native,
    amount: '20',
    allowDestinationAtaCreation: false,
  })
  await state.reserve(id, () => [[owner.primaryAddress]])
  await expect(owner.refresh(native)).rejects.toThrow('reserved')
  expect(
    (await owner.inspect()).positions[owner.primaryAddress].reservedBy,
  ).toBe(id)
  await f.contexts.close()
  await f.session.close()
})

test('older delayed finalized refresh cannot clobber newer balance facts', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(100))
  const pending = deferred<unknown>()
  const entered = deferred<void>()
  let blocked = false
  f.setHook(async (method, _params, result) => {
    if (method === 'getMultipleAccounts' && !blocked) {
      blocked = true
      entered.resolve()
      return pending.promise
    }
    return result
  })
  const older = owner.refresh(native)
  const rejected = expect(older).rejects.toThrow('Stale')
  await entered.promise
  f.setSlot(11)
  f.accounts.set(owner.primaryAddress, system(200))
  await owner.refresh(native)
  pending.resolve({ context: { slot: 10 }, value: [system(100)] })
  await rejected
  expect((await owner.inspect()).positions[owner.primaryAddress].balance).toBe(
    '200',
  )
  await f.contexts.close()
  await f.session.close()
})

test('same-revision primary replacement synchronously revokes references and blocks late RPC writes', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(100))
  await owner.refresh(native)
  const gate = deferred<unknown>()
  const entered = deferred<void>()
  f.setHook(async (method, _params, result) => {
    if (method === 'getMultipleAccounts') {
      entered.resolve()
      return gate.promise
    }
    return result
  })
  const late = owner.refresh(native)
  const rejected = expect(late).rejects.toThrow('context changed')
  await entered.promise
  f.invalidate()
  expect(f.contexts.peek()).toEqual([])
  await expect(owner.inspect()).rejects.toThrow()
  await f.session.initialize()
  gate.resolve({ context: { slot: 11 }, value: [system(999)] })
  await rejected
  f.setHook(undefined)
  const next = await f.contexts.open(input.chainIdentifier)
  expect((await next.inspect()).positions[next.primaryAddress].balance).toBe(
    '100',
  )
  await f.contexts.close()
  await f.session.close()
})

test.each(['direct', 'public'] as const)(
  'per-chain retirement survives cache deletion for %s close while another chain progresses',
  async mode => {
    const f = fixture()
    await f.session.initialize()
    const owner = await f.contexts.open(input.chainIdentifier)
    const gate = deferred<unknown>()
    const entered = deferred<void>()
    let block = true
    f.setHook(async (method, _params, result) => {
      if (method === 'getMultipleAccounts' && block) {
        block = false
        entered.resolve()
        return gate.promise
      }
      return result
    })
    const late = owner.refresh(native)
    const rejected = expect(late).rejects.toThrow()
    await entered.promise
    const closing = mode === 'direct' ? owner.close() : f.contexts.close()
    let opened = false
    const replacement = f.contexts.open(input.chainIdentifier).then(value => {
      opened = true
      return value
    })
    const other = await f.contexts.open('solana-mainnet')
    expect(other.chainIdentifier).toBe('solana-mainnet')
    expect(opened).toBe(false)
    gate.resolve({ context: { slot: 10 }, value: [null] })
    await rejected
    await closing
    const next = await replacement
    expect(next).not.toBe(owner)
    await f.contexts.close()
    await f.session.close()
  },
)

test('relay replacement never redirects a captured context and peek remains a read-only view', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  const before = f.fetcher.mock.calls.length
  f.setRelay('https://new-relay.invalid/')
  expect(f.contexts.peek()).toEqual([])
  expect(f.fetcher.mock.calls.length).toBe(before)
  await expect(owner.inspect()).rejects.toThrow('context changed')
  const next = await f.contexts.open(input.chainIdentifier)
  expect(next).not.toBe(owner)
  expect(
    String(f.fetcher.mock.calls[f.fetcher.mock.calls.length - 1][0]),
  ).toContain('https://new-relay.invalid/chain-rpc/solana-devnet/rpc')
  await f.contexts.close()
  await f.session.close()
})

async function incoming(
  recipient: string,
  asset: SolanaPaymentAsset,
): Promise<SolanaReceiptClaim> {
  const seed = new Uint8Array(32).fill(9)
  const sender = await realOpen({
    accountId: new Uint8Array(32).fill(9),
    chainIdentifier: input.chainIdentifier,
    seed,
    wasm: input.wasm,
  })
  try {
    const cryptoAsset =
      asset.kind === 'native'
        ? { kind: 'native' as const }
        : {
            kind: 'spl' as const,
            mint: [...new PublicKey(asset.mint).toBytes()],
            tokenProgram: [...new PublicKey(asset.program).toBytes()],
          }
    const context = {
      cryptoOperationId32: '03'.repeat(32),
      derivationContext32: '04'.repeat(32),
      memberIndex: 0,
    }
    const destination = sender.deriveDestination({
      chainIdentifier: input.chainIdentifier,
      asset: cryptoAsset,
      recipient: [...new PublicKey(recipient).toBytes()],
      operationId: new Array(32).fill(3),
      memberIndex: 0,
      messageContext: new Array(32).fill(4),
      recipientAmount: '20',
    })
    const signed = sender.signPrimaryTransfer(
      destination.descriptor,
      {
        chainIdentifier: input.chainIdentifier,
        asset: cryptoAsset,
        owner: [...sender.primaryPublicKey()],
        destination: destination.publicKey,
        amount: '20',
        recentBlockhash: new Array(32).fill(5),
        operationId: new Array(32).fill(3),
        messageContext: new Array(32).fill(4),
        decimals: asset.kind === 'native' ? null : asset.decimals,
      },
      {
        feeLamports: '5',
        maxFeeLamports: '5',
        rentLamports: '0',
        maxRentLamports: '0',
        maxNativeDebitLamports: asset.kind === 'native' ? '25' : '5',
        createDestinationAta: false,
      },
    )
    const transaction = new VersionedTransaction(
      VersionedMessage.deserialize(signed.message),
    )
    transaction.addSignature(new PublicKey(signed.publicKey), signed.signature)
    return {
      chainIdentifier: input.chainIdentifier,
      asset,
      amount: '20',
      destination: {
        recipientPoint: recipient,
        ephemeralPoint: new PublicKey(
          Uint8Array.from(destination.descriptor.ephemeral),
        ).toBase58(),
        destinationOwner: new PublicKey(
          Uint8Array.from(destination.publicKey),
        ).toBase58(),
      },
      context,
      signature: getBase58Decoder().decode(signed.signature),
      signedTransaction: transaction.serialize(),
    }
  } finally {
    sender.close()
  }
}

test.each([native, token])(
  'actual WASM receipt original is durable, retried byteidentically, finalized once and restored with owned gas observations ($kind)',
  async asset => {
    const f = fixture()
    await f.session.initialize()
    const owner = await f.contexts.open(input.chainIdentifier)
    const claim = await incoming(owner.primaryAddress, asset)
    const before = f.fetcher.mock.calls.length
    const offered = structuredClone(claim)
    const proof = { payloadDigest: 'aa'.repeat(32) }
    const recording = owner.receipts.recordIncomingClaim(offered, proof)
    offered.amount = '21'
    offered.signedTransaction.fill(0)
    proof.payloadDigest = 'bb'.repeat(32)
    await recording
    expect(
      (await owner.inspect()).incoming[claim.signature].payloadDigest,
    ).toBe('aa'.repeat(32))
    expect(f.fetcher.mock.calls.length).toBe(before)
    expect((await owner.inspect()).positions).toEqual({})
    expect(
      (await owner.receipts.incomingProgress([claim.signature])).status,
    ).toBe('pending')
    await owner.receipts.rebroadcastIncoming(claim.signature)
    expect(f.submitted).toEqual([
      Buffer.from(claim.signedTransaction).toString('base64'),
    ])
    const pending = await owner.receipts.reconcileIncoming(claim.signature)
    expect(pending.status).toBe('pending')
    const transaction = VersionedTransaction.deserialize(
      claim.signedTransaction,
    )
    const keys = transaction.message.staticAccountKeys.map(key =>
      key.toBase58(),
    )
    const destinationAddress =
      asset.kind === 'native'
        ? claim.destination.destinationOwner
        : associatedAccount(claim.destination.destinationOwner, asset.mint)
    const index = keys.indexOf(destinationAddress)
    const preBalances = keys.map(() => 0),
      postBalances = keys.map(() => 0)
    preBalances[0] = 100
    postBalances[0] = asset.kind === 'native' ? 75 : 95
    if (asset.kind === 'native') postBalances[index] = 20
    const tokenRow =
      asset.kind === 'spl'
        ? {
            accountIndex: index,
            mint: asset.mint,
            owner: claim.destination.destinationOwner,
            programId: asset.program,
            uiTokenAmount: { amount: '20', decimals: asset.decimals },
          }
        : undefined
    f.originalTransactions.set(claim.signature, {
      slot: 20,
      version: 0,
      transaction: [
        Buffer.from(claim.signedTransaction).toString('base64'),
        'base64',
      ],
      meta: {
        err: null,
        preBalances,
        postBalances,
        preTokenBalances: tokenRow
          ? [
              {
                ...tokenRow,
                uiTokenAmount: { ...tokenRow.uiTokenAmount, amount: '0' },
              },
            ]
          : [],
        postTokenBalances: tokenRow ? [tokenRow] : [],
        loadedAddresses: { readonly: [], writable: [] },
      },
    })
    f.statuses.set(claim.signature, {
      slot: 20,
      confirmations: null,
      confirmationStatus: 'finalized',
      err: null,
    })
    expect(
      (await owner.receipts.reconcileIncoming(claim.signature)).status,
    ).toBe('confirmed')
    expect((await owner.inspect()).positions[destinationAddress].balance).toBe(
      '20',
    )
    await expect(
      owner.receipts.recordIncomingClaim(
        { ...claim, chainIdentifier: 'solana-mainnet' },
        { payloadDigest: 'aa'.repeat(32) },
      ),
    ).rejects.toThrow('Foreign receipt')
    await owner.close()
    const reopened = await f.contexts.open(input.chainIdentifier)
    await reopened.receipts.recordIncomingClaim(claim, {
      payloadDigest: 'aa'.repeat(32),
    })
    expect(
      (await reopened.receipts.incomingProgress([claim.signature]))
        .verifiedReceivedAmount,
    ).toBe('20')
    f.setSlot(21)
    f.accounts.set(owner.primaryAddress, system(0))
    f.accounts.set(
      claim.destination.destinationOwner,
      system(asset.kind === 'native' ? 20 : 0),
    )
    if (asset.kind === 'spl') {
      f.accounts.set(asset.mint, mintAccount())
      f.accounts.set(
        destinationAddress,
        tokenAccount(claim.destination.destinationOwner, 20n),
      )
    }
    const refreshed = await reopened.refresh(asset)
    expect(refreshed).toHaveLength(2)
    expect(
      (await reopened.inspect()).positions[destinationAddress].signingReference
        .kind,
    ).toBe('received')
    if (asset.kind === 'spl')
      expect(
        (await reopened.inspect()).positions[claim.destination.destinationOwner]
          .balance,
      ).toBe('0')
    expect(f.submitted).toHaveLength(1)
    await f.contexts.close()
    await f.session.close()
  },
)

test('required restoration failure is observable and never resets the existing authority', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(40))
  await owner.refresh(native)
  const original = await owner.inspect()
  await owner.close()
  const persistence = new IndexedDbSolanaPaymentPersistence(
    f.namespaces[0],
    f.factory,
  )
  await persistence.update(() => ({
    value: { ...original, walletId: 'foreign-wallet' },
    result: undefined,
  }))
  await expect(f.contexts.open(input.chainIdentifier)).rejects.toThrow(
    'foreign Solana payment state',
  )
  expect(f.contexts.peek()).toEqual([])
  expect(((await persistence.read()) as { walletId: string }).walletId).toBe(
    'foreign-wallet',
  )
  await f.contexts.close()
  await f.session.close()
})

test('account replacement during initial genesis RPC cannot publish or initialize durable state', async () => {
  const f = fixture()
  await f.session.initialize()
  const gate = deferred<unknown>(),
    entered = deferred<void>()
  let blocked = false
  f.setHook(async (method, _params, result) => {
    if (method === 'getGenesisHash' && !blocked) {
      blocked = true
      entered.resolve()
      return gate.promise
    }
    return result
  })
  const opening = f.contexts.open(input.chainIdentifier)
  const rejected = expect(opening).rejects.toThrow('context changed')
  await entered.promise
  f.invalidate()
  await f.session.initialize()
  gate.resolve('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
  await rejected
  expect(f.contexts.peek()).toEqual([])
  expect(f.opener).not.toHaveBeenCalled()
  expect(await f.factory.databases()).toEqual([])
  f.setHook(undefined)
  await f.contexts.open(input.chainIdentifier)
  await f.contexts.close()
  await f.session.close()
})

test('account replacement uses an independent durable namespace and never replaces primary custody from cache operations', async () => {
  const f = fixture()
  await f.session.initialize()
  const old = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(old.primaryAddress, system(70))
  await old.refresh(native)
  const oldNamespace = f.namespaces[0],
    before = f.fetcher.mock.calls.length
  f.switchAccount('second-account')
  expect(f.contexts.peek()).toEqual([])
  expect(f.fetcher.mock.calls.length).toBe(before)
  await expect(old.inspect()).rejects.toThrow()
  await f.session.initialize()
  const primary = f.session.peekWallet()
  const next = await f.contexts.open(input.chainIdentifier)
  expect(f.session.peekWallet()).toBe(primary)
  expect(f.namespaces[f.namespaces.length - 1]).not.toBe(oldNamespace)
  expect((await next.inspect()).positions).toEqual({})
  expect(
    (
      (await new IndexedDbSolanaPaymentPersistence(
        oldNamespace,
        f.factory,
      ).read()) as { positions: Record<string, { balance: string }> }
    ).positions[old.primaryAddress].balance,
  ).toBe('70')
  await f.contexts.close()
  await f.session.close()
})

function request(n = 1, asset: SolanaPaymentAsset = native) {
  return {
    operationId: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
    chainIdentifier: input.chainIdentifier,
    recipientSpendPoint: new PublicKey(
      ed25519.getPublicKey(new Uint8Array(32).fill(17)),
    ).toBase58(),
    asset,
    amount: '20',
    allowDestinationAtaCreation: asset.kind === 'spl',
  }
}
function finalizeOutgoing(
  f: ReturnType<typeof fixture>,
  original: import('@frank/wallet/solana-contact-payments/types').SolanaSignedPayment,
  asset: SolanaPaymentAsset,
  outcome: 'confirmed' | 'failed' = 'confirmed',
) {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(original.transaction, 'base64'),
  )
  const keys = tx.message.staticAccountKeys.map(key => key.toBase58())
  const preBalances = keys.map(() => 0),
    postBalances = keys.map(() => 0)
  const sourceIndex = keys.indexOf(original.sourceOwner)
  preBalances[sourceIndex] = 1000
  postBalances[sourceIndex] =
    1000 -
    5 -
    (outcome === 'confirmed'
      ? asset.kind === 'native'
        ? 20
        : Number(original.rentLamports)
      : 0)
  const destinationAddress =
    asset.kind === 'native'
      ? original.destination.destinationOwner
      : associatedAccount(original.destination.destinationOwner, asset.mint)
  const destinationIndex = keys.indexOf(destinationAddress)
  if (asset.kind === 'native' && outcome === 'confirmed')
    postBalances[destinationIndex] = 20
  const tokenRow = (accountIndex: number, owner: string, amount: string) =>
    asset.kind === 'spl'
      ? {
          accountIndex,
          mint: asset.mint,
          owner,
          programId: asset.program,
          uiTokenAmount: { amount, decimals: asset.decimals },
        }
      : undefined
  const sourceTokenIndex =
    asset.kind === 'spl'
      ? keys.indexOf(associatedAccount(original.sourceOwner, asset.mint))
      : -1
  const sourceBefore = tokenRow(sourceTokenIndex, original.sourceOwner, '100')
  const sourceAfter = tokenRow(
    sourceTokenIndex,
    original.sourceOwner,
    outcome === 'confirmed' ? '80' : '100',
  )
  const destinationBefore = tokenRow(
    destinationIndex,
    original.destination.destinationOwner,
    '0',
  )
  const destinationAfter = tokenRow(
    destinationIndex,
    original.destination.destinationOwner,
    outcome === 'confirmed' ? '20' : '0',
  )
  const err =
    outcome === 'confirmed' ? null : { InstructionError: [1, 'Custom'] }
  f.statuses.set(original.signature, {
    slot: 20,
    confirmations: null,
    confirmationStatus: 'finalized',
    err,
  })
  f.originalTransactions.set(original.signature, {
    slot: 20,
    version: 0,
    transaction: [original.transaction, 'base64'],
    meta: {
      err,
      preBalances,
      postBalances,
      preTokenBalances: sourceBefore
        ? [
            sourceBefore,
            ...(original.rentLamports === '0' ? [destinationBefore] : []),
          ]
        : [],
      postTokenBalances: sourceAfter ? [sourceAfter, destinationAfter] : [],
      loadedAddresses: { readonly: [], writable: [] },
    },
  })
}

test.each([native, token])(
  'actual outgoing $kind quote→sign-only→durableexposure→byteidentical retry→reopen→finalized reconciliation',
  async asset => {
    const f = fixture()
    await f.session.initialize()
    let owner = await f.contexts.open(input.chainIdentifier)
    f.accounts.set(owner.primaryAddress, system(1000))
    if (asset.kind === 'spl') {
      f.accounts.set(asset.mint, mintAccount())
      f.accounts.set(
        associatedAccount(owner.primaryAddress, asset.mint),
        tokenAccount(owner.primaryAddress, 100n),
      )
    }
    const intent = request(11, asset),
      offered = structuredClone(intent)
    const reviewPromise = owner.payments.quoteReview(offered)
    offered.amount = '90'
    const review = await reviewPromise
    expect(review.intent.amount).toBe('20')
    expect(review.phase).toBe('quoted')
    expect(review.signed).toEqual([])
    expect(review.members[0].maxFeeLamports).toBe('5')
    expect(review.members[0].maxRentLamports).toBe(
      asset.kind === 'spl' ? '100' : '0',
    )
    expect(
      (await owner.inspect()).positions[owner.primaryAddress].reservedBy,
    ).toBeUndefined()
    expect(f.submitted).toEqual([])
    const prepared = await owner.payments.prepare(intent.operationId)
    expect(prepared.phase).toBe('signed')
    expect(prepared.signed).toHaveLength(1)
    expect(f.submitted).toEqual([])
    expect(await owner.payments.release(intent.operationId)).toBe(false)
    await expect(owner.payments.submit(intent.operationId)).rejects.toThrow(
      'Durable envelope',
    )
    await owner.payments.expose({
      operationId: intent.operationId,
      payloadDigest: 'bb'.repeat(32),
    })
    await expect(
      owner.payments.expose({
        operationId: intent.operationId,
        payloadDigest: 'cc'.repeat(32),
      }),
    ).rejects.toThrow('another envelope')
    expect((await owner.payments.submit(intent.operationId)).status).toBe(
      'pending',
    )
    expect(
      (await owner.payments.reconcile(intent.operationId))
        .verifiedReceivedAmountAtomic,
    ).toBe(0n)
    await owner.close()
    owner = await f.contexts.open(input.chainIdentifier)
    expect((await owner.payments.get(intent.operationId))?.signed).toEqual(
      prepared.signed,
    )
    expect(await owner.payments.list()).toEqual([
      { operationId: intent.operationId, payloadDigest: 'bb'.repeat(32) },
    ])
    await owner.payments.submit(intent.operationId)
    expect(f.submitted).toEqual([
      prepared.signed[0].transaction,
      prepared.signed[0].transaction,
    ])
    finalizeOutgoing(f, prepared.signed[0], asset)
    expect(await owner.payments.reconcile(intent.operationId)).toMatchObject({
      status: 'succeeded',
      intendedAmountAtomic: 20n,
      verifiedReceivedAmountAtomic: 20n,
    })
    const state = await owner.inspect()
    expect(
      state.positions[prepared.signed[0].sourceAddresses[0]].reservedBy,
    ).toBeUndefined()
    expect(state.positions[prepared.signed[0].sourceAddresses[0]].balance).toBe(
      asset.kind === 'native' ? '975' : '80',
    )
    expect(await owner.payments.release(intent.operationId)).toBe(false)
    await owner.payments.reconcile(intent.operationId)
    expect((await owner.payments.get(intent.operationId))?.signed).toEqual(
      prepared.signed,
    )
    await f.contexts.close()
    await f.session.close()
  },
)

test('fee rise fails before reservation/signature; complete approved review never silently replans or expands fees', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(1000))
  const intent = request(12)
  const review = await owner.payments.quoteReview(intent)
  f.setHook(async (method, _params, result) =>
    method === 'getFeeForMessage'
      ? { context: { slot: 11 }, value: 6 }
      : result,
  )
  expect(await owner.payments.quoteReview(intent)).toEqual(review)
  await expect(owner.payments.prepare(intent.operationId)).rejects.toThrow(
    'exceeds authorization',
  )
  const current = await owner.payments.get(intent.operationId)
  expect(current?.phase).toBe('quoted')
  expect(current?.signed).toEqual([])
  expect(
    (await owner.inspect()).positions[owner.primaryAddress].reservedBy,
  ).toBeUndefined()
  expect(await owner.payments.release(intent.operationId)).toBe(true)
  expect(await owner.payments.get(intent.operationId)).toEqual(review)
  f.setHook(undefined)
  expect(
    (await owner.payments.prepare(intent.operationId)).signed,
  ).toHaveLength(1)
  await f.contexts.close()
  await f.session.close()
})

test('incomplete quoting draft is retained and indexed but never returned as a complete operation; resume uses same contexts/destination', async () => {
  const f = fixture()
  await f.session.initialize()
  let owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(1000))
  const intent = request(13)
  let quoted = 0
  f.setHook(async (method, _params, result) =>
    method === 'getFeeForMessage' && ++quoted === 2
      ? { context: { slot: 10 }, value: 6 }
      : result,
  )
  await expect(owner.payments.quoteReview(intent)).rejects.toThrow(
    'differs from planning',
  )
  const draft = (await owner.inspect()).operations[intent.operationId]
  expect(draft.phase).toBe('quoting')
  expect(await owner.payments.get(intent.operationId)).toBeUndefined()
  expect(await owner.payments.list()).toEqual([
    { operationId: intent.operationId },
  ])
  expect(await owner.payments.release(intent.operationId)).toBe(true)
  await owner.close()
  owner = await f.contexts.open(input.chainIdentifier)
  f.setHook(undefined)
  const complete = await owner.payments.quoteReview(intent)
  expect(complete.contexts).toEqual(draft.contexts)
  expect(complete.members[0].destination).toEqual(draft.members[0].destination)
  await expect(
    owner.payments.quoteReview({ ...intent, amount: '21' }),
  ).rejects.toThrow('another intent')
  await f.contexts.close()
  await f.session.close()
})

test('two operations cannot reserve the same reviewed source; unsigned release retains immutable allocation', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(1000))
  const a = request(14),
    b = request(15)
  await owner.payments.quoteReview(a)
  await owner.payments.quoteReview(b)
  const results = await Promise.allSettled([
    owner.payments.prepare(a.operationId),
    owner.payments.prepare(b.operationId),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
    1,
  )
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  const snapshot = await owner.inspect()
  const signed = Object.values(snapshot.operations).find(
    operation => operation.signed.length,
  )
  expect(snapshot.positions[owner.primaryAddress].reservedBy).toBe(
    signed?.intent.operationId,
  )
  expect(
    await owner.payments.release(signed?.intent.operationId ?? 'missing'),
  ).toBe(false)
  expect(f.submitted).toEqual([])
  await f.contexts.close()
  await f.session.close()
})

test('actual authority release wins interrupted prepare before persist and no signed original escapes; contexts remain resumable', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(1000))
  const intent = request(16)
  const review = await owner.payments.quoteReview(intent)
  const authority = f.authority(),
    reserve = SolanaPaymentState.prototype.reserve,
    gate = deferred<void>(),
    entered = deferred<void>()
  const spy = jest
    .spyOn(SolanaPaymentState.prototype, 'reserve')
    .mockImplementation(async function (id, select) {
      const operation = await reserve.call(this, id, select)
      if (id === intent.operationId) {
        entered.resolve()
        await gate.promise
      }
      return operation
    })
  try {
    const preparing = owner.payments.prepare(intent.operationId),
      rejected = expect(preparing).rejects.toThrow()
    await entered.promise
    expect(
      (await authority.inspect()).positions[owner.primaryAddress].reservedBy,
    ).toBe(intent.operationId)
    expect(await owner.payments.release(intent.operationId)).toBe(true)
    gate.resolve()
    await rejected
    const current = await owner.payments.get(intent.operationId)
    expect(current?.phase).toBe('quoted')
    expect(current?.signed).toEqual([])
    expect(current?.contexts).toEqual(review.contexts)
    expect(
      (await owner.inspect()).positions[owner.primaryAddress].reservedBy,
    ).toBeUndefined()
    expect(f.submitted).toEqual([])
  } finally {
    gate.resolve()
    spy.mockRestore()
    await f.contexts.close()
    await f.session.close()
  }
})

test('first classic mint resolves canonical metadata without recipient ATA, defaults, inventory or signing', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(token.mint, mintAccount())
  const result = await owner.resolveClassicAsset({
    mint: token.mint,
    program: token.program,
  })
  expect(result).toEqual({ asset: token, finalizedSlot: 10 })
  expect((await owner.inspect()).positions).toEqual({})
  expect(await f.factory.databases()).toEqual([])
  await expect(
    owner.resolveClassicAsset({
      mint: token.mint,
      program: '11111111111111111111111111111111',
    }),
  ).rejects.toThrow()
  f.accounts.delete(token.mint)
  await expect(
    owner.resolveClassicAsset({ mint: token.mint, program: token.program }),
  ).rejects.toThrow()
  f.setHook(async () => {
    throw new Error('offline')
  })
  await expect(
    owner.resolveClassicAsset({ mint: token.mint, program: token.program }),
  ).rejects.toThrow('offline')
  expect(f.submitted).toEqual([])
  await f.contexts.close()
  await f.session.close()
})

test('session invalidation during outgoing fee verification cannot sign or reserve a different account after reopen', async () => {
  const f = fixture()
  await f.session.initialize()
  let owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(1000))
  const intent = request(17)
  const review = await owner.payments.quoteReview(intent)
  const gate = deferred<unknown>(),
    entered = deferred<void>()
  f.setHook(async (method, _params, result) => {
    if (method === 'getFeeForMessage') {
      entered.resolve()
      return gate.promise
    }
    return result
  })
  const preparing = owner.payments.prepare(intent.operationId),
    rejected = expect(preparing).rejects.toThrow('context changed')
  await entered.promise
  f.invalidate()
  await f.session.initialize()
  expect(f.contexts.peek()).toEqual([])
  gate.resolve({ context: { slot: 10 }, value: 5 })
  await rejected
  f.setHook(undefined)
  owner = await f.contexts.open(input.chainIdentifier)
  expect(await owner.payments.get(intent.operationId)).toEqual(review)
  expect(
    (await owner.inspect()).positions[owner.primaryAddress].reservedBy,
  ).toBeUndefined()
  expect(f.submitted).toEqual([])
  await f.contexts.close()
  await f.session.close()
})

test('an exposed pending operation does not block an unrelated owned received source', async () => {
  const f = fixture()
  await f.session.initialize()
  const owner = await f.contexts.open(input.chainIdentifier)
  f.accounts.set(owner.primaryAddress, system(1000))
  const first = request(18)
  await owner.payments.quoteReview(first)
  const signedFirst = await owner.payments.prepare(first.operationId)
  await owner.payments.expose({
    operationId: first.operationId,
    payloadDigest: 'dd'.repeat(32),
  })
  await owner.payments.submit(first.operationId)
  expect((await owner.payments.reconcile(first.operationId)).status).toBe(
    'pending',
  )
  // Setup an independently chain-observed owned source through the existing state
  // operation; receipt import/finality itself is covered by the real receipt tests.
  const claim = await incoming(owner.primaryAddress, native),
    source = claim.destination.destinationOwner
  await f.authority().observe({
    address: source,
    owner: source,
    asset: native,
    balance: '1000',
    observedSlot: 10,
    signingReference: receivedSolanaSigningReference(claim),
  })
  f.accounts.set(source, system(1000))
  const second = request(19)
  const reviewed = await owner.payments.quoteReview(second)
  expect(reviewed.members[0].review.sourceAddresses).toEqual([source])
  const signedSecond = await owner.payments.prepare(second.operationId)
  expect(signedSecond.signed[0].sourceOwner).toBe(source)
  const state = await owner.inspect()
  expect(state.positions[owner.primaryAddress].reservedBy).toBe(
    first.operationId,
  )
  expect(state.positions[source].reservedBy).toBe(second.operationId)
  expect((await owner.payments.get(first.operationId))?.signed).toEqual(
    signedFirst.signed,
  )
  expect(f.submitted).toEqual([signedFirst.signed[0].transaction])
  await f.contexts.close()
  await f.session.close()
})
