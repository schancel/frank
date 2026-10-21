import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  calculateGenerator,
  confirmationTag,
  deriveIsk,
  generatorString,
  lvCat,
  sampleScalar,
  scalarMult,
  scalarMultVfy,
  transcriptIr,
} from './cpace'

const hex = (s: string) => hexToBytes(s.replace(/\s+/g, ''))

/** draft-irtf-cfrg-cpace-21, appendix B.3 (ristretto255, SHA-512). */
const V = {
  PRS: utf8ToBytes('Password'),
  CI: hex('0b415f696e69746961746f720b425f726573706f6e646572'),
  sid: hex('7e4b4791d6a8ef019b936c79fb7f2c57'),
  genStr: hex(`
    11435061636552697374726574746f3235350850617373776f726464
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000180b415f696e69746961746f
    720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f
    2c57`),
  g: '222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56',
  ADa: utf8ToBytes('ADa'),
  ya: hex('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08'),
  Ya: 'd6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157',
  ADb: utf8ToBytes('ADb'),
  yb: hex('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d'),
  Yb: '3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258',
  K: '80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f',
  transcriptIr: `
    20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0e
    ec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa
    8232b5ebe63324e2d9e7433f725803414462`,
  isk: `
    b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dc
    ae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c
    3fa2068af7900447`,
  invalidS: hex(
    '7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05',
  ),
  invalidY1: hex(
    '2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c',
  ),
}

describe('CPace ristretto255/SHA-512 against draft-irtf-cfrg-cpace-21 B.3', () => {
  it('builds the generator string and generator', () => {
    expect(bytesToHex(generatorString(V.PRS, V.CI, V.sid))).toBe(
      bytesToHex(V.genStr),
    )
    expect(calculateGenerator(V.PRS, V.CI, V.sid).toHex()).toBe(V.g)
  })

  it('computes Ya, Yb, K and ISK', () => {
    const g = calculateGenerator(V.PRS, V.CI, V.sid)
    const Ya = scalarMult(V.ya, g)
    const Yb = scalarMult(V.yb, g)
    expect(bytesToHex(Ya)).toBe(V.Ya)
    expect(bytesToHex(Yb)).toBe(V.Yb)
    const Ka = scalarMultVfy(V.ya, Yb)!
    const Kb = scalarMultVfy(V.yb, Ya)!
    expect(bytesToHex(Ka)).toBe(V.K)
    expect(bytesToHex(Kb)).toBe(V.K)
    expect(bytesToHex(transcriptIr(Ya, V.ADa, Yb, V.ADb))).toBe(
      V.transcriptIr.replace(/\s+/g, ''),
    )
    expect(bytesToHex(deriveIsk(V.sid, Ka, Ya, V.ADa, Yb, V.ADb))).toBe(
      V.isk.replace(/\s+/g, ''),
    )
  })

  it('rejects points that do not decode and the identity (B.3.11)', () => {
    expect(scalarMultVfy(V.invalidS, V.invalidY1)).toBeNull()
    expect(scalarMultVfy(V.invalidS, new Uint8Array(32))).toBeNull()
  })

  it('encodes lengths as LEB128', () => {
    expect(bytesToHex(lvCat(new Uint8Array(0)))).toBe('00')
    expect(bytesToHex(lvCat(new Uint8Array(200))).slice(0, 4)).toBe('c801')
  })

  it('samples scalars below 2^252', () => {
    for (let i = 0; i < 32; i++) expect(sampleScalar()[31]).toBeLessThan(16)
  })

  it('gives the two roles different confirmation tags', () => {
    const isk = hex(V.isk)
    const Ta = confirmationTag(V.sid, isk, hex(V.Ya), V.ADa)
    const Tb = confirmationTag(V.sid, isk, hex(V.Yb), V.ADb)
    expect(Ta).toHaveLength(64)
    expect(bytesToHex(Ta)).not.toBe(bytesToHex(Tb))
  })
})
