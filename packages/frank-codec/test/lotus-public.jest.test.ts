import corpus from '../../../docs/protocol/cbor/vectors/lotus-public.json'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { lotusAuthor, lotusFixtures } from '../fixtures/lotus-public'
import { encodeLotusPayload, projectLotusPayload, fromHex, toHex, lotusBodyHash, lotusSignatureDigest, lotusBurnCommitment, lotusBurnScript, lotusRequestIndex, verifyLotusSignatureEvidence, lotusNetworkDescriptor, validateFrame, defaultContext, encodeFrame, FrankCodecError, FrankContextError, Encodable, LotusPayload, decodeCanonical } from '../src'

describe('Lotus public codec precursor',()=>{
  const inputs=lotusFixtures()
  test.each(corpus.origin_cases)('portable HTTPS origin $id',v=>{
    if(v.accept) {
      const p=projectLotusPayload(fromHex(v.frame_hex)).payload
      expect(p.type===41 && p.origins).toEqual([v.origin])
      expect(toHex(encodeLotusPayload({type:41,network:'xpi-mainnet',origins:[v.origin]}))).toBe(v.frame_hex)
    } else {
      try{projectLotusPayload(fromHex(v.frame_hex));throw Error('accepted noncanonical origin')}
      catch(e){expect(e).toBeInstanceOf(FrankCodecError);expect((e as FrankCodecError).category).toBe('semantic');expect((e as FrankCodecError).stage).toBe('9')}
    }
  })
  test.each(corpus.positive.map((v,i)=>({v,i})))('independent bytes $v.id',({v,i})=>{
    const bytes=fromHex(v.frame_hex)
    expect(toHex(encodeLotusPayload(inputs[i]))).toBe(v.frame_hex)
    expect(projectLotusPayload(bytes).payload.type).toBe(v.type_id)
    if('body_hash_hex' in v) {
      expect(toHex(lotusBodyHash(bytes))).toBe(v.body_hash_hex)
      expect(toHex(lotusSignatureDigest(bytes))).toBe(v.signature_digest_hex)
      expect(toHex(lotusBurnCommitment(bytes,lotusAuthor))).toBe(v.burn_commitment_hex)
      const script=lotusBurnScript(bytes,lotusAuthor)
      expect(script.length).toBe(40)
      expect(toHex(script.subarray(8))).toBe(v.burn_commitment_hex)
    }
    if('request_index_hex' in v) expect(toHex(lotusRequestIndex(bytes))).toBe(v.request_index_hex)
  })
  test.each(corpus.negative)('closed hostile $id',v=>{
    try {projectLotusPayload(fromHex(v.frame_hex));throw Error('accepted hostile input')}
    catch(e) {expect(e).toBeInstanceOf(FrankCodecError);expect((e as FrankCodecError).category).toBe(v.error.category);expect((e as FrankCodecError).stage).toBe(v.error.stage)}
  })
  test.each(corpus.positive)('compatible future shape remains closed $id',v=>{
    const parsed=validateFrame(fromHex(v.frame_hex));if(parsed.kind!=='parsed')throw Error('wrong result')
    const payload=decodeCanonical(parsed.payloadBytes)
    if(!(payload instanceof Map))throw Error('wrong map')
    const extended=new Map(payload);extended.set(99n,'extension')
    const frame=encodeFrame({typeId:v.type_id,schemaVersion:2,minReaderVersion:1},extended)
    try{projectLotusPayload(frame);throw Error('accepted extension')}catch(e){expect(e).toBeInstanceOf(FrankCodecError);expect((e as FrankCodecError).category).toBe('schema');expect((e as FrankCodecError).stage).toBe('8.2')}
  })
  test('owns exact original bytes after successful validation',()=>{
    const bytes=encodeLotusPayload(inputs[1]);const p=projectLotusPayload(bytes);const exact=toHex(p.frame)
    bytes.fill(0);expect(toHex(p.frame)).toBe(exact)
    if(p.payload.type!==33)throw Error('wrong type')
    expect(p.payload.entries[0].postFrame?.typed?.type).toBe(35)
    expect(p.payload.entries[0].body[0]).toBe(0x46)
  })
  test('both selected outputs survive; repeated selected index fails',()=>{
    const input=inputs[5]
    if(input.type!==36)throw Error('wrong type')
    const p=projectLotusPayload(encodeLotusPayload(input)).payload
    expect(p.type===36 && p.burns.map(b=>b.outputIndex)).toEqual([0,1])
    expect(()=>encodeLotusPayload({...input,burns:[input.burns[0],input.burns[0]]})).toThrow(FrankCodecError)
  })
  test('algorithm1 exact transcript evidence; algorithm3 explicit unsupported and full missing context',()=>{
    const input=inputs[5];if(input.type!==36)throw Error('wrong type')
    const key=new Uint8Array(32);key[31]=1
    const signature=secp256k1.sign(lotusSignatureDigest(input.bodyFrame),key).toDERRawBytes()
    const frame=encodeLotusPayload({...input,signatures:[{algorithm:1,signer:{keyType:1,keyBytes:lotusAuthor},signature}]})
    expect(verifyLotusSignatureEvidence(frame).payload.type).toBe(36)
    const changed={...input,bodyFrame:encodeLotusPayload({...inputs[0],timestamp:2n} as LotusPayload<Uint8Array>),signatures:[{algorithm:1,signer:{keyType:1,keyBytes:lotusAuthor},signature}]}
    expect(()=>verifyLotusSignatureEvidence(encodeLotusPayload(changed))).toThrow(FrankCodecError)
    try {verifyLotusSignatureEvidence(encodeLotusPayload(input));throw Error('accepted unsupported')}
    catch(e){expect(e).toBeInstanceOf(FrankCodecError);expect((e as FrankCodecError).category).toBe('unsupported');expect((e as FrankCodecError).stage).toBe('10.6')}
    expect(()=>validateFrame(frame,defaultContext({operation:'full'}))).toThrow(FrankContextError)
  })
  test('assigned Lotus frames excluded from item slots',()=>{
    for(const input of inputs){const f=encodeFrame({typeId:16,schemaVersion:1,minReaderVersion:1},new Map<number,Encodable>([[0,[encodeLotusPayload(input)]]]))
      expect(()=>validateFrame(f)).toThrow(FrankCodecError)}
  })
  test('root and required child frame limits, count bounds and shared depth',()=>{
    const text=encodeFrame({typeId:35,schemaVersion:1,minReaderVersion:1},new Map<number,Encodable>([[2,'x'.repeat(262144)]]))
    expect(()=>projectLotusPayload(text)).toThrow(FrankCodecError)
    const post=encodeFrame({typeId:33,schemaVersion:1,minReaderVersion:1},new Map<number,Encodable>([[0,'xpi-mainnet'],[1,'lotus'],[2,0n],[3,[new Map<number,Encodable>([[0,'post'],[1,[]],[2,text]])]]]))
    try{projectLotusPayload(post);throw Error('oversized nested accepted')}catch(e){expect(e).toBeInstanceOf(FrankCodecError);expect((e as FrankCodecError).category).toBe('resource');expect((e as FrankCodecError).stage).toBe('8.1')}
    const input=inputs[0];if(input.type!==32)throw Error('wrong type')
    expect(()=>encodeLotusPayload({...input,entries:Array.from({length:65},()=>({kind:'x',headers:[],body:new Uint8Array(0)}))})).toThrow(FrankCodecError)
    expect(()=>encodeLotusPayload({...input,entries:[{kind:'x',headers:Array.from({length:33},(_,i)=>[String(i),''] as const),body:new Uint8Array(0)}]})).toThrow(FrankCodecError)
    const submission=inputs[5];if(submission.type!==36)throw Error('wrong type')
    expect(()=>encodeLotusPayload({...submission,burns:[{raw:new Uint8Array(1048577),outputIndex:0}]})).toThrow(FrankCodecError)
  })
  test('required children inherit graph depth rather than fresh roots',()=>{
    let nested:Encodable=0n
    for(let i=0;i<25;i++)nested=[nested]
    const text=encodeFrame({typeId:35,schemaVersion:1,minReaderVersion:1},new Map<number,Encodable>([[0,nested]]))
    try{projectLotusPayload(text);throw Error('accepted shape')}catch(e){expect((e as FrankCodecError).category).toBe('schema')}
    const metadata=encodeFrame({typeId:32,schemaVersion:1,minReaderVersion:1},new Map<number,Encodable>([[0,'xpi-mainnet'],[1,0n],[2,0n],[3,[new Map<number,Encodable>([[0,'post'],[1,[]],[2,text]])]]]))
    const input=inputs[5];if(input.type!==36)throw Error('wrong type')
    const signature=input.signatures[0]
    const frame=encodeFrame({typeId:36,schemaVersion:1,minReaderVersion:1},new Map<number,Encodable>([[0,'xpi-mainnet'],[1,metadata],[2,[new Map<number,Encodable>([[0,signature.algorithm],[1,new Map<number,Encodable>([[0,1],[1,lotusAuthor]])],[2,signature.signature]])]],[3,[]]]))
    try{projectLotusPayload(frame);throw Error('accepted deep graph')}catch(e){expect(e).toBeInstanceOf(FrankCodecError);expect((e as FrankCodecError).category).toBe('resource')}
  })
  test('network mappings, absent versus empty and writer closure',()=>{
    expect(lotusNetworkDescriptor('xpi-mainnet').nativeNet).toBe('Net::Mainnet')
    expect(lotusNetworkDescriptor('xpi-regtest').nativeNet).toBe('Net::Regtest')
    for(const network of ['xpi-testnet','bch-mainnet','xec-regtest']) expect(()=>lotusNetworkDescriptor(network as 'xpi-mainnet')).toThrow(FrankCodecError)
    expect(toHex(encodeLotusPayload({type:35,title:''}))).not.toBe(toHex(encodeLotusPayload({type:35,message:''})))
    expect(()=>encodeLotusPayload({type:35,title:'',extra:1} as unknown as LotusPayload<Uint8Array>)).toThrow(FrankCodecError)
    expect(()=>encodeLotusPayload({type:35,title:undefined} as LotusPayload<Uint8Array>)).toThrow(FrankCodecError)
  })
})
