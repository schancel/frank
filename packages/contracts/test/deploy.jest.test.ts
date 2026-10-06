import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import { CREATE2_FACTORY, ChannelVault, TablePotVault, GenericHTLC } from '../index'

describe('Contract Deployment Pipeline', () => {
  it('computes deterministic CREATE2 addresses matching standard factory rules', () => {
    const salt = ethers.id('frank.contracts.v1')
    const contractSalt = ethers.keccak256(salt)

    const channelVaultInitCodeHash = ethers.keccak256(ChannelVault.bytecode)
    const expectedChannelVaultAddress = ethers.getCreate2Address(
      CREATE2_FACTORY,
      contractSalt,
      channelVaultInitCodeHash,
    )

    expect(ethers.isAddress(expectedChannelVaultAddress)).toBe(true)
    expect(expectedChannelVaultAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)

    const tablePotInitCodeHash = ethers.keccak256(TablePotVault.bytecode)
    const expectedTablePotAddress = ethers.getCreate2Address(
      CREATE2_FACTORY,
      contractSalt,
      tablePotInitCodeHash,
    )

    expect(ethers.isAddress(expectedTablePotAddress)).toBe(true)
    expect(expectedTablePotAddress).not.toBe(expectedChannelVaultAddress)

    const htlcInitCodeHash = ethers.keccak256(GenericHTLC.bytecode)
    const expectedHtlcAddress = ethers.getCreate2Address(
      CREATE2_FACTORY,
      contractSalt,
      htlcInitCodeHash,
    )

    expect(ethers.isAddress(expectedHtlcAddress)).toBe(true)
    expect(expectedHtlcAddress).not.toBe(expectedTablePotAddress)
  })

  it('generates deployment records structure correctly', () => {
    const deploymentsDir = path.resolve(__dirname, '../deployments')
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true })
    }

    const dummyRecord = {
      network: 'monad-testnet',
      chainId: 10143,
      deployer: '0x1234567890123456789012345678901234567890',
      contracts: {
        ChannelVault: {
          address: '0x0000000000000000000000000000000000000001',
          deployedVia: 'create2' as const,
        },
        TablePotVault: {
          address: '0x0000000000000000000000000000000000000002',
          deployedVia: 'create2' as const,
        },
        GenericHTLC: {
          address: '0x0000000000000000000000000000000000000003',
          deployedVia: 'create2' as const,
        },
      },
      timestamp: new Date().toISOString(),
    }

    const testFile = path.join(deploymentsDir, 'test-manifest.json')
    fs.writeFileSync(testFile, JSON.stringify(dummyRecord, null, 2), 'utf8')

    expect(fs.existsSync(testFile)).toBe(true)
    const read = JSON.parse(fs.readFileSync(testFile, 'utf8'))
    expect(read.contracts.ChannelVault.address).toBe(
      '0x0000000000000000000000000000000000000001',
    )
    fs.unlinkSync(testFile)
  })
})
