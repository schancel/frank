import { DERIVATION_REGISTRY_ID } from '../domain-roots/src'
/**
 * Joined wallet -> transport -> native relay proof driver (#777).
 *
 * Spawned one phase per process by the native harness in
 * `backend/cashweb/cashweb-registry/src/http/monad_message_cbor_tests.rs`. It contains no wire
 * encoding of its own: every request byte comes from `MonadCanonicalStampClient`, its durable
 * canonical journal, and the public canonical transport/mailbox/directory clients.
 *
 * Harness-only substitutions, all explicit:
 *  - the installed relay origins are HTTPS; `relayFetch` forwards them to the harness's loopback
 *    HTTP listener and reports the installed URL back, standing in for TLS termination only;
 *  - the directory clock is the admitted fixture's trusted time, not wall-clock freshness;
 *  - the EVM provider is the harness's owned local JSON-RPC fake, never a live network.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonRpcProvider, Transaction, computeAddress, hexlify } from 'ethers'
import {
  fromHex,
  parseFrame,
  toHex,
  type RelayBinding,
  type Timestamp,
} from '@frank/codec'
import {
  directMessageText,
  openDirectMessage,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import type { CanonicalFetch } from '@frank/cashweb/relay/canonical-dm-transport'
import {
  createDirectoryClient,
  type DirectoryFetch,
} from '@frank/cashweb/relay/directory-client'
import {
  fetchCanonicalInboxPage,
  fetchCanonicalRecoveryPage,
  type CanonicalMailboxAuthParams,
} from '@frank/cashweb/relay/monad-mailbox-client'
import { openNodeDirectoryStore } from '../directory-admission/src/node'
import type { Current } from '../directory-admission/src'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadSubAccountPool } from './monad-account-pool'
import { MonadChangePool } from './monad-change-pool'
import {
  MonadCanonicalStampClient,
  type CanonicalWorkflowLink,
} from './monad-stamp-client'
import {
  canonicalWalletPublicBinding,
  createMonadWalletMaterial,
  type MonadRootBundle,
} from './monad-wallet-material'
import { LevelChangePoolStore } from './storage/level-change-pool-store'
import { LevelSubAccountPoolStore } from './storage/level-sub-account-pool-store'
import {
  openExistingPoolMonadTopicOwner,
  type MonadWalletOperationAdmission,
} from './storage/monad-wallet-bundle'

interface InstalledPrincipal {
  network: string
  subject: string
  rev0T1: string
  relayId: string
  relayIdentity: { keyType: number; point: string }
  endpoint: string
  bindingExpiryNs: string
}
interface DriverConfig {
  /** Loopback HTTP listener of the native relay under test. */
  relayHttp: string
  /** Owned local JSON-RPC fake shared with the relay's financial transport. */
  rpcUrl: string
  /** Durable wallet/journal root, reused across phases to prove real reopen. */
  workDir: string
  /** Trusted fixture clock, in whole seconds, matching the native Directory clock file. */
  clockSeconds: string
  principals: [InstalledPrincipal, InstalledPrincipal]
  domainRoots: [Record<string, string>, Record<string, string>]
  stampValueWei: string
  poolSize: number
  text: string
}

const NETWORK = 'monad-testnet'
const NETWORK_TAG = 'MONT' as const
const CHAIN_ID = 10143n
const CONSUMER_ID = 'joined-native-relay-workflow-1'

function roots(outputs: Record<string, string>): MonadRootBundle {
  const root = <
    P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
  >(
    purpose: P,
  ) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: fromHex(outputs[purpose]),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

function relayTuple(principal: InstalledPrincipal): RelayBinding {
  const expiry = BigInt(principal.bindingExpiryNs)
  return {
    relayId: fromHex(principal.relayId),
    endpoint: principal.endpoint,
    identity: {
      keyType: principal.relayIdentity.keyType,
      keyBytes: fromHex(principal.relayIdentity.point),
    },
    expiry: {
      seconds: expiry / 1000000000n,
      nanoseconds: Number(expiry % 1000000000n),
    },
    unknownFields: new Map(),
  }
}

/** Forward exact installed-origin requests to the loopback listener; never rewrite path/body. */
function relayFetch(
  config: DriverConfig,
  trace: (line: string) => void,
): CanonicalFetch {
  const installed = config.principals.map(p => new URL(p.endpoint).origin)
  const fetchImpl = (
    globalThis as unknown as {
      fetch(
        url: string,
        init: Record<string, unknown>,
      ): Promise<Awaited<ReturnType<CanonicalFetch>>>
    }
  ).fetch
  return async (url, init) => {
    const origin = installed.find(candidate => url.startsWith(candidate + '/'))
    if (!origin) throw new Error(`joined-driver: foreign origin ${url}`)
    const target = config.relayHttp + url.slice(origin.length)
    const response = await fetchImpl(target, { ...init })
    trace(
      `${init.method} ${url.slice(origin.length).split('?')[0]} -> ${
        response.status
      }`,
    )
    return {
      status: response.status,
      url,
      headers: response.headers,
      body: response.body,
    }
  }
}

async function admittedCurrent(
  config: DriverConfig,
  principal: InstalledPrincipal,
  location: string,
  fetch: CanonicalFetch,
) {
  const now: Timestamp = {
    seconds: BigInt(config.clockSeconds),
    nanoseconds: 0,
  }
  const store = await openNodeDirectoryStore({
    location,
    anchor: {
      network: principal.network,
      subject: { keyType: 1, keyBytes: fromHex(principal.subject) },
      revisionZero: fromHex(principal.rev0T1),
    },
    mode: { kind: 'new' },
  })
  const context = () => ({ now, relay: relayTuple(principal) })
  const client = createDirectoryClient({
    network: principal.network,
    subject: principal.subject,
    endpoint: principal.endpoint,
    store,
    context,
    // Single-process phase: continuity is retained by the fresh store itself.
    saveCheckpoint: async () => undefined,
    fetch: fetch as unknown as DirectoryFetch,
  })
  // Native Directory HTTP evidence admitted by the public TS policy, not a decoded vector.
  const admitted = await client.current()
  return {
    current: admitted.current,
    fresh: () => store.current(context()),
    close: () => store.close(),
  }
}

async function openWallet(
  config: DriverConfig,
  index: 0 | 1,
  poolSize: number,
) {
  const location = join(config.workDir, index === 0 ? 'sender' : 'recipient')
  mkdirSync(location, { recursive: true })
  const material = createMonadWalletMaterial(roots(config.domainRoots[index]))
  if (
    toHex(material.identity.compressedPubKey) !==
    config.principals[index].subject
  )
    throw new Error('joined-driver: wallet P differs from installed principal')
  const subStore = new LevelSubAccountPoolStore(location),
    changeStore = new LevelChangePoolStore(location)
  await subStore.Open()
  await changeStore.Open()
  const pool = new MonadSubAccountPool({
      keyring: material.keyring,
      store: subStore,
    }),
    changePool = new MonadChangePool({
      keyring: material.changeKeyring,
      store: changeStore,
    })
  pool.ensureSize(poolSize)
  await pool.flush()
  const leaseManager = new SubAccountLeaseManager(pool)
  let enclosed = false
  let queue: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(
    operation: (admission: MonadWalletOperationAdmission) => Promise<T>,
    canonical: boolean,
  ): Promise<T> => {
    const result = queue.then(async () => {
      enclosed = true
      try {
        return await (canonical
          ? state.runCanonicalOperation(operation)
          : state.runOperation(operation))
      } finally {
        enclosed = false
      }
    })
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const branchDescriptor = (
    ring: typeof material.keyring | typeof material.changeKeyring,
  ) => {
    const descriptor = ring.publicBranchDescriptor()
    return {
      path: descriptor.path,
      publicKey: hexlify(descriptor.publicKey),
      chainCode: hexlify(descriptor.chainCode),
    }
  }
  // Same owner composition and existing economic binding as chain/monad-chain.ts.
  const state = await openExistingPoolMonadTopicOwner({
    nativeBinding: {
      chainIdentifier: NETWORK,
      nativeChainId: String(CHAIN_ID),
      publicTuple: JSON.stringify({
        version: 1,
        registry: DERIVATION_REGISTRY_ID,
        chainIdentifier: NETWORK,
        nativeChainId: String(CHAIN_ID),
        mainAddress: material.mainAccount.address.toLowerCase(),
        spend: branchDescriptor(material.keyring),
        change: branchDescriptor(material.changeKeyring),
      }),
    },
    encloseFinancialOperation: operation => exclusive(operation, false),
    location,
    pool,
    changePool,
    leaseManager,
    subKeyring: material.keyring,
    changeKeyring: material.changeKeyring,
    canonicalBinding: canonicalWalletPublicBinding(material, NETWORK, CHAIN_ID),
    stampReferencesLeaseIndex: () => false,
    assertEnclosingAdmission: () => {
      if (!enclosed) throw new Error('missing outer owner admission')
    },
  })
  const provider = new JsonRpcProvider(config.rpcUrl, CHAIN_ID, {
    staticNetwork: true,
    batchMaxCount: 1,
    cacheTimeout: -1,
  })
  const client = new MonadCanonicalStampClient({
    pool,
    changePool,
    leaseManager,
    provider,
    // The canonical consumer must never broadcast: only the relay exposes signed members.
    httpClient: {
      submitRawTransaction: async () => {
        throw new Error('joined-driver: wallet attempted a direct broadcast')
      },
      getTransactionReceipt: async () => {
        throw new Error('joined-driver: wallet attempted a receipt read')
      },
    },
    walletState: state,
    canonicalRoles: material.canonicalRoles!,
    installedNetworkTag: NETWORK_TAG,
    relayBaseUrl: config.principals[1].endpoint,
    runCanonicalExclusive: operation =>
      exclusive(lifetime => operation(lifetime), true),
  })
  return {
    material,
    pool,
    state,
    client,
    close: async () => {
      await queue
      await state.close()
      await subStore.Close()
      await changeStore.Close()
      provider.destroy()
      material.dispose()
    },
  }
}

const linkPath = (config: DriverConfig) =>
  join(config.workDir, 'workflow-link.json')
function saveLink(config: DriverConfig, link: CanonicalWorkflowLink): void {
  const prepared = link.prepared
  writeFileSync(
    linkPath(config),
    JSON.stringify({
      attemptRef: link.attemptRef,
      consumerId: link.consumerId,
      prepared: {
        ...prepared,
        payload: toHex(prepared.payload),
        context: toHex(prepared.context),
        economicBinding: toHex(prepared.economicBinding),
      },
    }),
  )
}
function loadLink(config: DriverConfig): CanonicalWorkflowLink {
  const saved = JSON.parse(readFileSync(linkPath(config), 'utf8'))
  return {
    attemptRef: saved.attemptRef,
    consumerId: saved.consumerId,
    prepared: {
      ...saved.prepared,
      payload: fromHex(saved.prepared.payload),
      context: fromHex(saved.prepared.context),
      economicBinding: fromHex(saved.prepared.economicBinding),
    },
  }
}

function poolSummary(pool: MonadSubAccountPool) {
  return pool.records().map(record => ({
    index: record.index,
    address: record.address.toLowerCase(),
    status: record.status,
  }))
}

/** Seal, bind, durably intend, lease, sign and promote. No relay PUT in this process. */
async function senderFreeze(config: DriverConfig, fetch: CanonicalFetch) {
  const wallet = await openWallet(config, 0, config.poolSize)
  const sender = await admittedCurrent(
      config,
      config.principals[0],
      join(config.workDir, `directory-freeze-sender`),
      fetch,
    ),
    recipient = await admittedCurrent(
      config,
      config.principals[1],
      join(config.workDir, `directory-freeze-recipient`),
      fetch,
    )
  try {
    const sealed = prepareDirectMessage({
      network: NETWORK,
      senderCurrent: sender.current,
      recipientCurrent: recipient.current,
      messageId: new Uint8Array(16).fill(0x77),
      items: [directMessageText(config.text)],
      roles: wallet.material.canonicalRoles!.create(NETWORK, sender.current),
    })
    const stampValueWei = BigInt(config.stampValueWei)
    const prepared = wallet.client.bindPrepared({
      payload: sealed.payload,
      context: sealed.context,
      stampValueWei,
      economicBinding: Uint8Array.of(1),
    })
    let link: CanonicalWorkflowLink | undefined
    const intent = await wallet.client.prepareIntent({
      prepared,
      consumerId: CONSUMER_ID,
      stampValueWei,
      senderCurrent: sender.current,
      recipientCurrent: recipient.current,
      onIntentDurable: async durable => {
        link = durable
        saveLink(config, durable)
      },
    })
    if (!link) throw new Error('joined-driver: intent link was not delivered')
    const ready = wallet.client.reconcileWorkflowLinks([link])
    if (ready.length !== 1 || ready[0].state !== 'ready')
      throw new Error('joined-driver: fresh intent is not ready')
    const attempt = await wallet.client.finishIntent(ready[0].eligibility!)
    const request = attempt.request
    return {
      attemptRef: attempt.attemptRef,
      intentMembers: intent.members.length,
      contentType: request.contentType,
      body: toHex(request.body),
      identity: request.identity,
      t3: toHex(sealed.t3),
      members: request.parts.transactions.map(raw => {
        const tx = Transaction.from(hexlify(raw))
        return {
          hash: tx.hash,
          from: tx.from!.toLowerCase(),
          to: tx.to!.toLowerCase(),
          value: tx.value.toString(),
          data: tx.data,
          nonce: tx.nonce,
        }
      }),
      pool: poolSummary(wallet.pool),
    }
  } finally {
    await sender.close()
    await recipient.close()
    await wallet.close()
  }
}

/** Reopen the durable owner, correlate the persisted workflow link and PUT the retained bytes. */
async function senderSubmit(config: DriverConfig, fetch: CanonicalFetch) {
  const wallet = await openWallet(config, 0, config.poolSize)
  try {
    const link = loadLink(config)
    const found = wallet.client.lookup(link.prepared)
    // A cleaned, workflow-acknowledged attempt leaves only its durable acknowledgement.
    if (!found && wallet.client.wasAcknowledged(link.attemptRef))
      return {
        reconciledState: 'acknowledged',
        restoredBody: null,
        accepted: null,
        terminal: null,
        workflowAcknowledged: true,
        pool: poolSummary(wallet.pool),
      }
    if (!found || found.kind !== 'attempt')
      throw new Error('joined-driver: reopened journal has no promoted attempt')
    const restoredBody = toHex(found.record.request.body)
    const reconciled = wallet.client.reconcileWorkflowLinks([link])
    if (reconciled.length !== 1)
      throw new Error('joined-driver: unexpected reopened records')
    let accepted: Awaited<ReturnType<typeof wallet.client.submit>> | undefined
    if (reconciled[0].state === 'ready')
      accepted = await wallet.client.submit(reconciled[0].eligibility!, {
        fetch,
      })
    let cleaned = false
    const terminal = wallet.client
      .terminalOutcomes()
      .find(a => a.attemptRef === link.attemptRef)
    if (terminal) {
      await wallet.client.cleanupTerminal(link.attemptRef, link.consumerId)
      await wallet.client.acknowledgeWorkflow(link.attemptRef, link.consumerId)
      cleaned = wallet.client.wasAcknowledged(link.attemptRef)
    }
    return {
      reconciledState: reconciled[0].state,
      restoredBody,
      accepted: accepted ?? null,
      terminal: terminal?.terminal ?? null,
      workflowAcknowledged: cleaned,
      pool: poolSummary(wallet.pool),
    }
  } finally {
    await wallet.close()
  }
}

/** P-authenticated private reads through the public mailbox client, then wallet import. */
async function recipientRead(config: DriverConfig, fetch: CanonicalFetch) {
  const wallet = await openWallet(config, 1, 1)
  const recipient = await admittedCurrent(
      config,
      config.principals[1],
      join(config.workDir, `directory-read-recipient-${process.pid}`),
      fetch,
    ),
    sender = await admittedCurrent(
      config,
      config.principals[0],
      join(config.workDir, `directory-read-sender-${process.pid}`),
      fetch,
    )
  try {
    const subject = config.principals[1].subject
    const auth: CanonicalMailboxAuthParams = {
      relayBaseUrl: config.principals[1].endpoint,
      recipient: computeAddress('0x' + subject).toLowerCase(),
      expectedNetworkTag: NETWORK_TAG,
      subject,
      getCurrent: () => recipient.fresh(),
      signDigest: digest =>
        new Uint8Array(wallet.material.identity.signHash(Buffer.from(digest))),
      fetch,
      retry: { maxAttempts: 1 },
    }
    const inbox = await fetchCanonicalInboxPage(auth)
    const opened = inbox.records.map(record => {
      const delivery = parseFrame(record.delivery)
      if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
        throw new Error('joined-driver: inbox record is not a type1 delivery')
      const message = openDirectMessage({
        mode: 'receive',
        network: NETWORK,
        payload: delivery.typed.payloadFrame.frame,
        context: record.context,
        roles: wallet.material.canonicalRoles!.create(
          NETWORK,
          recipient.current,
        ),
        senderCurrent: sender.current,
        recipientCurrent: recipient.current,
      })
      return {
        submissionIdentity: record.submissionIdentity,
        timestampMs: record.timestampMs,
        delivery: toHex(record.delivery),
        context: toHex(record.context),
        t3: toHex(message.t3),
        texts: message.items.map(item =>
          item.kind === 'parsed' && item.typed?.type === 17
            ? item.typed.text
            : null,
        ),
      }
    })
    const recovery = await fetchCanonicalRecoveryPage(auth)
    const imported = []
    for (const record of recovery.records) {
      const row = await wallet.client.importRecovery({
        record,
        senderCurrent: sender.current,
        recipientCurrent: recipient.current,
      })
      wallet.client.verifyImportedRecoveryCustody(row.obligationId)
      // A non-terminal obligation must stay unacknowledged; no relay request may be made.
      let ackRefusal: string | null = null
      if (!record.lifecycle.startsWith('terminal:'))
        ackRefusal = await wallet.client
          .ackImportedRecovery(row.obligationId, auth)
          .then(
            () => 'acknowledged',
            (error: Error) => error.message,
          )
      else await wallet.client.ackImportedRecovery(row.obligationId, auth)
      const after = wallet.client
        .importedRecoveries()
        .find(r => r.obligationId === row.obligationId)!
      imported.push({
        obligationId: row.obligationId,
        submissionIdentity: record.submissionIdentity,
        lifecycle: record.lifecycle,
        confirmedChildren: [...record.confirmedChildren],
        accounts: row.accounts,
        ackRefusal,
        recipientAcknowledged: after.recipientAcknowledged,
      })
    }
    return {
      inbox: opened,
      inboxNextCursor: inbox.nextCursor ?? null,
      recovery: imported,
      recoveryNextCursor: recovery.nextCursor ?? null,
    }
  } finally {
    await recipient.close()
    await sender.close()
    await wallet.close()
  }
}

async function main(): Promise<void> {
  const [phase, configPath] = process.argv.slice(2)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as DriverConfig
  const trace = (line: string) =>
    appendFileSync(
      join(config.workDir, 'driver-http.log'),
      `${phase} ${line}\n`,
    )
  const fetch = relayFetch(config, trace)
  const result =
    phase === 'sender-freeze'
      ? await senderFreeze(config, fetch)
      : phase === 'sender-submit'
      ? await senderSubmit(config, fetch)
      : phase === 'recipient-read'
      ? await recipientRead(config, fetch)
      : undefined
  if (result === undefined) throw new Error(`joined-driver: phase ${phase}`)
  process.stdout.write(
    JSON.stringify(result, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  )
}

main().then(
  () => process.exit(0),
  error => {
    process.stderr.write(
      `joined-driver failed: ${(error as Error)?.stack ?? String(error)}\n`,
    )
    process.exit(1)
  },
)
