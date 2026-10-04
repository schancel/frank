import type { LotusPayload } from '../src'
import { fromHex, encodeLotusPayload } from '../src'
export const lotusAuthor = fromHex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
const digest = () => new Uint8Array(32)
export function lotusFixtures(): LotusPayload<Uint8Array>[] {
  const network = 'xpi-mainnet' as const
  const target = {origin:0 as const,hash:digest()}
  const text: LotusPayload<Uint8Array> = {type:35,title:'',message:'hello'}
  const entries = [{kind:'post',headers:[['a','b'] as const],body:encodeLotusPayload(text)},{kind:'custom',headers:[],body:Uint8Array.of(0,255)}]
  const metadata: LotusPayload<Uint8Array> = {type:32,network,timestamp:1n,ttl:60n,entries}
  const post: LotusPayload<Uint8Array> = {type:33,network,topic:'lotus.public',timestamp:2n,entries,parent:target}
  return [metadata,post,{type:34,network,target,direction:0},{type:34,network,target,direction:1},text,
    {type:36,network,bodyFrame:encodeLotusPayload(post),signatures:[{algorithm:3,signer:{keyType:1,keyBytes:lotusAuthor},signature:new Uint8Array(64)}],burns:[{raw:Uint8Array.of(1),outputIndex:0},{raw:Uint8Array.of(1),outputIndex:1}],claimedBurn:0n},
    {type:37,network,legacyDigest:digest(),author:{keyType:1,keyBytes:lotusAuthor},kind:0,observedTime:4n,ttl:60n,totalBurn:0n,componentCount:2n,authorTime:1n},
    {type:37,network,legacyDigest:digest(),author:{keyType:1,keyBytes:lotusAuthor},kind:1,observedTime:4n,parent:target,totalBurn:0n,componentCount:2n,authorTime:1n},
    {type:37,network,legacyDigest:digest(),author:{keyType:1,keyBytes:lotusAuthor},kind:2,observedTime:4n,totalBurn:0n,componentCount:2n,target},
    {type:38,network,collection:3,epoch:new Uint8Array(16),incarnation:1n,ceiling:4n,rows:[{typeId:36,index:digest(),sequence:3n,time:4n,target}],nextCursor:Uint8Array.of(99,117,114,115,111,114),requestCursor:Uint8Array.of(101,99,104,111)},
    {type:39,network,target,revision:1n,physical:3n,support:2n,oppose:1n},
    {type:40,network,requestIndex:digest(),phase:0,txids:[]},
    {type:40,network,requestIndex:digest(),phase:1,txids:[digest()],sequence:1n},
    {type:40,network,requestIndex:digest(),phase:2,txids:[digest()],reason:'rejected'},
    {type:40,network,requestIndex:digest(),phase:3,txids:[]},
    {type:41,network,origins:['https://a.example','https://b.example']},
    {type:42,network,code:'conflict',requestIndex:digest(),retryable:false},
    {type:43,network,legacyDigest:digest(),componentOrdinal:0n,path:[7n,0n,0n,0n],encoding:0,totalBytes:5n,offset:0n,bytes:Uint8Array.of(104,101,108,108,111)},
    {type:32,network:'xpi-regtest',timestamp:1n,ttl:60n,entries:[]}]
}
