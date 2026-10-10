import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Run against the app served for a running `yarn demo` (Monad testnet). No account is reused; the
// new account is funded with a real transfer from FRANK_TEST_WALLET_JSON (FORUM_FUND_MON).
const origin = process.env.FORUM_APP_ORIGIN ?? 'http://127.0.0.1:9699'
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname),
)
const directory = await mkdtemp(join(tmpdir(), 'frank-forum-browser-'))
const executable =
  process.env.FORUM_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const codecPath = resolve(
  fileURLToPath(
    new URL('../../packages/frank-codec/src/index.ts', import.meta.url),
  ),
)
let child, socket, call, sessionId, streamServer
let interceptResponse = async event =>
  call('Fetch.continueRequest', { requestId: event.params.requestId })
let events = []
const allEvents = []
async function stop() {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([
      ended,
      new Promise(resolve =>
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
          resolve()
        }, 5000),
      ),
    ])
  }
}
async function launch(profile = 'first') {
  events = []
  child = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(directory, profile)}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(
      () => reject(new Error('Chrome startup timeout')),
      20000,
    )
    child.once('error', reject)
    child.stderr.on('data', data => {
      output += data
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let sequence = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (!message.id) {
      events.push(message)
      allEvents.push(message)
      if (message.method === 'Fetch.requestPaused')
        interceptResponse(message).catch(error => {
          console.error(error)
          process.exitCode = 1
        })
      return
    }
    const handler = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) handler?.reject(new Error(message.error.message))
    else handler?.resolve(message.result)
  }
  call = (method, params = {}, tab = sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId: tab }))
    })
  await openTab()
}
async function openTab() {
  const { targetId } = await call(
    'Target.createTarget',
    { url: 'about:blank' },
    undefined,
  )
  sessionId = (
    await call('Target.attachToTarget', { targetId, flatten: true }, undefined)
  ).sessionId
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Network.enable')
  await call('Page.enable')
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    window.__forumWire=[];window.__forumResponseCaptures=[];
    const bytes=async value=>value==null?[]:Array.from(value instanceof Blob?new Uint8Array(await value.arrayBuffer()):value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new TextEncoder().encode(value));
    const originalFetch=window.fetch;
    window.fetch=async function(input,init={}) {
      const url=typeof input==='string'?input:input.url;
      if(!url.includes('/message/monad/topics'))return originalFetch.apply(this,arguments);
      const row={url,method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),request:await bytes(init.body)};
      window.__forumWire.push(row);
      const response=await originalFetch.apply(this,arguments);
      row.status=response.status; row.contentType=response.headers.get('content-type');row.contentLength=response.headers.get('content-length');row.captureResponse=!window.__forumSkipResponseCapture;
      if(!window.__forumSkipResponseCapture){
        if(row.method==='GET'&&response.body){
          const getReader=response.body.getReader.bind(response.body);
          response.body.getReader=function(...args){
            const reader=getReader(...args),read=reader.read.bind(reader);let chunks=[],length=0;
            reader.read=async function(){
              try{const result=await read();
                if(result.done){const body=new Uint8Array(length);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}row.response=Array.from(body);chunks=[];}
                else if(result.value){length+=result.value.byteLength;if(length<=4194304)chunks.push(result.value.slice());else throw Error('observer capture limit');}
                return result;
              }catch(error){row.captureError={name:error.name,message:error.message};throw error;}
            };return reader;
          };
        }else{
        const capture=response.clone().arrayBuffer().then(body=>row.response=Array.from(new Uint8Array(body))).catch(error=>{row.captureError={name:error.name,message:error.message};});
        window.__forumResponseCaptures.push(capture);
        }
      }
      return response;
    };
    const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send,setHeader=XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open=function(method,url){this.__forum={url:String(url),method,headers:{}};return open.apply(this,arguments)};
    XMLHttpRequest.prototype.setRequestHeader=function(k,v){this.__forum.headers[k.toLowerCase()]=v;return setHeader.apply(this,arguments)};
    XMLHttpRequest.prototype.send=function(body){const row=this.__forum;if(row.url.includes('/message/monad/topics')){window.__forumWire.push(row);bytes(body).then(v=>row.request=v);this.addEventListener('loadend',()=>{row.status=this.status;row.contentType=this.getResponseHeader('content-type');bytes(this.response).then(v=>row.response=v)})}return send.apply(this,arguments)};
  `,
  })
  await call('Page.navigate', { url: origin + '/#/setup' })
  await until(
    `Array.isArray(window.__forumWire) && Array.isArray(window.__forumResponseCaptures)`,
  )
  await until(
    `document.querySelector('[data-test="new-account"]') || document.querySelector('[data-test="activate-account"]') || document.querySelector('[data-test="account-error"]')`,
  )
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression: `(async () => (${expression}))()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    )
  return result.result.value
}
async function until(expression) {
  for (let n = 0; n < 200; n++) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const errors = events
    .filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => e.params.exceptionDetails.exception?.description)
  errors.push(
    ...events
      .filter(
        e =>
          e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error',
      )
      .flatMap(e => e.params.args.map(a => a.description ?? a.value)),
  )
  throw new Error(
    'Browser condition timed out: ' +
      expression +
      '\n' +
      errors.join('\n') +
      '\n' +
      (await evaluate('document.body.innerText.slice(0,1500)')),
  )
}
const selector = name => `[data-test="${name}"]`
async function click(name) {
  await evaluate(
    `document.querySelector(${JSON.stringify(selector(name))}).click()`,
  )
  await new Promise(resolve => setTimeout(resolve, 30))
}
async function input(name, value) {
  await evaluate(
    `(() => { const root = document.querySelector(${JSON.stringify(
      selector(name),
    )}); const el = root.matches('input,textarea') ? root : root.querySelector('input,textarea'); const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(
      value,
    )}); el.dispatchEvent(new Event('input', {bubbles:true})); })()`,
  )
}

async function pressEnter(selector) {
  const target = await evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    const input = root?.matches('input,textarea') ? root : root?.querySelector('input,textarea');
    if (!input) throw new Error('Missing marked input: ' + ${JSON.stringify(
      selector,
    )});
    input.focus();
    return { rootTag: root.tagName, inputTag: input.tagName, focused: document.activeElement === input };
  })()`)
  assert.equal(
    target.focused,
    true,
    'Enter must target the actual marked input',
  )
  console.log('Actual marked input for Enter:', target)
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  })
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  })
}
const forumState = `document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia.state.value.forum`
async function createPost(title, body, parent) {
  await evaluate(
    `location.hash=${JSON.stringify(
      parent ? '#/new-post/' + parent : '#/new-post',
    )}`,
  )
  await until(`document.querySelector('[data-test="post-title"]')`)
  if (parent)
    await until(
      `!document.querySelector('[data-test="parent-resolution-status"]')`,
    )
  await input('post-offering', '0.000000000000000001')
  await input('post-title', title)
  await input('post-message', body)
  await evaluate(`document.querySelector('form').requestSubmit()`)
  await until(`!location.hash.includes('new-post')`)
  await until(`document.body.innerText.includes(${JSON.stringify(title)})`)
}
try {
  await launch()
  await click('new-account')
  await until(`document.querySelector('[data-test="backup-policy"]')`)
  await evaluate(
    `document.querySelector('[data-test="backup-policy"] [role="radio"]').click()`,
  )
  await click('generate-backups')
  await until(`document.querySelector('[data-test="backup-share"]')`)
  const shares = []
  for (let i = 0; i < 3; i++) {
    shares.push(
      await evaluate(
        `document.querySelector('[data-test="backup-share"]').value`,
      ),
    )
    await click('next-share')
  }
  await click('descriptor-saved')
  await click('confirm-backups')
  await input('confirm-shares', shares.slice(0, 2).join('\n'))
  await input('display-name', 'Synthetic Forum proof')
  await click('verify-backups')
  await until(`document.querySelector('[data-test="activate-account"]')`)
  await click('activate-account')
  await until(`location.hash==='#/wallet'`)
  // Fund the new account's receive address on the real chain and wait until the wallet sees it.
  const receive = await evaluate(
    `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name).then(async m => (await (await m.accountSession.getWallet()).getReceiveAddress()).raw)`,
  )
  await new Promise((resolveFund, reject) =>
    execFile(
      process.execPath,
      [
        '--import',
        'tsx',
        'packages/bot/demo/fund.ts',
        receive,
        process.env.FORUM_FUND_MON ?? '0.1',
      ],
      {
        cwd: resolve(fileURLToPath(new URL('../..', import.meta.url))),
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: 'packages/bot/tsconfig.json',
        },
        timeout: 180000,
      },
      (error, _stdout, stderr) =>
        error
          ? reject(
              new Error(`funding failed: ${(stderr || error.message).trim()}`),
            )
          : resolveFund(),
    ),
  )
  await until(
    `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name).then(async m => (await (await m.accountSession.getWallet()).getBalance()) > 0n)`,
  )
  await evaluate(`location.hash='#/forum'`)
  await until(`document.querySelector('[data-test="forum-threshold"]')`)
  console.log(
    'Actual Forum drawer before opening:',
    await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Forum settings"]');
    const root = document.querySelector('[data-test="forum-topic"]');
    const field = root.matches('input,textarea') ? root : root.querySelector('input,textarea');
    return { expanded: button?.getAttribute('aria-expanded'), rootTag: root.tagName, fieldTag: field.tagName, drawerClass: field.closest('.q-drawer')?.className };
  })()`),
  )
  await evaluate(
    `document.querySelector('button[aria-label="Forum settings"]').click()`,
  )
  await until(
    `document.querySelector('button[aria-label="Forum settings"]').getAttribute('aria-expanded')==='true'`,
  )
  await until(`(() => {
    const root = document.querySelector('[data-test="forum-topic"]');
    const field = root.matches('input,textarea') ? root : root.querySelector('input,textarea');
    const box = field.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && !field.closest('[inert]');
  })()`)
  await input('forum-topic', 'news')
  await pressEnter('[data-test="forum-topic"]')
  await until(`${forumState}.selectedTopic==='news'`)
  // Drive the real drawer's QInput. One wei above Number's precise integer range.
  const threshold = '0.009007199254740993'
  await input('forum-threshold', threshold)
  await until(`${forumState}.voteThreshold===${JSON.stringify(threshold)}`)
  assert.equal(await evaluate(`${forumState}.voteThreshold`), threshold)
  assert.equal(
    await evaluate(
      `document.querySelector('[data-test="forum-threshold"]').value`,
    ),
    threshold,
  )
  await input('forum-threshold', '0')
  await until(`${forumState}.voteThreshold==='0'`)
  const title = 'Forum browser ' + Date.now()
  const body = 'Exact rendered schema-2 body'
  await createPost(title, body)
  const digest = await evaluate(
    `${forumState}.messages.find(m=>m.entries.some(e=>e.title===${JSON.stringify(
      title,
    )})).payloadDigest`,
  )
  assert.match(digest, /^[0-9a-f]{64}$/)
  await evaluate(`location.hash=${JSON.stringify('#/forum/' + digest)}`)
  await until(`document.body.innerText.includes(${JSON.stringify(body)})`)
  await createPost(title + ' reply', 'Exact rendered reply', digest)
  await evaluate(`location.hash=${JSON.stringify('#/forum/' + digest)}`)
  await until(`document.body.innerText.includes('Exact rendered reply')`)
  for (const direction of ['up', 'down']) {
    await until(
      `document.querySelector('[data-test="forum-vote-${direction}"]')`,
    )
    const before = await evaluate(
      `window.__forumWire.filter(r=>r.method==='PUT'&&r.url.endsWith('/vote')).length`,
    )
    await click('forum-vote-' + direction)
    await until(
      `window.__forumWire.filter(r=>r.method==='PUT'&&r.url.endsWith('/vote')&&r.status>=200&&r.status<300).length>${before}`,
    )
  }
  // Explicit normal status refresh, without constructing replacement signed operations.
  const status = await evaluate(`(async()=>{
    const chain=await import('/@fs'+${JSON.stringify(
      resolve(
        fileURLToPath(
          new URL('../../packages/wallet/chain/index.ts', import.meta.url),
        ),
      ),
    )});
    const session=await import(performance.getEntriesByType('resource').find(e=>e.name.includes('/src/accounts/session.ts')).name);
    await chain.activeChain.topics.reconcileOperations({wallet:await session.accountSession.getWallet()});
    const request=window.__forumWire.find(r=>r.method==='PUT'&&!r.url.endsWith('/vote'));
    const response=await fetch(request.url+'/status',{method:'POST',headers:{'content-type':'application/cbor',accept:'application/cbor'},body:new Uint8Array(request.request)});
    return response.status;
  })()`)
  assert.equal(status, 200)
  const audit = await evaluate(`(async()=>{
    const c=await import('/@fs'+${JSON.stringify(codecPath)});
    await Promise.all(window.__forumResponseCaptures);
    const seen=new Set(),directions=new Set();
    for(const row of window.__forumWire){
      if(!row.status||row.status<200||row.status>=300)continue;
      if(row.captureError){
        if(row.method!=='GET'||row.captureError.name!=='AbortError')throw Error('unexpected response capture failure '+JSON.stringify(row));
        console.log('Canceled read capture:',row.url,row.captureError);
        continue;
      }
      if(row.headers.accept!=='application/cbor')throw Error('non-CBOR Accept '+row.url);
      if(row.method==='PUT'||row.method==='POST'){
        if(row.headers['content-type']!=='application/cbor')throw Error('non-CBOR Content-Type');
        const p=c.validateFrame(new Uint8Array(row.request),c.defaultContext());
        if(p.kind!=='parsed'||![10,11].includes(p.typeId))throw Error('noncanonical request');
        seen.add(p.typeId);
        if(p.typeId===10){
          const post=p.typed.postFrame;
          if(post.schemaVersion!==2)throw Error('schema-1 post');
          const entry=post.typed.content.entries[0];
          if(entry.title===${JSON.stringify(title)}){
            if(entry.message!==${JSON.stringify(
              body,
            )}||c.toHex(c.contentHash(post))!==${JSON.stringify(
    digest,
  )}||post.typed.parentHash)throw Error('root title/body/T1 changed');
          }else if(entry.title===${JSON.stringify(title + ' reply')}){
            if(entry.message!=='Exact rendered reply'||c.toHex(post.typed.parentHash)!==${JSON.stringify(
              digest,
            )})throw Error('reply parent/body changed');
          }else throw Error('unexpected fixture post');
          seen.add(9);
        }

      }
      if(row.contentType?.split(';')[0]!=='application/cbor')throw Error('non-CBOR response');
      const p=c.validateFrame(new Uint8Array(row.response),c.defaultContext());
      if(p.kind!=='parsed'||![12,13,14,15].includes(p.typeId))throw Error('unexpected canonical response');
      seen.add(p.typeId);
      if(p.typeId===15 && p.typed.submittedFrame.typeId===11)directions.add(p.typed.direction);
    }
    if(!directions.has(0)||!directions.has(1))throw Error('missing exact up/down operation statuses');
    return {seen:[...seen].sort((a,b)=>a-b),wireCount:window.__forumWire.length};
  })()`)
  assert.deepEqual(audit.seen, [9, 10, 11, 12, 13, 14, 15])
  console.log('Canonical normal flow witnesses:', audit)
  await evaluate(`location.hash='#/forum'`)
  await until(
    `document.querySelector('a.post-title') && ${forumState}.isRefreshing===false`,
  )
  await evaluate(`(async()=>{
    const m=await import('/src/stores/forum.ts');
    const session=await import(performance.getEntriesByType('resource').find(e=>e.name.includes('/src/accounts/session.ts')).name);
    const pinia=document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia;
    await m.useForumStore(pinia).refreshMessages({wallet:await session.accountSession.getWallet(),topic:'news'});
    window.__forumActions=[];
    m.useForumStore(pinia).$onAction(({name,args,after})=>{
      if(['invalidateRefresh','setSelectedTopic','setDuration','refreshMessages'].includes(name)){
        const row={name,args:args.map(a=>typeof a==='object'?'object':a),stack:new Error().stack};window.__forumActions.push(row);after(()=>{row.finished=true});
      }
    });
  })()`)
  // Alter relay observation fields only; immutable post bytes and signed author proof remain exact.
  // The single read slot queues the newer generation behind the old HTTP response.
  let held,
    heldCurrent,
    heldCount = 0,
    weight = (1n << 255n) + 1n
  const transformed = async event => {
    const { body, base64Encoded } = await call('Fetch.getResponseBody', {
      requestId: event.params.requestId,
    })
    const bytes = base64Encoded
      ? Buffer.from(body, 'base64')
      : Buffer.from(body)
    const encoded = await evaluate(`(async()=>{
      const c=await import('/@fs'+${JSON.stringify(codecPath)});
      const p=c.validateFrame(new Uint8Array(${JSON.stringify([
        ...bytes,
      ])}),c.defaultContext());
      if(p.kind!=='parsed'||p.typeId!==13)throw Error('fixture requires exact type13');
      const payload=p.payload;
      payload.set(3n,18446744073709551615n);
      const magnitude=c.fromHex(${JSON.stringify(
        (weight < 0n ? -weight : weight).toString(16).padStart(64, '0'),
      )});
      payload.set(4n,payload.get(4n).map(raw=>{
        const view=c.validateFrame(raw,c.defaultContext());
        view.payload.set(8n,new Map([[0n,${weight < 0n}],[1n,magnitude]]));
        view.payload.set(9n,18446744073709551615n);
        return c.encodeForumReadFrame(12,view.payload);
      }));
      return Array.from(c.encodeForumReadFrame(13,payload));
    })()`)
    await call('Fetch.fulfillRequest', {
      requestId: event.params.requestId,
      responseCode: 200,
      responseHeaders: [
        ...event.params.responseHeaders.filter(
          h =>
            !['content-length', 'content-encoding'].includes(
              h.name.toLowerCase(),
            ),
        ),
        { name: 'content-length', value: String(encoded.length) },
      ],
      body: Buffer.from(encoded).toString('base64'),
    })
  }
  interceptResponse = async event => {
    const url = new URL(event.params.request.url)
    if (
      url.pathname !== '/message/monad/topics' ||
      url.searchParams.get('topic') !== 'news'
    ) {
      await call('Fetch.continueRequest', { requestId: event.params.requestId })
      return
    }
    if (heldCount++ === 0) {
      held = event
      return
    }
    if (heldCount === 2) {
      heldCurrent = event
      return
    }
    await transformed(event)
  }
  await call('Fetch.enable', {
    patterns: [
      { urlPattern: '*/message/monad/topics?*', requestStage: 'Response' },
    ],
  })
  const refresh = `(async()=>{
    const m=await import('/src/stores/forum.ts');
    const session=await import(performance.getEntriesByType('resource').find(e=>e.name.includes('/src/accounts/session.ts')).name);
    const pinia=document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia;
    const task=m.useForumStore(pinia).refreshMessages({wallet:await session.accountSession.getWallet(),topic:'news'});
    window.__refreshStarts=(window.__refreshStarts??0)+1;
    return task;
  })()`
  const oldSnapshot = await evaluate(`JSON.stringify(${forumState}.messages)`)
  await evaluate(
    `(()=>{window.__olderRefresh=${refresh}.then(()=>true);return true})()`,
  )
  for (let n = 0; !held && n < 200; n++)
    await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(held, 'older HTTP response reached interception')
  assert.equal(
    await evaluate(`JSON.stringify(${forumState}.messages)`),
    oldSnapshot,
    'staged response has not published',
  )
  await evaluate(
    `(()=>{window.__currentRefresh=${refresh}.then(()=>true);return true})()`,
  )
  await until(`window.__refreshStarts===2 && ${forumState}.isRefreshing===true`)
  assert.equal(
    heldCurrent,
    undefined,
    'current generation waits for the shared read slot',
  )
  await call('Fetch.continueRequest', { requestId: held.params.requestId })
  await evaluate(`window.__olderRefresh`)
  for (let n = 0; !heldCurrent && n < 200; n++)
    await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(
    heldCurrent,
    'current generation reaches HTTP after old slot releases',
  )
  assert.equal(
    await evaluate(`JSON.stringify(${forumState}.messages)`),
    oldSnapshot,
    'old result and staged current response cannot publish',
  )
  console.log(
    'Held generation lifecycle:',
    await evaluate(`window.__forumActions`),
  )
  assert.equal(
    await evaluate(`${forumState}.isRefreshing`),
    true,
    'old finally cannot clear current loading',
  )
  await transformed(heldCurrent)
  await evaluate(`window.__currentRefresh`)
  await until(
    `${forumState}.messages.some(m=>m.payloadDigest===${JSON.stringify(
      digest,
    )}&&m.voteWeightWei===${JSON.stringify(weight.toString())})`,
  )
  assert.equal(
    await evaluate(`${forumState}.isRefreshing`),
    false,
    'current complete publication clears loading',
  )
  await input('forum-threshold', '0.009007199254740993')
  await evaluate(`location.hash='#/forum'`)
  await until(
    `Array.from(document.querySelectorAll('a.post-title')).some(e=>e.textContent===${JSON.stringify(
      title,
    )}&&e.getClientRects().length>0)`,
  )
  assert.equal(
    await evaluate(`${forumState}.index[${JSON.stringify(digest)}].revision`),
    '18446744073709551615',
  )
  weight = -weight
  await evaluate(refresh)
  await until(
    `${forumState}.index[${JSON.stringify(
      digest,
    )}].voteWeightWei===${JSON.stringify(weight.toString())}`,
  )
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('a.post-title')).some(e=>e.textContent===${JSON.stringify(
        title,
      )}&&e.getClientRects().length>0)`,
    ),
    false,
    'negative wide amount is filtered by exact positive threshold',
  )
  weight = 0n
  await input('forum-threshold', '0')
  await evaluate(refresh)
  await until(
    `${forumState}.index[${JSON.stringify(digest)}].voteWeightWei==='0'`,
  )
  assert.ok(
    await evaluate(
      `Array.from(document.querySelectorAll('a.post-title')).some(e=>e.textContent===${JSON.stringify(
        title,
      )}&&e.getClientRects().length>0)`,
    ),
    'zero aggregate renders at zero threshold',
  )
  // Split the actual signed root/reply observations into two canonical pages.
  // The invented cursor is served by this isolated interception fixture, with exact echo.
  let continuation, pagingFixture
  const fulfill = async (event, bytes) => {
    await call('Fetch.fulfillRequest', {
      requestId: event.params.requestId,
      responseCode: 200,
      responseHeaders: [
        ...event.params.responseHeaders.filter(
          h =>
            !['content-length', 'content-encoding', 'content-type'].includes(
              h.name.toLowerCase(),
            ),
        ),
        { name: 'content-type', value: 'application/cbor' },
        { name: 'content-length', value: String(bytes.length) },
      ],
      body: Buffer.from(bytes).toString('base64'),
    })
  }
  interceptResponse = async event => {
    const url = new URL(event.params.request.url)
    const query = url.searchParams
    if (
      url.pathname !== '/message/monad/topics' ||
      query.get('topic') !== 'news'
    ) {
      await call('Fetch.continueRequest', { requestId: event.params.requestId })
      return
    }
    assert.equal(query.get('topic'), 'news')
    if (query.has('cursor')) {
      assert.ok(pagingFixture, 'continuation requires its original first page')
      assert.equal(
        query.get('cursor'),
        pagingFixture.cursor,
        'continuation sends exact retained cursor',
      )
      assert.equal(
        query.get('since'),
        pagingFixture.since,
        'continuation retains inclusive query',
      )
      assert.equal(
        continuation,
        undefined,
        'only one bounded terminal continuation',
      )
      continuation = event
      return
    }
    const { body, base64Encoded } = await call('Fetch.getResponseBody', {
      requestId: event.params.requestId,
    })
    const raw = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body)
    pagingFixture = await evaluate(`(async()=>{
      const c=await import('/@fs'+${JSON.stringify(codecPath)});
      const page=c.validateFrame(new Uint8Array(${JSON.stringify([
        ...raw,
      ])}),c.defaultContext());
      if(page.kind!=='parsed'||page.typeId!==13)throw Error('expected actual first topic page');
      const rows=page.typed.rows.filter(view=>{
        const title=view.typed.postFrame.typed.content.entries[0].title;
        return title===${JSON.stringify(title)}||title===${JSON.stringify(
      title + ' reply',
    )};
      });
      if(rows.length!==2)throw Error('first fixture response must contain exact signed root and reply');
      const encoded=rows.map(view=>{
        view.payload.set(8n,new Map([[0n,false],[1n,c.fromHex('0'.repeat(63)+'7')]]));
        view.payload.set(9n,18446744073709551615n);
        return c.encodeForumReadFrame(12,view.payload);
      });
      const firstView=rows[0].typed;
      const cursor=c.encodeForumCursor({family:13,network:page.typed.network,
        revision:18446744073709551615n,epoch:page.typed.epoch,incarnation:1n,
        topic:page.typed.topic,since:page.typed.since,
        last:{timestamp:firstView.firstVisible,hash:c.contentHash(firstView.postFrame)}});
      const first=new Map(page.payload),terminal=new Map(page.payload);
      first.set(3n,18446744073709551615n);first.set(4n,[encoded[0]]);first.set(5n,cursor);first.delete(7n);
      terminal.set(3n,18446744073709551615n);terminal.set(4n,[encoded[1]]);terminal.delete(5n);terminal.set(7n,cursor);
      return {first:Array.from(c.encodeForumReadFrame(13,first)),terminal:Array.from(c.encodeForumReadFrame(13,terminal)),
        cursor:c.forumCursorToTransport(cursor),hashes:rows.map(view=>c.toHex(c.contentHash(view.typed.postFrame)))};
    })()`)
    pagingFixture.since = query.get('since')
    await fulfill(event, pagingFixture.first)
  }
  const beforePaging = await evaluate(`JSON.stringify(${forumState}.messages)`)
  await evaluate(
    `(()=>{window.__pagedRefresh=${refresh}.then(()=>true);return true})()`,
  )
  for (let n = 0; !continuation && n < 200; n++)
    await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(
    continuation,
    'actual client traverses first page into held continuation',
  )
  assert.equal(
    await evaluate(`JSON.stringify(${forumState}.messages)`),
    beforePaging,
    'first-page prefix never publishes',
  )
  assert.equal(
    await evaluate(`${forumState}.isRefreshing`),
    true,
    'continuation keeps query loading',
  )
  await fulfill(continuation, pagingFixture.terminal)
  await evaluate(`window.__pagedRefresh`)
  for (const hash of pagingFixture.hashes) {
    assert.equal(
      await evaluate(
        `${forumState}.index[${JSON.stringify(hash)}].voteWeightWei`,
      ),
      '7',
      'all terminal snapshot observations publish together',
    )
    assert.equal(
      await evaluate(`${forumState}.index[${JSON.stringify(hash)}].revision`),
      '18446744073709551615',
    )
  }
  assert.equal(
    await evaluate(
      `${forumState}.messages.filter(row=>row.topic==='news').length`,
    ),
    2,
    'complete query replaces prior retained rows',
  )
  assert.equal(await evaluate(`${forumState}.isRefreshing`), false)
  assert.ok(
    await evaluate(
      `Array.from(document.querySelectorAll('a.post-title')).some(e=>e.textContent===${JSON.stringify(
        title,
      )}&&e.getClientRects().length>0)`,
    ),
    'complete multipage snapshot is rendered',
  )
  // Feed the actual discovery consumer an exact maximum-u64 count.
  await call('Fetch.disable')
  interceptResponse = async event => {
    const { body, base64Encoded } = await call('Fetch.getResponseBody', {
      requestId: event.params.requestId,
    })
    const raw = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body)
    const encoded = await evaluate(`(async()=>{
      const c=await import('/@fs'+${JSON.stringify(codecPath)});
      const page=c.validateFrame(new Uint8Array(${JSON.stringify([
        ...raw,
      ])}),c.defaultContext());
      if(page.kind!=='parsed'||page.typeId!==14||page.typed.nextCursor)throw Error('discovery fixture requires complete type14');
      const entries=page.payload.get(2n);
      const news=entries.find(entry=>entry.get(0n)==='news');
      if(!news)throw Error('normal discovery omitted signed news posts');
      news.set(1n,18446744073709551615n);
      page.payload.set(1n,18446744073709551615n);
      return Array.from(c.encodeForumReadFrame(14,page.payload));
    })()`)
    await fulfill(event, encoded)
  }
  await call('Fetch.enable', {
    patterns: [
      {
        urlPattern: '*/message/monad/topics/discover*',
        requestStage: 'Response',
      },
    ],
  })
  await evaluate(`(async()=>{
    const m=await import('/src/stores/topics.ts');
    const pinia=document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia;
    const result=await m.useTopicStore(pinia).refreshDiscoveredTopics();
    if(result===false)throw Error('complete discovery fixture was not published');
  })()`)
  await until(
    `document.querySelector('[data-test="forum-topic-count"][data-topic="news"]')?.textContent.trim()==='18446744073709551615'`,
  )
  assert.equal(
    await evaluate(
      `document.querySelector('[data-test="forum-topic-count"][data-topic="news"]').textContent.trim()`,
    ),
    '18446744073709551615',
    'maximum u64 discovery count is rendered exactly',
  )
  assert.ok(
    await evaluate(
      `document.querySelector('[data-test="forum-topic-count"][data-topic="news"]').getClientRects().length>0`,
    ),
    'exact count is visible in the actual drawer',
  )
  const discovered = await evaluate(`(() => {
    const topics=document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia.state.value.topics;
    return JSON.parse(JSON.stringify(topics.discoveredTopics.news));
  })()`)
  assert.equal(discovered.postCount, '18446744073709551615')
  assert.equal(discovered.revision, '18446744073709551615')
  await call('Fetch.disable')
  // A genuine unknown-length HTTP stream exercises the browser reader before buffering.
  // No CDP response-body retrieval/fulfillment or capture clone touches this response.
  const stream = {
    bytes: 0,
    requests: 0,
    aborted: false,
    finished: false,
    headers: undefined,
  }
  const limit = 4 * 1024 * 1024,
    planned = 8 * 1024 * 1024
  streamServer = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('access-control-allow-headers', 'accept,content-type')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    stream.requests++
    stream.headers = request.headers
    response.writeHead(200, { 'content-type': 'application/cbor' })
    response.flushHeaders()
    const prefix = Buffer.from(pagingFixture.first)
    response.write(prefix)
    stream.bytes += prefix.length
    const chunk = Buffer.alloc(64 * 1024, 0xaa)
    const timer = setInterval(() => {
      if (response.destroyed) {
        clearInterval(timer)
        return
      }
      if (stream.bytes >= planned) {
        clearInterval(timer)
        stream.finished = true
        response.end()
        return
      }
      stream.bytes += chunk.length
      response.write(chunk)
    }, 10)
    response.on('close', () => {
      clearInterval(timer)
      stream.aborted = !response.writableFinished
    })
  })
  await new Promise((resolve, reject) => {
    streamServer.once('error', reject)
    streamServer.listen(0, '127.0.0.1', resolve)
  })
  const streamOrigin = 'http://127.0.0.1:' + streamServer.address().port
  await evaluate(`window.__forumSkipResponseCapture=true`)
  interceptResponse = async event => {
    const url = new URL(event.params.request.url)
    if (
      url.searchParams.get('topic') !== 'news' ||
      url.origin === streamOrigin
    ) {
      await call('Fetch.continueRequest', { requestId: event.params.requestId })
      return
    }
    await call('Fetch.continueRequest', {
      requestId: event.params.requestId,
      url: streamOrigin + url.pathname + url.search,
    })
  }
  await call('Fetch.enable', {
    patterns: [
      { urlPattern: '*/message/monad/topics?*', requestStage: 'Request' },
    ],
  })
  const beforeOversize = await evaluate(
    `JSON.stringify(${forumState}.messages.filter(row=>row.topic==='news'))`,
  )
  const error = await evaluate(`${refresh}.then(()=>null,error=>error.message)`)
  assert.equal(
    error,
    'Forum response byte limit',
    'unknown-length body is rejected at the streaming bound',
  )
  const streamWire = await evaluate(
    `window.__forumWire.filter(row=>row.method==='GET'&&row.url.includes('topic=news')).at(-1)`,
  )
  assert.equal(
    streamWire.contentLength,
    null,
    'actual browser received no declared Content-Length',
  )
  assert.equal(
    streamWire.captureResponse,
    false,
    'wire recorder did not clone or prebuffer the stream',
  )
  assert.equal(
    streamWire.response,
    undefined,
    'fixture bytes were consumed only by the bounded production reader',
  )
  for (let n = 0; !stream.aborted && n < 100; n++)
    await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(
    stream.requests,
    1,
    'oversize is permanent and cannot start a fresh retry',
  )
  assert.equal(stream.headers.accept, 'application/cbor')
  assert.equal(
    stream.headers.authorization,
    undefined,
    'browser public GET is anonymous',
  )
  assert.equal(
    stream.headers.cookie,
    undefined,
    'browser public GET sends no credentials',
  )
  assert.equal(
    stream.aborted,
    true,
    'bounded reader cancels the actual HTTP stream',
  )
  assert.equal(
    stream.finished,
    false,
    'browser aborts before the full planned body is sent',
  )
  assert.ok(
    stream.bytes > limit && stream.bytes < planned,
    'abort occurs after crossing the bound and before full buffering',
  )
  assert.equal(
    await evaluate(
      `JSON.stringify(${forumState}.messages.filter(row=>row.topic==='news'))`,
    ),
    beforeOversize,
    'oversized stream cannot publish a prefix',
  )
  assert.equal(
    await evaluate(`${forumState}.isRefreshing`),
    false,
    'failed current stream clears its loading state',
  )
  await call('Fetch.disable')
  assert.ok(
    await evaluate(
      `JSON.stringify(${forumState}).includes(${JSON.stringify(digest)})`,
    ),
  )
  assert.equal(
    allEvents.some(e => e.method === 'Runtime.exceptionThrown'),
    false,
  )
  console.log(
    'Rendered CreatePost → list → single → reply → up/down → status; canonical bytes/media; exact drawer threshold/count; wide signed and zero observations; FIFO generations; held multipage atomic publication; unknown-length streaming abort:',
    audit,
  )
} finally {
  await stop()
  if (streamServer) {
    const closed = new Promise(resolve => streamServer.close(resolve))
    streamServer.closeAllConnections()
    await closed
  }
  await rm(directory, { recursive: true, force: true })
}
