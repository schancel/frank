/**
 * Starts a local anvil dev node (the foundry client, from the `@foundry-rs/anvil` dev
 * dependency) for a test file. Contracts under test are deployed to it and executed by it.
 */
import { spawn, type ChildProcess } from 'child_process'
import * as net from 'net'
import * as path from 'path'
import { ethers } from 'ethers'
import { compileSolidity, type ContractArtifact } from '../scripts/compile'

const ANVIL_BIN = path.resolve(__dirname, '../node_modules/.bin/anvil')
const DEV_MNEMONIC = 'test test test test test test test test test test test junk'

export interface Anvil {
  url: string
  provider: ethers.JsonRpcProvider
  /** Funded dev accounts. */
  accounts: ethers.HDNodeWallet[]
  /** Moves the chain clock forward and mines a block. */
  advanceTime(seconds: number): Promise<void>
  stop(): Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

async function waitUntilListening(url: string, child: ChildProcess) {
  const deadline = Date.now() + 30_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}`)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (res.ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('anvil did not start within 30s')
    await new Promise(r => setTimeout(r, 50))
  }
}

export async function startAnvil(): Promise<Anvil> {
  const port = await freePort()
  const child = spawn(
    ANVIL_BIN,
    ['--port', String(port), '--host', '127.0.0.1', '--silent'],
    { stdio: 'ignore' },
  )
  const url = `http://127.0.0.1:${port}`
  await waitUntilListening(url, child)

  const provider = new ethers.JsonRpcProvider(url, undefined, {
    cacheTimeout: -1,
    batchMaxCount: 1,
  })
  provider.pollingInterval = 20
  const accounts = Array.from({ length: 6 }, (_, i) =>
    ethers.HDNodeWallet.fromPhrase(
      DEV_MNEMONIC,
      undefined,
      `m/44'/60'/0'/0/${i}`,
    ).connect(provider),
  )

  return {
    url,
    provider,
    accounts,
    async advanceTime(seconds: number) {
      await provider.send('evm_increaseTime', [seconds])
      await provider.send('evm_mine', [])
    },
    async stop() {
      provider.destroy()
      if (child.exitCode !== null) return
      await new Promise<void>(resolve => {
        child.once('exit', () => resolve())
        child.kill()
      })
    },
  }
}

let testArtifacts: Record<string, ContractArtifact> | undefined
/** The contracts in `test/contracts`, compiled with the production settings. */
export function testContract(name: string): ContractArtifact {
  testArtifacts ??= compileSolidity([path.resolve(__dirname, 'contracts')])
  return testArtifacts[name]
}

export async function deploy(
  artifact: { abi: any[]; bytecode: string },
  signer: ethers.Signer,
  args: unknown[] = [],
): Promise<ethers.Contract> {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer)
  const contract = await factory.deploy(...args)
  await contract.waitForDeployment()
  return contract as ethers.Contract
}

/** Sends a transaction and waits for it to be mined successfully. */
export async function mined(
  tx: Promise<ethers.ContractTransactionResponse>,
): Promise<ethers.ContractTransactionReceipt> {
  const receipt = await (await tx).wait()
  if (!receipt || receipt.status !== 1) throw new Error('transaction failed')
  return receipt
}

/**
 * Asserts the node refuses the call with the named custom error. Every custom error of the
 * contracts takes no arguments, so the revert data is exactly the error's selector.
 */
export async function expectRevert(call: Promise<unknown>, errorName: string) {
  let error: any
  try {
    const sent: any = await call
    if (sent && typeof sent.wait === 'function') await sent.wait()
  } catch (err) {
    error = err
  }
  if (!error) throw new Error(`expected revert ${errorName}, but the call succeeded`)
  const selector = ethers.id(`${errorName}()`).slice(0, 10)
  expect({ revertData: error.data ?? error.message }).toEqual({ revertData: selector })
}
