/** Pure Lotus public-frame precursor. No native chain, POP, receipt or burn-credit authority. */
import { sha256 } from '@noble/hashes/sha256'
import type { Encodable } from './cbor'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { commonTranscript, contentHash } from './hash'
import { isCompressedPoint } from './point'
import type { LotusNetwork, LotusPayload, LotusReference, ParsedFrame } from './types'
import { defaultContext, validateFrame } from './validate'
import { verifyAlgorithm1 } from './verify'

export const LOTUS_SIGNATURE_DOMAIN = 'frank/lotus-public-signature/v1'
export interface LotusProjection {
  /** Owned exact original bytes, never a reconstructed envelope. */
  frame: Uint8Array
  payload: LotusPayload<ParsedFrame>
}
const bad = (message: string) => new FrankCodecError('schema', '8.2', message, 'lotus/writer')
function closed(value: object, keys: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad('expected object')
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw bad(`unexpected field ${key}`)
}
const map = (pairs: [number, Encodable][]) => new Map<number, Encodable>(pairs)
function reference(r: LotusReference): Encodable {
  closed(r, ['origin', 'hash'])
  return map([[0, r.origin], [1, r.hash]])
}
function checked(bytes: Uint8Array): ParsedFrame {
  const p = validateFrame(bytes, defaultContext())
  if (p.kind !== 'parsed' || !p.typed || p.typeId < 32 || p.typeId > 43) throw bad('expected a typed Lotus frame')
  return p
}
/** Validates and owns the exact frame and projection; historical variants assert no author authentication. */
export function projectLotusPayload(bytes: Uint8Array): LotusProjection {
  const p = checked(bytes)
  return { frame: p.frame, payload: p.typed as LotusPayload<ParsedFrame> }
}
/** Closed host writer followed by the shared typed validator, including required-child graph budgets. */
export function encodeLotusPayload(p: LotusPayload<Uint8Array>): Uint8Array {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw bad('expected a Lotus payload object')
  let pairs: [number, Encodable][]
  let keys: string[]
  const add = (key: number, name: string, value: Encodable | undefined) => {
    if (Object.prototype.hasOwnProperty.call(p, name)) {
      if (value === undefined) throw bad(`present ${name} cannot be undefined`)
      pairs.push([key, value])
    }
  }
  switch (p.type) {
    case 32:
    case 33: {
      keys = p.type === 32 ? ['type', 'network', 'timestamp', 'ttl', 'entries'] : ['type', 'network', 'topic', 'timestamp', 'entries', 'parent']
      const entries = p.entries.map(e => {
        closed(e, ['kind', 'headers', 'body'])
        return map([[0, e.kind], [1, e.headers.map(h => {
          if (!Array.isArray(h) || h.length !== 2) throw bad('header requires exactly two strings')
          return [h[0], h[1]]
        })], [2, e.body]])
      })
      pairs = p.type === 32 ? [[0,p.network],[1,p.timestamp],[2,p.ttl],[3,entries]] : [[0,p.network],[1,p.topic],[2,p.timestamp],[3,entries]]
      if (p.type === 33) add(4, 'parent', p.parent === undefined ? undefined : reference(p.parent))
      break
    }
    case 34:
      keys = ['type','network','target','direction']
      pairs = [[0,p.network],[1,reference(p.target)],[2,p.direction]]
      break
    case 35:
      keys = ['type','title','url','message']; pairs = []
      add(0,'title',p.title); add(1,'url',p.url); add(2,'message',p.message)
      break
    case 36:
      keys = ['type','network','bodyFrame','signatures','burns','claimedBurn']
      pairs = [[0,p.network],[1,p.bodyFrame],[2,p.signatures.map(s => {
        closed(s,['algorithm','signer','signature']); closed(s.signer,['keyType','keyBytes'])
        return map([[0,s.algorithm],[1,map([[0,s.signer.keyType],[1,s.signer.keyBytes]])],[2,s.signature]])
      })],[3,p.burns.map(b => {
        closed(b,['raw','outputIndex']); return map([[0,b.raw],[1,b.outputIndex]])
      })]]
      add(4,'claimedBurn',p.claimedBurn)
      break
    case 37:
      keys = ['type','network','legacyDigest','author','kind','observedTime','ttl','parent','totalBurn','componentCount','authorTime','target']
      closed(p.author,['keyType','keyBytes'])
      pairs = [[0,p.network],[1,p.legacyDigest],[2,map([[0,p.author.keyType],[1,p.author.keyBytes]])],[3,p.kind],[4,p.observedTime],[7,p.totalBurn],[8,p.componentCount]]
      add(5,'ttl',p.ttl); add(6,'parent',p.parent === undefined ? undefined : reference(p.parent)); add(9,'authorTime',p.authorTime); add(10,'target',p.target === undefined ? undefined : reference(p.target))
      break
    case 38:
      keys = ['type','network','collection','epoch','incarnation','ceiling','rows','nextCursor','requestCursor']
      pairs = [[0,p.network],[1,p.collection],[2,p.epoch],[3,p.incarnation],[4,p.ceiling],[5,p.rows.map(r => {
        closed(r,['typeId','index','sequence','time','target'])
        const fields: [number,Encodable][] = [[0,r.typeId],[1,r.index],[2,r.sequence],[3,r.time]]
        if (Object.prototype.hasOwnProperty.call(r,'target')) {
          if (r.target === undefined) throw bad('present target cannot be undefined')
          fields.push([4,reference(r.target)])
        }
        return map(fields)
      })]]
      add(6,'nextCursor',p.nextCursor); add(7,'requestCursor',p.requestCursor)
      break
    case 39:
      keys = ['type','network','target','revision','physical','support','oppose']
      pairs = [[0,p.network],[1,reference(p.target)],[2,p.revision],[3,p.physical],[4,p.support],[5,p.oppose]]
      break
    case 40:
      keys = ['type','network','requestIndex','phase','txids','sequence','reason']
      pairs = [[0,p.network],[1,p.requestIndex],[2,p.phase],[3,p.txids]]
      add(4,'sequence',p.sequence); add(5,'reason',p.reason)
      break
    case 41:
      keys = ['type','network','origins']; pairs = [[0,p.network],[1,p.origins]]
      break
    case 42:
      keys = ['type','network','code','requestIndex','retryable']; pairs = [[0,p.network],[1,p.code],[3,p.retryable]]
      add(2,'requestIndex',p.requestIndex)
      break
    case 43:
      keys = ['type','network','legacyDigest','componentOrdinal','path','encoding','totalBytes','offset','bytes']
      pairs = [[0,p.network],[1,p.legacyDigest],[2,p.componentOrdinal],[3,p.path],[4,p.encoding],[5,p.totalBytes],[6,p.offset],[7,p.bytes]]
      break
    default: throw bad('unallocated Lotus type')
  }
  closed(p,keys)
  const frame = encodeFrame({typeId:p.type,schemaVersion:1,minReaderVersion:1},map(pairs))
  checked(frame)
  return frame
}
function body(bytes: Uint8Array): ParsedFrame {
  const p = checked(bytes)
  if (p.typeId < 32 || p.typeId > 34) throw bad('expected a Lotus authored body')
  return p
}
export function lotusBodyHash(frame: Uint8Array): Uint8Array { return contentHash(body(frame)) }
export function lotusSignatureDigest(frame: Uint8Array): Uint8Array {
  const p = body(frame)
  const network = (p.typed as LotusPayload<ParsedFrame> & {network:string}).network
  return sha256(commonTranscript(LOTUS_SIGNATURE_DOMAIN,network,p.frame))
}
/** Ordinary SHA-256 exact-GET index, distinct from authored-body T1. */
export function lotusRequestIndex(frame: Uint8Array): Uint8Array {
  const p = checked(frame)
  if (![36,37,43].includes(p.typeId)) throw bad('exact-GET indices exist for types 36, 37 and 43')
  return sha256(p.frame)
}
export function lotusBurnCommitment(frame: Uint8Array, author: Uint8Array): Uint8Array {
  if (!isCompressedPoint(author)) throw bad('author must be a valid compressed secp256k1 point')
  const bytes = new Uint8Array(64)
  bytes.set(sha256(author)); bytes.set(lotusBodyHash(frame),32)
  return sha256(bytes)
}
/** Exact native OP_RETURN PUSH4 STMP/POND OP_1 PUSH32 commitment, without a transaction parser. */
export function lotusBurnScript(frame: Uint8Array, author: Uint8Array): Uint8Array {
  const p = body(frame)
  const prefix = p.typeId === 32 ? [0x53,0x54,0x4d,0x50] : [0x50,0x4f,0x4e,0x44]
  const out = new Uint8Array(40)
  out.set([0x6a,0x04,...prefix,0x51,0x20]); out.set(lotusBurnCommitment(p.frame,author),8)
  return out
}
/** Signature evidence only: no native-chain/burn/POP/economic admission follows from success. */
export function verifyLotusSignatureEvidence(frame: Uint8Array): LotusProjection {
  const projection = projectLotusPayload(frame)
  const p = projection.payload
  if (p.type !== 36) throw bad('signature evidence requires a submission')
  const entry = p.signatures[0]
  if (entry.algorithm === 3) throw new FrankCodecError('unsupported','10.6','algorithm 3 is allocated but not verifiable in this slice (M7)','root/payload.2[0]')
  if (!verifyAlgorithm1(lotusSignatureDigest(p.bodyFrame.frame),entry.signature,entry.signer.keyBytes)) throw new FrankCodecError('cryptographic','10.6','Lotus signature does not verify over the exact body transcript','root/payload.2[0]')
  return projection
}
/** Explicit accepted native mapping; XPI testnet and non-Lotus families have no row. */
export function lotusNetworkDescriptor(network: LotusNetwork): { family:'xpi'; net:'mainnet'|'regtest'; nativeNetwork:'Network::XPI'; nativeNet:'Net::Mainnet'|'Net::Regtest' } {
  if (network === 'xpi-mainnet') return {family:'xpi',net:'mainnet',nativeNetwork:'Network::XPI',nativeNet:'Net::Mainnet'}
  if (network === 'xpi-regtest') return {family:'xpi',net:'regtest',nativeNetwork:'Network::XPI',nativeNet:'Net::Regtest'}
  throw bad('unsupported native Lotus network')
}
