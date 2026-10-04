import axios from 'axios'
import { compareBytes, contentHash, defaultContext, validateFrame, matchForumPage, forumCursorToTransport, toHex, type Timestamp, type ForumCursor } from '@frank/codec'
import { projectForumView, type ForumReadPolicy, type ForumMessage, type DiscoveredTopic } from './forum-model'
export type { DiscoveredTopic } from './forum-model'

const RESPONSE_BYTES = 4 * 1024 * 1024, STAGING_BYTES = 64 * 1024 * 1024, ROWS = 32768, LIFETIME = 120000
// Serialize staging across callers: aggregate refresh allocation has the same bound as one query.
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work); queue = result.then(() => undefined, () => undefined); return result
}
class SnapshotRace extends Error {}
const clock = () => performance.now()
function timestamp(ms: number): Timestamp {
  if (!Number.isSafeInteger(ms)) throw new Error('Invalid inclusive since milliseconds')
  const seconds = Math.floor(ms / 1000)
  return { seconds: BigInt(seconds), nanoseconds: (ms - seconds * 1000) * 1000000 }
}
function compareTime(a: Timestamp,b: Timestamp): number { return a.seconds < b.seconds ? -1 : a.seconds > b.seconds ? 1 : a.nanoseconds - b.nanoseconds }
async function request(url: string, params: Record<string, unknown>, signal?: AbortSignal, remaining = LIFETIME): Promise<Uint8Array> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  let oversize = false
  try {
    const response = await axios({
      method: 'get', url, params, headers: { Accept: 'application/cbor' },
      responseType: 'arraybuffer', maxContentLength: RESPONSE_BYTES,
      maxBodyLength: RESPONSE_BYTES, timeout: Math.max(1, remaining),
      signal: controller.signal,
      onDownloadProgress: (progress: { loaded: number; total?: number }) => {
        if (progress.loaded > RESPONSE_BYTES || (progress.total ?? 0) > RESPONSE_BYTES) {
          oversize = true
          controller.abort()
        }
      },
    })
    if (oversize) throw new Error('Forum response byte limit')
    if (String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/cbor') throw new Error('Expected application/cbor')
    const bytes = new Uint8Array(response.data)
    if (bytes.byteLength > RESPONSE_BYTES) throw new Error('Forum response byte limit')
    return bytes
  } catch (error) {
    if (oversize) throw new Error('Forum response byte limit')
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
function parsed(bytes: Uint8Array) {
  const result = validateFrame(bytes,defaultContext())
  if(result.kind !== 'parsed') throw new Error('Invalid Forum frame')
  return result
}
async function traverse(params: {relayBaseUrl:string;policy:ForumReadPolicy;topic?:string;sinceMs?:number;signal?:AbortSignal}, family:13|14): Promise<ForumMessage[]|DiscoveredTopic[]> {
  return exclusive(async () => {
    for (let attempt = 0; ; attempt++) {
      const started = clock(); let charged = 0, count = 0, cursor: ForumCursor|undefined
      let epoch: string|undefined, revision: bigint|undefined, incarnation: bigint|undefined
      let last: {timestamp:Timestamp;hash:Uint8Array}|string|undefined
      const seen = new Set<string>(), output: (ForumMessage|DiscoveredTopic)[] = []
      const since = timestamp(params.sinceMs ?? 0)
      try {
        for (;;) {
          if (clock()-started >= LIFETIME) throw new Error('Forum snapshot lifetime limit')
          const bytes = await request(params.relayBaseUrl.replace(/\/+$/,'')+'/message/monad/topics'+(family===14?'/discover':''),
            family===13?{topic:params.topic,since:params.sinceMs ?? 0,cursor:cursor && forumCursorToTransport(cursor.bytes)}:{cursor:cursor && forumCursorToTransport(cursor.bytes)}, params.signal, LIFETIME-(clock()-started))
          if (clock()-started >= LIFETIME) throw new Error('Forum snapshot lifetime limit')
          const page = matchForumPage(bytes,{network:params.policy.network,family,topic:params.topic,since,requestCursor:cursor?.bytes}).typed
          if (!page || (page.type!==13 && page.type!==14)) throw new Error('Expected Forum page')
          const pageEpoch = toHex(page.epoch)
          if(epoch!==undefined && (epoch!==pageEpoch || revision!==page.revision)) throw new SnapshotRace('Snapshot changed')
          epoch=pageEpoch;revision=page.revision
          const rows = page.type===13?page.rows:page.entries
          if(rows.length>128 || (rows.length===0 && page.nextCursor)) throw new Error('Invalid page row count')
          // Reserve encoded buffer and parsed nested-frame/container overhead conservatively.
          charged += bytes.byteLength * 4
          for (const row of rows) {
            let key:string, projected:ForumMessage|DiscoveredTopic
            if(page.type===13) {
              const viewFrame = row as typeof page.rows[number]
              const view = viewFrame.typed
              if (view?.type !== 12) throw new Error('Expected Forum view')
              if(view.revision!==revision || toHex(view.epoch)!==epoch) throw new SnapshotRace('View snapshot changed')
              const hash=contentHash(view.postFrame), tuple={timestamp:view.firstVisible,hash}
              const previous=last as typeof tuple|undefined
              if(compareTime(tuple.timestamp,since)<0 || (previous && (compareTime(previous.timestamp,tuple.timestamp)>0 || (compareTime(previous.timestamp,tuple.timestamp)===0 && compareBytes(previous.hash,hash)>=0)))) throw new Error('Nonadvancing topic rows')
              if(view.postFrame.typed?.type!==9 || view.postFrame.typed.topic!==params.topic) throw new Error('Cross-topic row')
              key=toHex(hash);last=tuple;projected=projectForumView(viewFrame,params.policy)
            } else {
              const entry=row as typeof page.entries[number]
              if(typeof last==='string' && compareBytes(new TextEncoder().encode(last),new TextEncoder().encode(entry.topic))>=0) throw new Error('Nonadvancing discovery rows')
              key=entry.topic;last=key;projected={topic:key,postCount:entry.count.toString(),lastActivityMs:Number(entry.lastActivity.seconds)*1000+entry.lastActivity.nanoseconds/1e6,
                lastActivity:{seconds:entry.lastActivity.seconds.toString(),nanoseconds:entry.lastActivity.nanoseconds},epoch,revision:revision.toString()}
            }
            if(seen.has(key)) throw new Error('Duplicate Forum row')
            seen.add(key); charged += JSON.stringify(projected).length * 2 + key.length * 2 + 256
            if(++count>ROWS || charged>STAGING_BYTES) throw new Error('Forum staging limit')
            output.push(projected)
          }
          if(charged>STAGING_BYTES) throw new Error('Forum staging limit')
          const next=page.nextCursor
          if(!next) return output as ForumMessage[]|DiscoveredTopic[]
          if(next.revision!==revision || toHex(next.epoch)!==epoch || next.network!==params.policy.network || next.family!==family || (incarnation!==undefined && next.incarnation!==incarnation)) throw new SnapshotRace('Cursor incarnation changed')
          if(next.family===13) {
            const tuple=last as {timestamp:Timestamp;hash:Uint8Array}
            if(next.topic!==params.topic || compareTime(next.since,since)!==0 || compareTime(next.last.timestamp,tuple.timestamp)!==0 || compareBytes(next.last.hash,tuple.hash)) throw new Error('Cursor last tuple mismatch')
          } else if(next.last!==last) throw new Error('Cursor last topic mismatch')
          if(cursor && compareBytes(cursor.bytes,next.bytes)===0) throw new Error('Nonadvancing cursor')
          incarnation=next.incarnation;cursor=next
        }
      } catch(error) {
        const expired = axios.isAxiosError(error) && error.response?.status===410
        if(attempt>=2 || (!(error instanceof SnapshotRace) && !expired)) throw error
      }
    }
  })
}
export async function fetchMonadTopicPostsSince(params:{relayBaseUrl:string;topic:string;sinceMs?:number;policy:ForumReadPolicy;signal?:AbortSignal}):Promise<ForumMessage[]> { return await traverse(params,13) as ForumMessage[] }
export async function fetchDiscoveredTopics(params:{relayBaseUrl:string;policy:ForumReadPolicy;signal?:AbortSignal}):Promise<DiscoveredTopic[]> { return await traverse(params,14) as DiscoveredTopic[] }
export async function fetchMonadTopicPostView(params:{relayBaseUrl:string;payloadHashHex:string;policy:ForumReadPolicy;signal?:AbortSignal}):Promise<ForumMessage|undefined> {
  return exclusive(async()=>{
    try {
      const viewFrame=parsed(await request(params.relayBaseUrl.replace(/\/+$/,'')+'/message/monad/topics/'+params.payloadHashHex,{},params.signal))
      const message=projectForumView(viewFrame,params.policy)
      if(message.payloadDigest!==params.payloadHashHex.toLowerCase()) throw new Error('Requested T1 mismatch')
      return message
    } catch(error) { if(axios.isAxiosError(error) && error.response?.status===404) return undefined; throw error }
  })
}
