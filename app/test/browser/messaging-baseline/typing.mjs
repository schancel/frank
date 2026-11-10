import assert from 'node:assert/strict'

const TEXT =
  'Typing into the real composer stays smooth with pictures attached. '
const SAMPLE_COUNT = 60

function distribution(values) {
  assert.ok(values.length > 0, 'Measurement needs samples')
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1]
  return {
    count: values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1),
  }
}

/** Actual Chat/ChatInput and draft persistence; no send, signing or service substitution. */
export async function runTyping({ evaluate, call, until, report }) {
  report.typing = {
    viewport: { width: 400, height: 600 },
    samplesPerCase: SAMPLE_COUNT,
    cases: [],
    limitations: [
      'Beforeinput capture to next animation frame is a paint proxy, excluding CDP transport and browser work before beforeinput',
      'One sequential sample per frame; not a saturated event queue or native extension host',
      'setItem timing excludes JSON serialization; input-to-frame includes the whole application update',
      'Write bytes mean UTF-16 value bytes, excluding key and browser-specific storage overhead',
      'No latency threshold or speedup claim; compare repeated quiet-host runs with matching fixture hashes',
    ],
  }
  const settle = () =>
    evaluate(
      'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
    )
  const clearText = async () => {
    await evaluate(
      `(()=>{const el=document.querySelector('.chat-footer textarea');el.focus();el.select()})()`,
    )
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    })
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    })
    await settle()
    assert.equal(
      await evaluate("document.querySelector('.chat-footer textarea').value"),
      '',
    )
  }

  await evaluate(`(()=>{
    const key='frank:draft:chat:'+window.__messagingBaseline.conversation.toLowerCase();
    const original=Storage.prototype.setItem;
    const state=window.__typing={key,active:false,frames:[],writes:[],lastFrame:null,pendingStart:null};
    const wrapped=function(k,v){
      if(!state.active||this!==window.localStorage||k!==key)return original.call(this,k,v);
      const start=performance.now();
      try{return original.call(this,k,v)}finally{state.writes.push({start,durationMs:performance.now()-start,utf16ValueBytes:v.length*2})}
    };
    Storage.prototype.setItem=wrapped;
    const onBeforeInput=e=>{
      if(state.active&&e.target.matches('.chat-footer textarea'))state.pendingStart=performance.now();
    };
    const onInput=e=>{
      if(!state.active||!e.target.matches('.chat-footer textarea'))return;
      const start=state.pendingStart;state.pendingStart=null;
      if(start===null)throw Error('Measured input lacked beforeinput');
      state.lastFrame=new Promise(resolve=>requestAnimationFrame(()=>{
        state.frames.push({start,durationMs:performance.now()-start});resolve();
      }));
    };
    document.addEventListener('beforeinput',onBeforeInput,true);
    document.addEventListener('input',onInput,true);
    state.restore=()=>{state.active=false;document.removeEventListener('beforeinput',onBeforeInput,true);document.removeEventListener('input',onInput,true);if(Storage.prototype.setItem===wrapped)Storage.prototype.setItem=original};
  })()`)

  try {
    for (const attachmentCount of [0, 3]) {
      if (attachmentCount) {
        // Deterministic photographic-size noise, processed by the normal image preparer.
        // Generation, compression, attachment persistence and thumbnail layout are outside timing.
        await evaluate(`(async()=>{
          const canvas=document.createElement('canvas');canvas.width=768;canvas.height=512;
          const ctx=canvas.getContext('2d');const pixels=ctx.createImageData(canvas.width,canvas.height);
          let seed=42;
          for(let i=0;i<pixels.data.length;i+=4){for(let c=0;c<3;c++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i+c]=seed>>>24}pixels.data[i+3]=255}
          ctx.putImageData(pixels,0,0);
          const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',0.85));
          if(!blob)throw Error('Synthetic attachment creation failed');
          const transfer=new DataTransfer();
          for(let i=0;i<3;i++)transfer.items.add(new File([blob],'synthetic-'+i+'.jpg',{type:'image/jpeg'}));
          const picker=document.querySelector('[data-testid="chat-attachment-picker"]');
          picker.files=transfer.files;picker.dispatchEvent(new Event('change',{bubbles:true}));
        })()`)
        await until(
          `document.querySelectorAll('[data-testid="chat-attachment-chip"]').length===3 && JSON.parse(localStorage.getItem(window.__typing.key)||'{}').attachments?.length===3`,
        )
        assert.equal(
          await evaluate(
            '!!document.querySelector(\'[data-testid="chat-attachment-refused"]\')',
          ),
          false,
        )
      }
      await clearText()
      const draftBefore = await evaluate(`(()=>{
        const raw=localStorage.getItem(window.__typing.key);const draft=JSON.parse(raw||'{}');
        return {attachmentCount:draft.attachments?.length||0,attachmentDataUrlCharacters:(draft.attachments||[]).reduce((n,a)=>n+a.dataUrl.length,0)};
      })()`)
      assert.equal(draftBefore.attachmentCount, attachmentCount)
      if (attachmentCount)
        assert.ok(
          draftBefore.attachmentDataUrlCharacters > 60_000,
          'Representative attachments must carry substantial encoded bytes',
        )

      // Warm both native input and application code without counting those first inputs.
      for (const text of 'warmup') await call('Input.insertText', { text })
      await clearText()
      await settle()
      await evaluate(
        `(()=>{const s=window.__typing;s.frames=[];s.writes=[];s.pendingStart=null;s.lastFrame=null;s.start=performance.now();s.active=true})()`,
      )
      for (let index = 0; index < SAMPLE_COUNT; index++) {
        await call('Input.insertText', { text: TEXT[index % TEXT.length] })
        await evaluate(
          `(async()=>{const s=window.__typing;if(!s.lastFrame)throw Error('Trusted input did not reach actual composer');await s.lastFrame})()`,
        )
      }
      await evaluate(
        'window.__typing.end=performance.now();window.__typing.active=false',
      )
      // Let PerformanceObserver deliver entries, without widening the measured interval.
      await new Promise(resolve => setTimeout(resolve, 100))
      const observed = await evaluate(`(()=>{
        const s=window.__typing;const el=document.querySelector('.chat-footer textarea');
        const draft=JSON.parse(localStorage.getItem(s.key)||'{}');
        return {frames:s.frames,writes:s.writes,start:s.start,end:s.end,
          inputLength:el.value.length,inputMatchesExpected:el.value===${JSON.stringify(
            TEXT.slice(0, SAMPLE_COUNT),
          )},persistedMatchesInput:draft.message===el.value,
          attachmentCount:draft.attachments?.length||0,
          longtasks:window.__baselineMetrics.longtasks.filter(t=>t.start<s.end&&t.start+t.duration>s.start)};
      })()`)
      assert.equal(
        observed.frames.length,
        SAMPLE_COUNT,
        'Each character must produce one measured input',
      )
      assert.equal(
        observed.inputLength,
        SAMPLE_COUNT,
        'No characters lost or duplicated',
      )
      assert.ok(
        observed.inputMatchesExpected,
        'Typed text must match every requested character',
      )
      assert.ok(
        observed.persistedMatchesInput,
        'Production draft must contain the latest input',
      )
      assert.equal(observed.attachmentCount, attachmentCount)
      assert.ok(
        observed.writes.length > 0,
        'Real draft writes must reach the storage observer',
      )
      report.typing.cases.push({
        name: attachmentCount ? 'three-images' : 'text-only',
        ...draftBefore,
        inputToNextFrame: distribution(
          observed.frames.map(frame => frame.durationMs),
        ),
        draftSetItem: {
          ...distribution(observed.writes.map(write => write.durationMs)),
          totalMs: observed.writes.reduce(
            (sum, write) => sum + write.durationMs,
            0,
          ),
          totalUtf16ValueBytes: observed.writes.reduce(
            (sum, write) => sum + write.utf16ValueBytes,
            0,
          ),
        },
        frames: observed.frames,
        writes: observed.writes,
        longtasks: observed.longtasks,
        maxLongTaskMs: Math.max(
          0,
          ...observed.longtasks.map(task => task.duration),
        ),
        durationMs: observed.end - observed.start,
        persistedMatchesInput: observed.persistedMatchesInput,
      })
    }
    const serviceTexts = await evaluate(
      'window.__messagingBaseline.state.sends.map(s=>s.text)',
    )
    assert.ok(
      serviceTexts.every(text => !text.includes(TEXT.slice(0, SAMPLE_COUNT))),
      'Typing must not submit a message',
    )
  } finally {
    await evaluate('window.__typing?.restore()')
  }
}
