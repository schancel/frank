import assert from 'node:assert/strict'

/** Functional browser-page lifecycle; all extension APIs are deliberately simulated. */
export async function runPairing({ main, openPage, origin, report }) {
  const evidence = (report.pairing = {
    cases: [],
    targets: [],
    containment: [],
  })
  const events = page => page.evaluate('window.__pairingFixture.events')
  const navigate = (page, mode) =>
    page.call('Page.navigate', {
      url: origin + '/?extMode=' + mode + '#/account-sync/send',
    })
  const pin = page =>
    page.evaluate(
      'document.querySelector("[data-test=sync-sender-pin]")?.textContent.trim()',
    )
  const ready = page =>
    page.until(
      'window.__messagingBaseline?.state.ready && document.querySelector("[data-test=account-sync-send]")',
    )
  const count = (list, type) => list.filter(event => event.type === type).length
  const create = async (mode, sharedContext = false) => {
    const page = await openPage(mode, sharedContext)
    evidence.targets.push({
      targetId: page.targetId,
      mode,
      containedBeforeNavigation: true,
    })
    return page
  }
  const probe = async page => {
    const errorsBefore = report.consoleErrors.length
    const result = await page.evaluate(`(async()=>{
      const violations=[];document.addEventListener('securitypolicyviolation',e=>violations.push(e.blockedURI));
      let rejected=false;try{await fetch('https://offline-probe.invalid/pairing-target')}catch{rejected=true}
      await new Promise(resolve=>setTimeout(resolve,50));return {rejected,violations};
    })()`)
    assert.ok(
      result.rejected &&
        result.violations.some(url =>
          url.startsWith('https://offline-probe.invalid'),
        ),
    )
    evidence.containment.push({
      targetId: page.targetId,
      result,
      console: report.consoleErrors.splice(errorsBefore),
    })
  }
  const showAutomaticPin = async page => {
    await ready(page)
    await page.until(
      'document.querySelector("[data-test=sync-pin-loading]") && window.__pairingFixture.events.some(e=>e.type==="export")',
    )
    assert.equal(await pin(page), undefined)
    assert.equal(count(await events(page), 'offer'), 0)
    await page.evaluate('window.__pairingFixture.releaseExport()')
    await page.until('document.querySelector("[data-test=sync-sender-pin]")')
    const value = await pin(page)
    assert.match(value, /^\d{6}$/)
    const list = await events(page)
    assert.equal(count(list, 'export'), 1)
    assert.equal(count(list, 'offer'), 1)
    assert.deepEqual(
      list.find(event => event.type === 'export'),
      { type: 'export', threshold: 2, count: 3 },
    )
    assert.equal(
      await page.evaluate(
        '!!document.querySelector("[data-test=sync-show-pin]")',
      ),
      false,
    )
    return {
      value,
      offerId: list.find(event => event.type === 'offer').offerId,
    }
  }
  const leave = async page => {
    const id = await page.evaluate('window.__pairingFixture.activeOfferId')
    assert.ok(id)
    await page.evaluate(
      'document.querySelector("[data-test=sync-back]").click()',
    )
    await page.until(
      'location.hash.includes("/profile") && !document.querySelector("[data-test=account-sync-send]")',
    )
    const list = await events(page)
    assert.deepEqual(
      list.filter(event => event.type === 'cancel'),
      [{ type: 'cancel', offerId: id }],
    )
    assert.equal(
      await page.evaluate('window.__pairingFixture.activeOfferId'),
      null,
    )
  }
  evidence.targets.push({
    targetId: main.targetId,
    mode: 'tab',
    containedBeforeNavigation: true,
  })
  await navigate(main, 'tab')
  const initial = await showAutomaticPin(main)
  // Activate a separate owned receiver-like page, without importing an account or calling pairing crypto.
  const web = await create('web')
  await navigate(web, 'tab')
  await ready(web)
  await web.until('document.querySelector("[data-test=sync-sender-error]")')
  assert.equal(count(await events(web), 'export'), 0)
  assert.equal(count(await events(web), 'offer'), 0)
  await probe(web)
  evidence.cases.push({
    name: 'loopback-web-origin-rejected-before-export',
    events: await events(web),
  })
  await main.call('Target.closeTarget', { targetId: web.targetId })
  // Same browser context gives real tab focus transitions. This target has no application
  // session, avoiding an unrelated multi-tab custody election in the simulated host.
  const receiver = await create('web', true)
  await receiver.call('Page.navigate', {
    url: origin + '/fixture/pairing-focus',
  })
  await receiver.until('document.querySelector("input")')
  await probe(receiver)
  await main.evaluate(
    'window.__pairingFocus=[];addEventListener("focus",()=>window.__pairingFocus.push("focus"));addEventListener("blur",()=>window.__pairingFocus.push("blur"))',
  )
  await main.call('Page.bringToFront')
  await main.until('document.hasFocus()')
  await receiver.call('Page.bringToFront')
  await main.until('!document.hasFocus()')
  await main.call('Page.bringToFront')
  await main.until('document.hasFocus()')
  assert.equal(await pin(main), initial.value)
  assert.equal(
    await main.evaluate('window.__pairingFixture.activeOfferId'),
    initial.offerId,
  )
  assert.equal(count(await events(main), 'export'), 1)
  assert.equal(count(await events(main), 'cancel'), 0)
  evidence.cases.push({
    name: 'automatic-pin-focus-survival',
    offerId: initial.offerId,
    focus: await main.evaluate('window.__pairingFocus'),
  })
  await probe(main)
  await leave(main)
  evidence.cases.push({
    name: 'route-departure-cancels-original',
    events: await events(main),
  })

  for (const failFirst of [false, true]) {
    const popup = await create('popup')
    await navigate(popup, 'popup')
    await ready(popup)
    await popup.until(
      'window.__pairingFixture.events.some(e=>e.type==="tab-request")',
    )
    assert.equal(count(await events(popup), 'export'), 0)
    assert.equal(count(await events(popup), 'offer'), 0)
    if (failFirst) {
      await popup.evaluate(
        'window.__pairingFixture.acknowledgePromotion(false)',
      )
      await popup.until(
        'document.querySelector("[role=alert]") && document.querySelector("[data-test=sync-promotion-retry]")',
      )
      assert.equal(count(await events(popup), 'export'), 0)
      await popup.evaluate(
        'document.querySelector("[data-test=sync-promotion-retry]").click()',
      )
      await popup.until(
        'window.__pairingFixture.events.filter(e=>e.type==="tab-request").length===2',
      )
    }
    const requested = (await events(popup))
      .filter(event => event.type === 'tab-request')
      .at(-1)
    assert.equal(requested.path, 'index.html?extMode=tab#/account-sync/send')
    const persistent = await create('tab') // fully attached/contained before simulated tabs.create resolves
    await popup.evaluate('window.__pairingFixture.acknowledgePromotion(true)')
    await popup.until(
      'window.__pairingFixture.events.some(e=>e.type==="close-request")',
    )
    const popupEvents = await events(popup)
    assert.equal(count(popupEvents, 'export'), 0)
    assert.equal(count(popupEvents, 'offer'), 0)
    assert.ok(
      popupEvents.findIndex(event => event.type === 'tab-ack') <
        popupEvents.findIndex(event => event.type === 'close-request'),
    )
    await probe(popup)
    await navigate(persistent, 'tab')
    const original = await showAutomaticPin(persistent)
    await main.call('Target.closeTarget', { targetId: popup.targetId })
    await persistent.call('Page.bringToFront')
    await persistent.until('document.hasFocus()')
    assert.equal(await pin(persistent), original.value)
    assert.equal(
      await persistent.evaluate('window.__pairingFixture.activeOfferId'),
      original.offerId,
    )
    assert.equal(count(await events(persistent), 'cancel'), 0)
    await probe(persistent)
    await leave(persistent)
    evidence.cases.push({
      name: failFirst ? 'promotion-failure-retry' : 'popup-promotion',
      popupEvents,
      persistentEvents: await events(persistent),
      popupClosedByRunner: true,
    })
    await main.call('Target.closeTarget', { targetId: persistent.targetId })
  }
  await main.call('Target.closeTarget', { targetId: receiver.targetId })
  await main.call('Page.bringToFront')
}
