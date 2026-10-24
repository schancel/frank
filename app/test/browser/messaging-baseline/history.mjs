import assert from 'node:assert/strict'

/** Real browser geometry only: no component methods, scroll assignments or policy overrides. */
export async function runHistory({ evaluate, call, report }) {
  const failures = []
  const check = (condition, message) => {
    if (!condition) failures.push(message)
  }
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 150))
    await evaluate(
      'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
    )
  }
  await evaluate('document.activeElement?.blur()')
  const snapshot = () =>
    evaluate(`(()=>{
    const list=document.querySelector('.chat-message-list');
    const target=list.closest('.q-scrollarea__container');
    if(!target)throw Error('Real Quasar scroll target missing');
    const bounds=target.getBoundingClientRect();
    const rows=[...list.querySelectorAll('[data-testid="chat-message-body"]')].map(el=>{
      const rect=el.getBoundingClientRect();return {text:el.textContent.trim(),y:rect.top-bounds.top,height:rect.height};
    });
    const button=document.querySelector('button[aria-label="Scroll to latest messages"]');
    return {top:target.scrollTop,height:target.scrollHeight,viewport:target.clientHeight,x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,rows,jumpVisible:!!button&&!!button.getClientRects().length&&getComputedStyle(button.parentElement).display!=='none'};
  })()`)
  const wheel = async (state, deltaY) => {
    await call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: state.x,
      y: state.y,
      deltaX: 0,
      deltaY,
    })
    await settle()
    return snapshot()
  }
  let state = await snapshot()
  report.history = { initial: state, expansions: [], incoming: [], failures }
  assert.ok(
    state.height > state.viewport + 100,
    'Seeded real chat must overflow',
  )
  assert.equal(
    state.rows.length,
    30,
    'Initial render window must contain 30 seeded rows',
  )
  const beforeUp = state
  state = await wheel(state, -250)
  report.history.afterUp = state
  check(state.top < beforeUp.top - 100, 'Upward wheel did not move history')
  check(state.jumpVisible, 'Jump-to-latest must be visible while up')

  // Test incoming delivery through the real public receive path while reading history.
  const receive = async (text, index) => {
    const before = await snapshot()
    const anchor = before.rows.find(
      row => row.y >= 0 && row.y < before.viewport,
    )
    assert.ok(anchor, 'Visible anchor required before incoming message')
    await evaluate(
      `window.__messagingBaseline.receiveHistory(${JSON.stringify(
        text,
      )},${index})`,
    )
    await settle()
    const after = await snapshot()
    const same = after.rows.find(row => row.text === anchor.text)
    const stored = await evaluate(
      `window.__messagingBaseline.messageState(${JSON.stringify(text)})`,
    )
    report.history.incoming.push({
      text,
      before,
      after,
      anchor,
      stored,
      delta: same ? same.y - anchor.y : null,
    })
    check(
      !!stored && stored.status === 'confirmed',
      'Incoming row did not complete real store delivery',
    )
    check(
      !!same && Math.abs(same.y - anchor.y) <= 2,
      `Incoming ${index} moved reading anchor`,
    )
    check(after.jumpVisible, `Incoming ${index} lost jump-to-latest affordance`)
    return after
  }
  state = await receive('Incoming while reading history', 2001)

  // Expand the existing render window at the top, preserving an old row's visual position.
  for (
    let expansion = 0;
    expansion < 4 && state.rows.length < 120;
    expansion++
  ) {
    for (let steps = 0; state.top > 20 && steps < 100; steps++)
      state = await wheel(state, -Math.min(400, state.top - 20))
    const before = state
    const anchor = before.rows.find(
      row => row.y >= 0 && row.y < before.viewport,
    )
    assert.ok(anchor, 'Visible anchor required before render-window expansion')
    state = await wheel(state, -before.top)
    const same = state.rows.find(row => row.text === anchor.text)
    const expected = anchor.y + before.top
    report.history.expansions.push({
      before,
      after: state,
      anchor,
      expected,
      delta: same ? same.y - expected : null,
    })
    check(
      state.rows.length > before.rows.length,
      'Top wheel did not expand render window',
    )
    check(
      !!same && Math.abs(same.y - expected) <= 2,
      'Render-window expansion moved the existing anchor',
    )
  }
  // Expand final incoming row too, then explicitly reach zero with wheel input.
  for (let steps = 0; state.top > 0 && steps < 100; steps++)
    state = await wheel(state, -Math.min(600, state.top))
  check(state.top <= 1, 'Could not reach oldest history at scrollTop zero')
  state = await receive('Incoming at oldest history', 2002)
  await evaluate(
    "(()=>{const button=document.querySelector('button[aria-label=\"Scroll to latest messages\"]');if(!button)throw Error('Jump button missing');button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))})()",
  )
  await settle()
  state = await snapshot()
  report.history.latest = state
  check(
    state.height - state.viewport - state.top <= 10,
    'Explicit jump did not reach bottom',
  )
  check(
    state.rows.some(
      row =>
        row.text.includes('Incoming at oldest history') &&
        row.y < state.viewport &&
        row.y + row.height > 0,
    ),
    'Latest received text is not visible after explicit jump',
  )
}
