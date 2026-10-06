import { formatEther, getAddress, getBytes, JsonRpcProvider } from 'ethers'

import { MonadHttpClient } from '@frank/wallet/monad-http'
import { sweepRecoveredMonadStampPayment } from '@frank/wallet/monad-stamp-client'
import { deriveMonadStampChildPrivate } from '@frank/wallet/monad-stamp-stealth'
import { openMonadWalletBundle } from '@frank/wallet/storage/monad-wallet-bundle'
import { LevelStampPaymentJournal } from '@frank/wallet/storage/stamp-payment-journal'

import { loadConfig, loadIdentity, resolveDataDir } from '../config'
import { formatMonAndWei, outputError, outputResult } from '../util'

export interface BalanceOptions {
  dataDir?: string
  password?: string
  json?: boolean
}

export interface SweepOptions {
  destination?: string
  dataDir?: string
  password?: string
  json?: boolean
}

export async function balanceCommand(options: BalanceOptions): Promise<void> {
  let bundle: Awaited<ReturnType<typeof openMonadWalletBundle>> | undefined
  let paymentJournal: LevelStampPaymentJournal | undefined

  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const { identity, mnemonic, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    const provider = new JsonRpcProvider(config.rpcUrl)
    const eoaBalanceWei = await provider.getBalance(identity.displayAddress)

    bundle = await openMonadWalletBundle({
      location: walletDir,
      seed: { mnemonic, passphrase: '' },
    })

    const poolRecords = bundle.pool.records()
    const poolStats = {
      total: poolRecords.length,
      available: poolRecords.filter(r => r.status === 'available').length,
      inUse: poolRecords.filter(r => r.status === 'in-use').length,
      spent: poolRecords.filter(r => r.status === 'spent').length,
      retired: poolRecords.filter(r => r.status === 'retired').length,
      funding: poolRecords.filter(r => r.status === 'funding').length,
    }
    const activeLanes =
      poolStats.available + poolStats.inUse + poolStats.funding

    paymentJournal = new LevelStampPaymentJournal(walletDir)
    await paymentJournal.Open()
    const payments = paymentJournal.getAll()
    const uncollected = payments.filter(p => p.status !== 'swept')
    const totalUncollectedWei = uncollected.reduce(
      (sum, p) => sum + BigInt(p.valueWei),
      0n,
    )

    const result = {
      address: identity.displayAddress,
      eoaBalanceWei: eoaBalanceWei.toString(),
      eoaBalanceFormatted: formatEther(eoaBalanceWei),
      pool: {
        ...poolStats,
        activeLanes,
      },
      uncollectedStampPayments: {
        count: uncollected.length,
        totalValueWei: totalUncollectedWei.toString(),
        totalValueFormatted: formatEther(totalUncollectedWei),
        payments: uncollected.map(p => ({
          payloadHash: p.payloadHashHex,
          childIndex: p.childIndex,
          address: p.address,
          valueWei: p.valueWei,
          status: p.status,
          txHash: p.txHash,
        })),
      },
    }

    outputResult(
      result,
      () => {
        console.log(`Wallet Balance for ${result.address}:`)
        console.log(
          `  EOA Balance:                    ${formatMonAndWei(eoaBalanceWei)}`,
        )
        console.log(
          `  Active Funding Pool Lanes:      ${activeLanes} (available: ${poolStats.available}, in-use: ${poolStats.inUse}, spent: ${poolStats.spent})`,
        )
        console.log(
          `  Uncollected Stamp Payments:     ${
            uncollected.length
          } payment(s), total ${formatMonAndWei(totalUncollectedWei)}`,
        )
        if (uncollected.length > 0) {
          console.log('\nUncollected Child Addresses:')
          for (const item of uncollected) {
            console.log(
              `    - [Child #${item.childIndex}] ${
                item.address
              }: ${formatMonAndWei(BigInt(item.valueWei))} (Tx: ${
                item.txHash
              })`,
            )
          }
          console.log(
            "\nRun 'signet sweep' to consolidate these payments to your main address.",
          )
        }
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  } finally {
    try {
      await paymentJournal?.Close()
    } catch {}
    try {
      await bundle?.close()
    } catch {}
  }
}

export async function sweepCommand(options: SweepOptions): Promise<void> {
  let paymentJournal: LevelStampPaymentJournal | undefined

  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const { identity, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    const destination = options.destination
      ? getAddress(options.destination)
      : identity.displayAddress

    const provider = new JsonRpcProvider(config.rpcUrl)
    const httpClient = new MonadHttpClient({ rpcUrl: config.rpcUrl })

    paymentJournal = new LevelStampPaymentJournal(walletDir)
    await paymentJournal.Open()

    const uncollected = paymentJournal
      .getAll()
      .filter(p => p.status !== 'swept')

    if (uncollected.length === 0) {
      outputResult(
        { sweptCount: 0, totalSweptWei: '0', swept: [] },
        () => console.log('No uncollected stamp payments found to sweep.'),
        options.json,
      )
      return
    }

    const sweptResults: Array<{
      childIndex: number
      address: string
      txHash: string
      valueWei: string
    }> = []
    let totalSweptWei = 0n

    for (const record of uncollected) {
      try {
        const child = deriveMonadStampChildPrivate({
          payloadHash: getBytes('0x' + record.payloadHashHex),
          recipientPrivateKey: getBytes(identity.toPrivateKeyHex()),
          paymentIndex: record.childIndex,
        })

        const outcome = await sweepRecoveredMonadStampPayment({
          payment: {
            childIndex: record.childIndex,
            address: record.address,
            privateKey: child.privateKey,
            txHash: record.txHash,
            valueWei: BigInt(record.valueWei),
          },
          destinationAddress: destination,
          provider,
          httpClient,
        })

        if (outcome.swept) {
          totalSweptWei += outcome.valueWei
          await paymentJournal.put({
            ...record,
            status: 'swept',
            sweepTxHash: outcome.txHash,
            sweepValueWei: outcome.valueWei.toString(),
            sweepDestinationAddress: destination,
          })
          sweptResults.push({
            childIndex: record.childIndex,
            address: record.address,
            txHash: outcome.txHash,
            valueWei: outcome.valueWei.toString(),
          })
        }
      } catch (err) {
        console.warn(
          `Failed to sweep child address ${record.address}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    const result = {
      destination,
      sweptCount: sweptResults.length,
      totalSweptWei: totalSweptWei.toString(),
      totalSweptFormatted: formatEther(totalSweptWei),
      sweeps: sweptResults,
    }

    outputResult(
      result,
      () => {
        console.log(`Sweep completed:`)
        console.log(`  Destination:       ${result.destination}`)
        console.log(
          `  Swept Payments:    ${result.sweptCount} of ${uncollected.length}`,
        )
        console.log(`  Total Consolidated: ${formatMonAndWei(totalSweptWei)}`)
        for (const item of result.sweeps) {
          console.log(
            `    - [Child #${item.childIndex}] ${item.address} -> Sweep Tx: ${item.txHash} (${item.valueWei} wei)`,
          )
        }
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  } finally {
    try {
      await paymentJournal?.Close()
    } catch {}
  }
}
