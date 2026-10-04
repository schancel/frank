import axios from 'axios'
import { encodeForumReadFrame, encodeFrame, encodeForumCursor, type Encodable } from '@frank/codec'
import { fetchMonadTopicPostsSince, fetchDiscoveredTopics, fetchMonadTopicPostView } from './monad-topic-tally-client'
import { type ForumReadPolicy } from './forum-model'
import { Wallet, Transaction, getBytes } from 'ethers'
import { encodeForumPost, contentHash, validateFrame, defaultContext, topicVoteCommitment, topicBurnCalldata } from '@frank/codec'
jest.mock('axios')
const policy: ForumReadPolicy = {network:'monad-testnet',chainId:10143n,burnAddress:'0x000000000000000000000000000000000000dEaD'}
async function viewFixture(index=1, magnitude=(1n<<255n)+1n, negative=false) {
  const post=encodeForumPost({network:policy.network,topic:'general',authored:{seconds:1n,nanoseconds:0},entries:[{title:'Exact',message:String(index)}]})
  const p=validateFrame(post,defaultContext());if(p.kind!=='parsed')throw Error('post')
  const wallet=new Wallet('0x'+'11'.repeat(32)), hash=contentHash(p)
  const raw=await wallet.signTransaction({type:2,chainId:policy.chainId,nonce:index,to:policy.burnAddress,value:9223372036854775807n,gasLimit:21000,maxFeePerGas:1,maxPriorityFeePerGas:1,data:topicBurnCalldata('up',topicVoteCommitment(policy.network,hash))})
  const tx=(await import('ethers')).Transaction.from(raw)
  const bytes=encodeForumReadFrame(12,new Map<number,Encodable>([[0,policy.network],[1,post],[2,getBytes(wallet.address)],[3,getBytes(raw)],[4,getBytes(tx.hash!)],[5,time(BigInt(index))],[6,0],[7,0],[8,new Map<number,Encodable>([[0,negative],[1,getBytes('0x'+magnitude.toString(16).padStart(64,'0'))]])],[9,18446744073709551615n],[10,new Uint8Array(16).fill(1)]]))
  return {bytes,hash}
}

const http=axios as jest.MockedFunction<typeof axios>
const time=(seconds:bigint)=>new Map<number,Encodable>([[0,seconds],[1,0]])
const epoch=new Uint8Array(16).fill(1),revision=18446744073709551615n
function topicPage(rows:Uint8Array[],next?:Uint8Array,echo?:Uint8Array){
  const map=new Map<number,Encodable>([[0,policy.network],[1,'general'],[2,time(0n)],[3,revision],[4,rows],[6,epoch]])
  if(next)map.set(5,next);if(echo)map.set(7,echo);return encodeForumReadFrame(13,map)
}
function discovery(topics:string[],next?:Uint8Array,echo?:Uint8Array){
 const map=new Map<number,Encodable>([[0,policy.network],[1,revision],[2,topics.map(topic=>new Map<number,Encodable>([[0,topic],[1,revision],[2,time(0n)]]))],[4,epoch]])
 if(next)map.set(3,next);if(echo)map.set(5,echo);return encodeFrame({typeId:14,schemaVersion:1,minReaderVersion:1},map)
}
function response(data:Uint8Array){return {data,headers:{'content-type':'application/cbor'}}}
const params={relayBaseUrl:'http://relay/',policy,topic:'general'}
beforeEach(()=>{jest.clearAllMocks();http.mockReset()})
it('traverses 129 canonical topic rows and publishes only complete output',async()=>{
 const fixtures=await Promise.all(Array.from({length:129},(_,i)=>viewFixture(i+1)))
 const cursor=encodeForumCursor({family:13,network:policy.network,epoch,revision,incarnation:1n,topic:'general',since:{seconds:0n,nanoseconds:0},last:{timestamp:{seconds:128n,nanoseconds:0},hash:fixtures[127].hash}})
 http.mockResolvedValueOnce(response(topicPage(fixtures.slice(0,128).map(x=>x.bytes),cursor))).mockResolvedValueOnce(response(topicPage([fixtures[128].bytes],undefined,cursor)))
 expect(await fetchMonadTopicPostsSince(params)).toHaveLength(129)
 expect(http.mock.calls[0][0]).toMatchObject({headers:{Accept:'application/cbor'},params:{topic:'general',since:0}})
 expect(http.mock.calls[1][0]).toMatchObject({params:{cursor:expect.any(String)}})
})
it('traverses discovery without rounding counts and fails on continuation loss',async()=>{
 const cursor=encodeForumCursor({family:14,network:policy.network,epoch,revision,incarnation:1n,last:'a'})
 http.mockResolvedValueOnce(response(discovery(['a'],cursor))).mockResolvedValueOnce(response(discovery(['b'],undefined,cursor)))
 expect((await fetchDiscoveredTopics(params))[1].postCount).toBe(revision.toString())
 http.mockResolvedValueOnce(response(discovery(['a'],cursor))).mockRejectedValueOnce(Error('lost'))
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow('lost')
})
it('retries expiry with fresh first page at most twice',async()=>{
 ;(axios.isAxiosError as unknown as jest.Mock).mockImplementation((e:any)=>e?.isAxiosError===true)
 const error={isAxiosError:true,response:{status:410}}
 http.mockRejectedValue(error)
 await expect(fetchDiscoveredTopics(params)).rejects.toEqual(error)
 expect(http).toHaveBeenCalledTimes(3)
 expect(http.mock.calls.every(([config])=>!(config as any).params.cursor)).toBe(true)
})
it('rejects missing cursor echo and duplicate rows without empty fallback',async()=>{
 const cursor=encodeForumCursor({family:14,network:policy.network,epoch,revision,incarnation:1n,last:'a'})
 http.mockResolvedValueOnce(response(discovery(['a'],cursor))).mockResolvedValueOnce(response(discovery(['b'])))
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow()
 http.mockResolvedValueOnce(response(discovery(['a'],cursor))).mockResolvedValueOnce(response(discovery(['a'],undefined,cursor)))
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow()
})
it('rejects wrong requested T1 and wrong author policy',async()=>{
 const {bytes}=await viewFixture()
 http.mockResolvedValueOnce(response(bytes))
 await expect(fetchMonadTopicPostView({...params,payloadHashHex:'00'.repeat(32)})).rejects.toThrow('T1 mismatch')
 http.mockResolvedValueOnce(response(bytes))
 await expect(fetchMonadTopicPostView({...params,payloadHashHex:'00'.repeat(32),policy:{...policy,burnAddress:'0x'+'22'.repeat(20)}})).rejects.toThrow('policy mismatch')
})
it('bounds discovery staging at 32768 rows without publishing its prefix',async()=>{
 let pageIndex=0
 http.mockImplementation(async()=>{
  const topics=Array.from({length:128},(_,i)=>String(pageIndex*128+i).padStart(6,'0'))
  const makeCursor=(last:string)=>encodeForumCursor({family:14,network:policy.network,epoch,revision,incarnation:1n,last})
  const next=makeCursor(topics[127]),echo=pageIndex===0?undefined:makeCursor(String(pageIndex*128-1).padStart(6,'0'))
  pageIndex++;return response(discovery(topics,next,echo)) as any
 })
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow('staging limit')
 expect(http).toHaveBeenCalledTimes(257)
})
it('serializes concurrent staging and leaves a failed query distinguishable from empty',async()=>{
 let resolve!: (value:any)=>void
 http.mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValueOnce(response(discovery([])))
 const first=fetchDiscoveredTopics(params),second=fetchDiscoveredTopics(params)
 await new Promise(r=>setImmediate(r));expect(http).toHaveBeenCalledTimes(1)
 resolve(response(discovery([])))
 expect(await first).toEqual([]);expect(await second).toEqual([]);expect(http).toHaveBeenCalledTimes(2)
})
it('rejects an oversized response before decoding',async()=>{
 http.mockResolvedValueOnce(response(new Uint8Array(4*1024*1024+1)))
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow('byte limit')
})
it('does not renew the 120 second attempt lifetime after a slow response',async()=>{
 const original = Object.getOwnPropertyDescriptor(globalThis,'performance')
 let elapsed = 0
 // Keep the real Promise scheduler and timers alive; only the monotonic observation advances.
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>elapsed}})
 http.mockImplementationOnce(async()=>{elapsed=120000;return response(discovery([])) as any})
 try {await expect(fetchDiscoveredTopics(params)).rejects.toThrow('lifetime limit')}
 finally {
   if(original) Object.defineProperty(globalThis,'performance',original)
   else Reflect.deleteProperty(globalThis,'performance')
 }
})
it('aborts download accumulation on announced or received response oversize',async()=>{
 http.mockImplementationOnce(async(config:any)=>{
   config.onDownloadProgress({loaded:1,total:4*1024*1024+1})
   expect(config.signal.aborted).toBe(true)
   throw Error('cancelled')
 })
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow('byte limit')
})
it('charges projection and bookkeeping toward the 64 MiB attempt bound',async()=>{
 let pageIndex=0
 const topic=(index:number)=>String(index).padStart(6,'0')+'x'.repeat(490)
 http.mockImplementation(async()=>{
  const topics=Array.from({length:128},(_,i)=>topic(pageIndex*128+i))
  const makeCursor=(last:string)=>encodeForumCursor({family:14,network:policy.network,epoch,revision,incarnation:1n,last})
  const next=makeCursor(topics[127]),echo=pageIndex===0?undefined:makeCursor(topic(pageIndex*128-1))
  pageIndex++;return response(discovery(topics,next,echo)) as any
 })
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow('staging limit')
 expect(pageIndex).toBeLessThan(257)
})
it('retries a fully validated same-query incarnation race from a fresh first page',async()=>{
 const old=encodeForumCursor({family:14,network:policy.network,epoch,revision,incarnation:1n,last:'a'})
 const fresh=encodeForumCursor({family:14,network:policy.network,epoch,revision,incarnation:2n,last:'a'})
 http.mockResolvedValueOnce(response(discovery(['a'],old)))
   .mockResolvedValueOnce(response(discovery(['b'],undefined,fresh)))
   .mockResolvedValueOnce(response(discovery(['complete'])))
 expect((await fetchDiscoveredTopics(params)).map(row=>row.topic)).toEqual(['complete'])
 expect((http.mock.calls[2][0] as any).params.cursor).toBeUndefined()
 expect(http).toHaveBeenCalledTimes(3)
})
it('does not retry an intrinsically malformed cursor/page revision binding',async()=>{
 const cursor=encodeForumCursor({family:14,network:policy.network,epoch,revision:revision-1n,incarnation:1n,last:'a'})
 http.mockResolvedValueOnce(response(discovery(['a'],cursor)))
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow('cursor page binding')
 expect(http).toHaveBeenCalledTimes(1)
})
it('does not retry valid pages whose echo changed the last tuple',async()=>{
 const old=encodeForumCursor({family:14,network:policy.network,epoch,revision,incarnation:1n,last:'a'})
 const forged=encodeForumCursor({family:14,network:policy.network,epoch,revision,incarnation:2n,last:'changed'})
 http.mockResolvedValueOnce(response(discovery(['a'],old))).mockResolvedValueOnce(response(discovery(['z'],undefined,forged)))
 await expect(fetchDiscoveredTopics(params)).rejects.toThrow('cursor echo')
 expect(http).toHaveBeenCalledTimes(2)
})

describe('bounded browser Forum streaming',()=>{
 let previousWindow: PropertyDescriptor | undefined, previousFetch: PropertyDescriptor | undefined
 beforeEach(()=>{
  previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window')
  previousFetch=Object.getOwnPropertyDescriptor(globalThis,'fetch')
  Object.defineProperty(globalThis,'window',{configurable:true,value:{}})
 })
 afterEach(()=>{
  if(previousWindow) Object.defineProperty(globalThis,'window',previousWindow)
  else Reflect.deleteProperty(globalThis,'window')
  if(previousFetch) Object.defineProperty(globalThis,'fetch',previousFetch)
  else Reflect.deleteProperty(globalThis,'fetch')
 })
 function responseStream(chunks:Uint8Array[],declared:string|null=null) {
  const read=jest.fn().mockImplementation(async()=>chunks.length?{done:false,value:chunks.shift()}:{done:true})
  const cancel=jest.fn().mockResolvedValue(undefined),releaseLock=jest.fn()
  const bodyCancel=jest.fn().mockResolvedValue(undefined)
  const getReader=jest.fn(()=>({read,cancel,releaseLock}))
  const response={ok:true,status:200,headers:{get:(name:string)=>name==='content-type'?'application/cbor':declared},body:{getReader,cancel:bodyCancel}}
  return {response,read,cancel,releaseLock,getReader,bodyCancel}
 }
 it('rejects announced oversize before reading and cancels the response',async()=>{
  const stream=responseStream([],String(4*1024*1024+1)),fetch=jest.fn().mockResolvedValue(stream.response)
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:fetch})
  await expect(fetchDiscoveredTopics(params)).rejects.toThrow('byte limit')
  expect(stream.getReader).not.toHaveBeenCalled();expect(stream.bodyCancel).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][1]).toMatchObject({credentials:'omit',headers:{Accept:'application/cbor'}})
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);expect(http).not.toHaveBeenCalled()
 })
 it('caps unknown-length chunks before assembly and never publishes a prefix',async()=>{
  const stream=responseStream(Array.from({length:66},()=>new Uint8Array(65536)))
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:jest.fn().mockResolvedValue(stream.response)})
  await expect(fetchDiscoveredTopics(params)).rejects.toThrow('byte limit')
  expect(stream.read).toHaveBeenCalledTimes(65)
  expect(stream.cancel).toHaveBeenCalledTimes(1);expect(stream.releaseLock).toHaveBeenCalledTimes(1)
 })
 it('publishes a complete streamed snapshot and refuses unsupported streaming without XHR fallback',async()=>{
  const bytes=discovery(['complete']),stream=responseStream([bytes.slice(0,5),bytes.slice(5)])
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:jest.fn().mockResolvedValue(stream.response)})
  expect((await fetchDiscoveredTopics(params))[0].topic).toBe('complete')
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:undefined})
  await expect(fetchDiscoveredTopics(params)).rejects.toThrow('streaming is unavailable')
  expect(http).not.toHaveBeenCalled()
 })
})
it('browser streaming handles many one-byte chunks with a single bounded response buffer',async()=>{
 const windowDescriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),fetchDescriptor=Object.getOwnPropertyDescriptor(globalThis,'fetch')
 const bytes=discovery(Array.from({length:128},(_,i)=>String(i).padStart(6,'0')+'x'.repeat(256)))
 let offset=0,readCount=0,cancelled=false
 const reader={
   read:async()=>{readCount++;return offset<bytes.length?{done:false,value:bytes.subarray(offset,++offset)}:{done:true}},
   cancel:async()=>{cancelled=true},releaseLock:()=>{},
 }
 Object.defineProperty(globalThis,'window',{configurable:true,value:{}})
 Object.defineProperty(globalThis,'fetch',{configurable:true,value:async()=>({ok:true,status:200,
   headers:{get:(name:string)=>name==='content-type'?'application/cbor':null},body:{getReader:()=>reader,cancel:async()=>{}}})})
 try {
   expect(await fetchDiscoveredTopics(params)).toHaveLength(128)
   expect(readCount).toBe(bytes.length+1);expect(cancelled).toBe(true)
 } finally {
   if(windowDescriptor)Object.defineProperty(globalThis,'window',windowDescriptor);else Reflect.deleteProperty(globalThis,'window')
   if(fetchDescriptor)Object.defineProperty(globalThis,'fetch',fetchDescriptor);else Reflect.deleteProperty(globalThis,'fetch')
 }
})
