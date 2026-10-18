/**
 * Wallet hot-path benchmark & real-world latency simulation.
 *
 * Run from repo root:
 *   yarn workspace @frank/wallet bench
 */
import { performance } from 'node:perf_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBytes, Transaction, Wallet } from 'ethers'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import { MonadHdKeyring } from '../secp256k1-hd-keyring'
import { MonadChangeKeyring } from '../secp256k1-hd-keyring'
import {
  deriveEvmStealthAddress,
  deriveEvmStealthPrivateKey,
} from '../evm-stealth'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import { SimulatedLedger } from '../privacy-simulation-engine'
import { MonadAccountTxSigner } from '../evm-account-tx'

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return sorted[idx]
}

async function measureAsync(
  label: string,
  iterations: number,
  fn: (i: number) => Promise<void>,
): Promise<void> {
  const warmup = Math.min(5, iterations)
  for (let i = 0; i < warmup; i++) {
    await fn(i)
  }
  const samples: number[] = []
  const startTotal = performance.now()
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    await fn(i)
    samples.push(performance.now() - t0)
  }
  const totalMs = performance.now() - startTotal
  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = percentile(sorted, 50)
  const p95 = percentile(sorted, 95)
  const p99 = percentile(sorted, 99)
  const opsSec = totalMs > 0 ? Math.round((iterations * 1000) / totalMs) : 0
  console.log(
    [
      label.padEnd(44),
      `${String(opsSec).padStart(8)} ops/s`,
      `p50: ${p50.toFixed(2).padStart(6)} ms`,
      `p95: ${p95.toFixed(2).padStart(6)} ms`,
      `p99: ${p99.toFixed(2).padStart(6)} ms`,
      `(${iterations} iters)`,
    ].join('  '),
  )
}

async function main() {
  console.log(
    `runtime: Node ${process.version} ${process.arch} ${process.platform}`,
  )
  console.log('--- @frank/wallet Hot-Path Benchmark ---')

  const evmRootBytes = getBytes(
    `0x${domainVectors.vectors[0].outputs['evm-wallet']}`,
  )
  const evmRoot = {
    registry: 'frank-domain-roots-v1' as const,
    purpose: 'evm-wallet' as const,
    bytes: evmRootBytes,
  }

  // 1. HD sub-account & change keyring derivation
  await measureAsync('BIP-44 HD sub-account derivation (10 accts)', 200, async () => {
    const keyring = MonadHdKeyring.fromDomainRoot(evmRoot)
    for (let idx = 0; idx < 10; idx++) {
      if (!keyring.deriveSubAccount(idx).address) throw new Error('keyring derive')
    }
  })

  await measureAsync('Unhardened change derivation (10 accts)', 200, async () => {
    const change = MonadChangeKeyring.fromDomainRoot(evmRoot)
    for (let idx = 0; idx < 10; idx++) {
      if (!change.deriveChangeAccount(idx).address) throw new Error('change derive')
    }
  })

  // 2. DKSAP stealth address derivation + recipient recovery
  const recipientKey = new Wallet('0x' + '22'.repeat(32))
  const recipientCompressedPub = getBytes(recipientKey.signingKey.compressedPublicKey)
  const recipientPrivBytes = getBytes(recipientKey.privateKey)
  await measureAsync('DKSAP stealth derive + recipient key recovery', 250, async () => {
    const stealth = deriveEvmStealthAddress({
      recipientSpendPubKey: recipientCompressedPub,
    })
    const recovered = deriveEvmStealthPrivateKey({
      recipientSpendSecret: recipientPrivBytes,
      ephemeralPubKey: stealth.ephemeralPubKey,
    })
    if (recovered.stealthAddress.toLowerCase() !== stealth.stealthAddress.toLowerCase()) {
      throw new Error('stealth mismatch')
    }
  })

  // 3. Wallet-side EIP-1559 transfer build + sign (and simulated node submit)
  const ledger = new SimulatedLedger()
  const senderPrivKey = '0x' + '33'.repeat(32)
  const senderWallet = new Wallet(senderPrivKey)
  ledger.setBalance(senderWallet.address, 10n ** 22n)
  const txSigner = new MonadAccountTxSigner({
    privateKey: senderPrivKey,
    provider: ledger.asProvider(),
    httpClient: ledger,
  })
  const recipientAddr = '0x' + '44'.repeat(20)
  await measureAsync('EIP-1559 wallet build + sign (no node verify)', 250, async i => {
    const signed = await txSigner.buildAndSignTransfer(recipientAddr, 1000n, {
      nonce: i,
      gasLimit: 21000n,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
      chainId: 10143n,
    })
    if (!signed.txHash) throw new Error('missing txHash')
  })
  await measureAsync('EIP-1559 build + sign + simulated submit', 200, async () => {
    const signed = await txSigner.buildAndSignTransfer(recipientAddr, 1000n)
    await ledger.submitRawTransaction(signed.rawTx)
  })

  // 4. EvmNativeOperationJournal reservation lookup scaling
  const root = await mkdtemp(join(tmpdir(), 'frank-wallet-bench-'))
  const journal = new EvmNativeOperationJournal({
    location: root,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'bench-wallet-descriptor',
    },
  })
  await journal.Open()
  try {
    const addresses: string[] = []
    for (let i = 0; i < 100; i++) {
      const spendAddr = new Wallet(
        '0x' + (i + 1).toString(16).padStart(64, '0'),
      ).address.toLowerCase()
      addresses.push(spendAddr)
      const row = await journal.prepare({
        kind: 'native',
        recipient: spendAddr,
        intendedValueWei: '1000',
        members: [
          {
            source: { kind: 'spend', address: spendAddr, index: i },
            unsignedTransaction: Transaction.from({
              type: 2,
              chainId: 10143n,
              nonce: 0,
              to: spendAddr,
              value: 1000n,
              gasLimit: 21000n,
              maxFeePerGas: 1n,
              maxPriorityFeePerGas: 1n,
            }).unsignedSerialized,
            dependencies: [],
          },
        ],
      })
      if (i < 80) {
        await journal.cancelUnsigned(row.operationId)
      }
    }

    await measureAsync(
      'Journal reservation query (100 ops in store)',
      1000,
      async () => {
        if (!journal.referencesSpendIndex(85)) throw new Error('expected reserved')
        if (journal.canSelect(addresses[85], 0)) throw new Error('expected blocked')
      },
    )
  } finally {
    await journal.Close()
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
