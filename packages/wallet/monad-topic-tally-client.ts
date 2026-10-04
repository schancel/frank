import axios from 'axios'
import { compareBytes, contentHash, defaultContext, validateFrame, matchForumPage, forumCursorToTransport, toHex, type Timestamp, type ForumCursor, type ForumTopicPage, type ForumDiscoveryPage, type ParsedFrame } from '@frank/codec'
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
interface BrowserForumResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: null | {
    cancel(): Promise<void>
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<void>
      releaseLock(): void
    }
  }
}
function browserTransport() {
  return globalThis as unknown as {
    window?: unknown
    fetch?: (url: string, init: { method: string; headers: Record<string,string>; signal: AbortSignal; credentials: 'omit' }) => Promise<BrowserForumResponse>
  }
}
async function browserRequest(url: string, params: Record<string,unknown>, controller: AbortController, remaining: number): Promise<Uint8Array> {
  const fetch = browserTransport().fetch
  if (!fetch) throw new Error('Browser Forum streaming is unavailable')
  const query = Object.entries(params).filter(([,value]) => value !== undefined)
    .map(([key,value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&')
  const started = clock()
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1,remaining))
  let response: BrowserForumResponse | undefined
  let reader: ReturnType<NonNullable<BrowserForumResponse['body']>['getReader']> | undefined
  try {
    response = await fetch(url + (query ? (url.includes('?') ? '&' : '?') + query : ''), {
      method:'GET', headers:{Accept:'application/cbor'}, signal:controller.signal, credentials:'omit',
    })
    if (!response.ok) throw Object.assign(new Error(`Forum HTTP ${response.status}`), {isAxiosError:true,response:{status:response.status}})
    if ((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/cbor') throw new Error('Expected application/cbor')
    const declared = response.headers.get('content-length')
    if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(RESPONSE_BYTES)) throw new Error('Forum response byte limit')
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Browser Forum streaming is unavailable')
    reader = response.body.getReader()
    // One fixed scratch buffer bounds overhead even when a hostile stream sends one-byte chunks.
    const scratch = new Uint8Array(RESPONSE_BYTES)
    let length = 0
    for (;;) {
      if (timedOut || clock()-started >= remaining) throw new Error('Forum snapshot lifetime limit')
      const chunk = await reader.read()
      if (timedOut || clock()-started >= remaining) throw new Error('Forum snapshot lifetime limit')
      if (chunk.done) break
      if (!chunk.value) throw new Error('Invalid Forum response stream')
      if (length + chunk.value.byteLength > RESPONSE_BYTES) throw new Error('Forum response byte limit')
      if (chunk.value.byteLength === 0) continue
      scratch.set(chunk.value,length)
      length += chunk.value.byteLength
    }
    return scratch.slice(0,length)
  } catch (error) {
    if (timedOut) throw new Error('Forum snapshot lifetime limit')
    throw error
  } finally {
    clearTimeout(timeout)
    controller.abort()
    try {
      if (reader) { try { await reader.cancel() } finally { reader.releaseLock() } }
      else await response?.body?.cancel()
    } catch { /* cancellation must not hide the original response error */ }
  }
}
async function request(url: string, params: Record<string, unknown>, signal?: AbortSignal, remaining = LIFETIME): Promise<Uint8Array> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  let oversize = false
  try {
    if (browserTransport().window !== undefined) return await browserRequest(url,params,controller,remaining)
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
/** A valid relay page may belong to a newly retained incarnation of exactly the same query.
 * Only metadata changes with the same last tuple are races; malformed frames remain permanent. */
function racedCursorEcho(page: ForumTopicPage<ParsedFrame> | ForumDiscoveryPage, sent?: ForumCursor): boolean {
  const echo = page.requestCursor
  if (!sent || !echo || echo.family !== sent.family || echo.network !== sent.network) return false
  if (echo.family === 13 && sent.family === 13) {
    if (echo.topic !== sent.topic || compareTime(echo.since, sent.since) ||
        compareTime(echo.last.timestamp, sent.last.timestamp) || compareBytes(echo.last.hash, sent.last.hash)) return false
  } else if (echo.family === 14 && sent.family === 14) {
    if (echo.last !== sent.last) return false
  } else return false
  return echo.revision !== sent.revision || compareBytes(echo.epoch, sent.epoch) !== 0 || echo.incarnation !== sent.incarnation
}
async function traverse(params: {relayBaseUrl:string;policy:ForumReadPolicy;topic?:string;sinceMs?:number;signal?:AbortSignal}, family:13|14): Promise<ForumMessage[]|DiscoveredTopic[]> {
  return exclusive(async () => {
    for (let attempt = 0; ; attempt++) {
      // Reserve fixed browser response scratch/final assembly; the rest is staged retained data.
      const started = clock(); let charged = RESPONSE_BYTES * 2, count = 0, cursor: ForumCursor|undefined
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
          charged += bytes.byteLength * 4
          if (charged > STAGING_BYTES) throw new Error('Forum staging limit')
          const validated = parsed(bytes).typed
          if (!validated || (validated.type !== 13 && validated.type !== 14) ||
              validated.type !== family || validated.network !== params.policy.network) throw new Error('Page network/family binding')
          if (validated.type === 13 && (validated.topic !== params.topic || compareTime(validated.since, since))) throw new Error('Page query binding')
          if (racedCursorEcho(validated, cursor)) throw new SnapshotRace('Valid snapshot cursor identity changed')
          const page = matchForumPage(bytes,{network:params.policy.network,family,topic:params.topic,since,requestCursor:cursor?.bytes}).typed
          if (!page || (page.type!==13 && page.type!==14)) throw new Error('Expected Forum page')
          const pageEpoch = toHex(page.epoch)
          if(epoch!==undefined && (epoch!==pageEpoch || revision!==page.revision)) throw new SnapshotRace('Snapshot changed')
          epoch=pageEpoch;revision=page.revision
          const rows = page.type===13?page.rows:page.entries
          if(rows.length>128 || (rows.length===0 && page.nextCursor)) throw new Error('Invalid page row count')
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
          if(!next) {
            // Decoding, signed-author projection and bookkeeping count toward this attempt too.
            if (clock()-started >= LIFETIME) throw new Error('Forum snapshot lifetime limit')
            return output as ForumMessage[]|DiscoveredTopic[]
          }
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
