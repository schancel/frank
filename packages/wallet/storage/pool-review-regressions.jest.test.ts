import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadChangeKeyring } from '../monad-change-keyring'
import { MonadSubAccountPool } from '../monad-account-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { MonadAccountTxSigner } from '../monad-account-tx'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import { openMonadWalletBundle } from './monad-wallet-bundle'

const mnemonic = 'test test test test test test test test test test test junk'
const otherMnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each(['spacing', 'signed'] as const)(
  'rejects a delayed second contributor after another lease wins during %s, without exposing its signed transfer',
  async (phase) => {
    const location = mkdtempSync(
      join(tmpdir(), 'frank-review-funding-capture-')
    )
    const store = new LevelSubAccountPoolStore(location)
    await store.Open()
    const pool = new MonadSubAccountPool({
      keyring: MonadHdKeyring.fromMnemonic(mnemonic),
      store,
    })
    const entered = barrier(),
      release = barrier()
    try {
      const balances = new Map<string, bigint>()
      const provider = new JsonRpcProvider('http://127.0.0.1:1', 10143, {
        staticNetwork: true,
        cacheTimeout: -1,
      })
      ;(provider as any)._perform = async (request: any) => {
        if (request.method === 'getBalance')
          return balances.get(request.address.toLowerCase()) ?? 0n
        if (request.method === 'getTransactionCount') return 0
        throw new Error(`Offline regression refused ${request.method}`)
      }
      const client = {
        submitRawTransaction: jest.fn(async (rawTx: string) => {
          const tx = Transaction.from(rawTx)
          balances.set(
            tx.to!.toLowerCase(),
            (balances.get(tx.to!.toLowerCase()) ?? 0n) + tx.value
          )
          return tx.hash!
        }),
        getTransactionReceipt: jest.fn(async (txHash: string) => ({
          txHash,
          status: 'success' as const,
          blockNumber: 1,
          blockHash: '0x' + '11'.repeat(32),
          gasUsed: 21000n,
          effectiveGasPrice: 1n,
          logs: [],
        })),
      }
      const signers = [1, 2].map((n) => {
        const wallet = new Wallet('0x' + n.toString(16).padStart(64, '0'))
        balances.set(wallet.address.toLowerCase(), 1000000n)
        return new MonadAccountTxSigner({
          privateKey: wallet.privateKey,
          provider,
          httpClient: client,
        })
      })
      const firstSigning = jest.spyOn(signers[0], 'buildAndSignTransfer')
      const build = signers[1].buildAndSignTransfer.bind(signers[1])
      let delayedRaw!: string
      const secondSigning = jest
        .spyOn(signers[1], 'buildAndSignTransfer')
        .mockImplementation(async (...args) => {
          const signed = await build(...args)
          delayedRaw = signed.rawTx
          expect(Transaction.from(delayedRaw).signature).not.toBeNull()
          if (phase === 'signed') {
            entered.resolve()
            await release.promise
          }
          return signed
        })
      pool.attachFunderSpacing(async (address) => {
        if (phase === 'spacing' && address === signers[1].address) {
          entered.resolve()
          await release.promise
        }
      })
      // Deliberately omit optional claimFor, matching the public writer defect.
      const preparing = pool.prepareBurnAccount({
        mainAccountSigner: signers[0],
        funders: signers.map((signer) => ({ signer, amountWei: 50n })),
        provider,
        burnValueWei: 100n,
        gasReserveWei: 0n,
        fundingOverrides: {
          chainId: 10143n,
          nonce: 0,
          gasLimit: 21000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
        },
        receipt: { maxAttempts: 0 },
      })
      await entered.promise
      expect(pool.getRecord(0)).toMatchObject({
        status: 'available',
        revision: 3,
      })
      const leases = new SubAccountLeaseManager(pool)
      const originalLease = await leases.acquireForIndex(0)
      const held = pool.getRecord(0)!
      expect(held).toMatchObject({ status: 'in-use', revision: 4 })
      release.resolve()
      await expect(preparing).rejects.toThrow('Stale pool revision')
      expect(pool.getRecord(0)).toEqual(held)
      expect(leases.isCurrentLease(originalLease)).toBe(true)
      await expect(
        new SubAccountLeaseManager(pool).acquireForIndex(0)
      ).rejects.toThrow('not available')
      expect(firstSigning).toHaveBeenCalledTimes(1)
      expect(secondSigning).toHaveBeenCalledTimes(1)
      expect(client.submitRawTransaction).toHaveBeenCalledTimes(1)
      expect(
        client.submitRawTransaction.mock.calls.map(([raw]) => raw)
      ).not.toContain(delayedRaw)
      await store.Close()
      await store.Open()
      expect(store.getByIndex(0)).toEqual(held)
    } finally {
      release.resolve()
      await store.Close()
      rmSync(location, { recursive: true, force: true })
    }
  }
)

const components = [
  'wallet-manifest',
  'sub-account-pool',
  'change-pool',
] as const
async function snapshot(location: string) {
  const result: Record<string, { keys: string[]; digest: string }> = {}
  for (const component of components) {
    const db = level(join(location, component))
    try {
      const entries = (await Array.fromAsync((db as any).iterator())) as [
        string,
        string
      ][]
      result[component] = {
        keys: entries.map(([key]) => key),
        digest: createHash('sha256')
          .update(JSON.stringify(entries))
          .digest('hex'),
      }
    } finally {
      await db.close()
    }
  }
  return result
}

it.each(['same-seed', 'different-seed', 'generated-seed'] as const)(
  'refuses preexisting recovered change before %s custody or manifest initialization, preserving every component',
  async (scenario) => {
    const location = mkdtempSync(
      join(tmpdir(), 'frank-review-change-initialization-')
    )
    const recovered = {
      index: 0,
      address:
        MonadChangeKeyring.fromMnemonic(mnemonic).deriveChangeAccount(0)
          .address,
      nonce: 1,
      balanceWei: '12345',
    }
    const db = level(join(location, 'change-pool'))
    await db.put('__recovered_change__:0', JSON.stringify(recovered))
    await db.close()
    const before = await snapshot(location)
    const generation = jest.spyOn(MonadHdKeyring, 'generate')
    try {
      const error = await openMonadWalletBundle(
        scenario === 'generated-seed'
          ? { location, mode: 'create', createSeedIfEmpty: true }
          : {
              location,
              mode: 'restore',
              seed: {
                mnemonic: scenario === 'same-seed' ? mnemonic : otherMnemonic,
              },
            }
      ).then(
        async (bundle) => {
          await bundle.close()
          return undefined
        },
        (failure) => failure
      )
      // Digests avoid printing newly generated disposable custody in the fail-before evidence.
      expect(await snapshot(location)).toEqual(before)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toMatch(/change.*manifest/)
      expect(generation).not.toHaveBeenCalled()
    } finally {
      generation.mockRestore()
      rmSync(location, { recursive: true, force: true })
    }
  }
)
