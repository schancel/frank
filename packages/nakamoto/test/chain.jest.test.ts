import {
  BCH_MAINNET,
  BTC_MAINNET,
  BTC_TESTNET,
  CHAINS,
  XEC_MAINNET,
  XPI_MAINNET,
  XPI_REGTEST,
  XPI_TESTNET,
  addressVersionBytes,
  getChain,
} from '../src'

describe('chain descriptors', () => {
  test('there are twelve chains and no default', () => {
    expect(CHAINS).toHaveLength(12)
    expect(Object.isFrozen(CHAINS)).toBe(true)
    const keys = CHAINS.map(chain => `${chain.family}:${chain.network}`)
    expect(new Set(keys).size).toBe(12)
    expect(getChain('btc', 'mainnet')).toBe(BTC_MAINNET)
  })

  test('BTC mainnet matches Bitcoin Core chainparams and the signed-message magic', () => {
    expect(BTC_MAINNET.p2pMagic).toBe(0xf9beb4d9)
    expect(BTC_MAINNET.p2pPort).toBe(8333)
    expect(BTC_MAINNET.bech32Hrp).toBe('bc')
    expect(BTC_MAINNET.pubkeyHashVersion).toBe(0)
    expect(BTC_MAINNET.scriptHashVersion).toBe(5)
    expect(BTC_MAINNET.wifVersion).toBe(128)
    expect(BTC_MAINNET.hdPublicVersion).toBe(0x0488b21e)
    expect(BTC_MAINNET.hdPrivateVersion).toBe(0x0488ade4)
    expect(BTC_MAINNET.registeredSlip44).toBe(0)
    expect(BTC_MAINNET.messageMagic).toEqual({
      status: 'pinned',
      text: 'Bitcoin Signed Message:\n',
      source: expect.any(String),
    })
    expect(BTC_MAINNET.cashaddrPrefix).toBeNull()
    expect(BTC_MAINNET.displayUnit).toMatchObject({
      status: 'pinned',
      satoshisPerUnit: 100_000_000n,
    })
  })

  test('XEC signed-message magic is the Bitcoin ABC string', () => {
    for (const item of [
      XEC_MAINNET,
      getChain('xec', 'testnet'),
      getChain('xec', 'regtest'),
    ]) {
      expect(item).toMatchObject({
        messageMagic: {
          status: 'pinned',
          text: 'eCash Signed Message:\n',
        },
      })
    }
  })

  test('XPI signed-message magic is the lotusd string', () => {
    for (const item of [XPI_MAINNET, XPI_TESTNET, XPI_REGTEST]) {
      expect(item).toMatchObject({
        messageMagic: {
          status: 'pinned',
          text: 'Bitcoin Signed Message:\n',
        },
      })
    }
  })

  test('BCH signed-message magic is the Bitcoin Cash Node string', () => {
    for (const item of [
      BCH_MAINNET,
      getChain('bch', 'testnet'),
      getChain('bch', 'regtest'),
    ]) {
      expect(item).toMatchObject({
        messageMagic: {
          status: 'pinned',
          text: 'Bitcoin Signed Message:\n',
        },
      })
    }
  })

  test('BCH and XEC share P2P magic and differ by cashaddr prefix', () => {
    expect(BCH_MAINNET.p2pMagic).toBe(0xe3e1f3e8)
    expect(XEC_MAINNET.p2pMagic).toBe(BCH_MAINNET.p2pMagic)
    expect(BCH_MAINNET.p2pPort).toBe(8333)
    expect(XEC_MAINNET.p2pPort).toBe(8333)
    expect(BCH_MAINNET.cashaddrPrefix).toBe('bitcoincash')
    expect(XEC_MAINNET.cashaddrPrefix).toBe('ecash')
    expect(getChain('bch', 'testnet')).toMatchObject({
      cashaddrPrefix: 'bchtest',
      p2pPort: 18333,
    })
    expect(getChain('xec', 'testnet')).toMatchObject({
      cashaddrPrefix: 'ectest',
    })
    expect(getChain('bch', 'regtest')).toMatchObject({
      cashaddrPrefix: 'bchreg',
      p2pMagic: 0xdab5bffa,
    })
    expect(getChain('xec', 'regtest')).toMatchObject({
      cashaddrPrefix: 'ecregtest',
    })
  })

  test('SLIP-44 coin types are documented and XEC does not default to 145', () => {
    expect(BCH_MAINNET.registeredSlip44).toBe(145)
    expect(XEC_MAINNET.registeredSlip44).toBe(899)
    expect(XEC_MAINNET.alsoDocumentsSlip44).toEqual([145, 1899])
    expect(XPI_MAINNET.registeredSlip44).toBe(10605)
    expect(XEC_MAINNET.registeredSlip44).not.toBe(145)
  })

  test('XPI matches lotusd ports and magic and does not pick a cashaddr prefix', () => {
    expect(XPI_MAINNET.p2pMagic).toBe(0xece7eff3)
    expect(XPI_MAINNET.p2pPort).toBe(10605)
    expect(XPI_TESTNET.p2pMagic).toBe(0xecf4f3f4)
    expect(XPI_TESTNET.p2pPort).toBe(11605)
    expect(XPI_REGTEST.p2pMagic).toBe(0xecf2e5e7)
    expect(XPI_REGTEST.p2pPort).toBe(12605)
    expect(XPI_MAINNET.cashaddrPrefix).toBeNull()
    expect(XPI_TESTNET.cashaddrPrefix).toBeNull()
    expect(XPI_REGTEST.cashaddrPrefix).toBeNull()
    expect(XPI_MAINNET.header).toMatchObject({
      kind: 'not-bitcoin-80',
      genesisSizeBytes: 379,
    })
    expect(XPI_MAINNET.sighash.kind).toBe('unpinned')
    for (const item of [XPI_MAINNET, XPI_TESTNET, XPI_REGTEST]) {
      expect(item.cashaddrPrefix).not.toBe('bitcoincash')
      expect(item.cashaddrPrefix).not.toBe('ecash')
    }
  })

  test('address version bytes require the chain that was passed', () => {
    expect(addressVersionBytes(BTC_MAINNET, 'pubkeyhash')).toBe(0)
    expect(addressVersionBytes(BTC_TESTNET, 'wif')).toBe(239)
    expect(addressVersionBytes(BCH_MAINNET, 'scripthash')).toBe(5)
    expect(addressVersionBytes(XPI_TESTNET, 'pubkeyhash')).toBe(111)
  })

  test('dust and relay fee are not the old single constant', () => {
    for (const item of CHAINS) {
      expect(item.dust.status).toBe('unpinned')
      expect(item.relayFeePerKb.status).toBe('unpinned')
      expect(Object.keys(item.dust)).toEqual(['status', 'reason'])
      expect(Object.keys(item.relayFeePerKb)).toEqual(['status', 'reason'])
    }
  })
})
