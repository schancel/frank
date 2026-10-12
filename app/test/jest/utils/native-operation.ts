import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet } from 'ethers'
import { EvmNativeOperationJournal } from '@frank/wallet/storage/evm-native-operation-journal'

/** JSDOM lacks browser Web Locks; keep the production journal's coordination path. */
let fixtureLockHost: { users: number; restore(): void } | undefined
function acquireFixtureLockHost(): () => void {
  if (typeof window === 'undefined') return () => undefined
  if (!fixtureLockHost) {
    if (navigator.locks !== undefined) return () => undefined
    const before = Object.getOwnPropertyDescriptor(navigator, 'locks')
    const queues = new Map<string, Promise<void>>()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
          const previous = queues.get(name) ?? Promise.resolve()
          const run = previous.then(callback)
          const tail = run.then(
            () => undefined,
            () => undefined,
          )
          queues.set(name, tail)
          try {
            return await run
          } finally {
            if (queues.get(name) === tail) queues.delete(name)
          }
        },
      },
    })
    fixtureLockHost = {
      users: 0,
      restore() {
        if (before) Object.defineProperty(navigator, 'locks', before)
        else Reflect.deleteProperty(navigator, 'locks')
      },
    }
  }
  const host = fixtureLockHost
  host.users++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--host.users === 0) {
      host.restore()
      fixtureLockHost = undefined
    }
  }
}

/**
 * Real disposable owner, with deterministic test-only signing material.
 *
 * `observed: false` leaves the last member signed and handed out but never observed: the
 * journal has no answer from the chain for it (`unknown`). That state cannot be reached by
 * recording `unknown` over an included member, because the journal does not let the absence of
 * an answer replace what the chain was already seen to say.
 */
export async function includedNativeTransfer(
  fanIn = false,
  { observed = true }: { observed?: boolean } = {},
) {
  const location = await mkdtemp(join(tmpdir(), 'frank-native-ui-'))
  const signer = new Wallet('0x' + '41'.repeat(32))
  const staging = new Wallet('0x' + '42'.repeat(32))
  const signers = fanIn ? [signer, staging] : [signer]
  const recipient = '0x000000000000000000000000000000000000dead'
  const binding = {
    chainIdentifier: 'monad-testnet',
    nativeChainId: '10143',
    publicTuple: 'native UI fixture',
  }
  let journal = new EvmNativeOperationJournal({ location, binding })
  const releaseLockHost = acquireFixtureLockHost()
  async function close() {
    try {
      await journal.Close()
    } finally {
      try {
        await rm(location, { recursive: true, force: true })
      } finally {
        releaseLockHost()
      }
    }
  }
  try {
    await journal.Open()
    let row = await journal.prepare({
      kind: 'legacy',
      recipient,
      intendedValueWei: '10000000000000000',
      members: signers.map((wallet, index) => ({
        source: { kind: 'main', address: wallet.address.toLowerCase() },
        unsignedTransaction: Transaction.from({
          type: 2,
          chainId: 10143n,
          nonce: 0,
          to: fanIn && index === 0 ? staging.address : recipient,
          value: 10000000000000000n,
          gasLimit: 21000n,
          maxFeePerGas: 102000000000n,
          maxPriorityFeePerGas: 102000000000n,
        }).unsignedSerialized,
        dependencies: index ? [0] : [],
      })),
    })
    let hash = ''
    for (let index = 0; index < signers.length; index++) {
      row = await journal.checkpointSigned(
        row.operationId,
        index,
        await signers[index]!.signTransaction(
          Transaction.from(row.members[index]!.unsignedTransaction),
        ),
      )
      hash = row.members[index]!.signed!.transactionHash
      await journal.markExposed(row.operationId, index)
      if (!observed && index === signers.length - 1) break
      await journal.recordObservation(
        journal.beginCapture(row.operationId, index),
        {
          state: 'included-success',
          transactionHash: hash,
          blockHash: '0x' + '12'.repeat(32),
          blockNumber: 69526794,
          transactionIndex: index,
          feeWei: '2142000000000000',
        },
        null,
      )
    }
    return {
      hash,
      operationId: row.operationId,
      get journal() {
        return journal
      },
      async reopen() {
        await journal.Close()
        journal = new EvmNativeOperationJournal({ location, binding })
        await journal.Open()
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
