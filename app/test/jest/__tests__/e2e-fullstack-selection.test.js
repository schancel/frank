/** @jest-environment jsdom */
/* eslint-env node, jest */
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const ts = require('typescript')

const runnerSource = readFileSync(
  resolve(__dirname, '../../autonomous-fullstack-e2e.mjs'),
  'utf8',
)
const helperSource = readFileSync(
  resolve(__dirname, '../../e2e-profile.mjs'),
  'utf8',
)
const identity = '0x' + '1'.repeat(40)
const receive = '0x' + '2'.repeat(40)

function loadRunner() {
  const forbidden = jest.fn(() => {
    throw new Error('Financial capability forbidden in nonfinancial journey')
  })
  const spawn = jest.fn(() => {
    throw new Error('No actual browser permitted in regression')
  })
  const fs = {
    mkdir: jest.fn(async () => {}),
    writeFile: forbidden,
    readdir: jest.fn(async () => ['relay.log']),
    stat: jest.fn(async () => ({ size: 0 })),
  }
  const process = {
    env: {
      ACCOUNT_APP_ORIGIN: 'https://signet.mx',
      E2E_BROWSER_RESOLVER_RULES:
        'MAP signet.mx 127.0.0.1, MAP relay.signet.mx 127.0.0.1',
      E2E_PROFILE_DIR: '/owned/profile',
      E2E_BACKEND_LOGS_DIR: '/owned/logs',
    },
    argv: ['node'],
    once: jest.fn(),
    exit: jest.fn(),
  }
  for (const name of [
    'FRANK_TEST_WALLET_JSON',
    'FRANK_DEMO_ENV_FILE',
    'E2E_FUND_MON',
  ])
    Object.defineProperty(process.env, name, { get: forbidden })
  const console = { log: jest.fn(), error: jest.fn(), warn: jest.fn() }
  const clock = { now: 0 }
  class ClockDate extends Date {
    static now() {
      return clock.now
    }
  }
  const delay = (callback, ms) => {
    clock.now += ms
    callback()
    return 0
  }
  function compile(source, imports) {
    // CommonJS adaptation only: importing the CLI must not start its entrypoint.
    const body = ts.transpileModule(
      source.replaceAll('import.meta.url', "'file:///isolated-runner.mjs'"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      },
    ).outputText
    const exports = {}
    new Function(
      'require',
      'exports',
      'process',
      'console',
      'Buffer',
      'URL',
      'Date',
      'setTimeout',
      body,
    )(
      name =>
        Object.prototype.hasOwnProperty.call(imports, name)
          ? imports[name]
          : require(name),
      exports,
      process,
      console,
      Buffer,
      require('node:url').URL,
      ClockDate,
      delay,
    )
    return exports
  }
  const helper = compile(helperSource, {
    'node:child_process': { execFile: forbidden },
    'node:fs/promises': {
      open: forbidden,
      lstat: forbidden,
      mkdir: forbidden,
      realpath: forbidden,
      rename: forbidden,
      writeFile: forbidden,
    },
    'ethers': {
      FetchRequest: class {
        constructor() {
          forbidden()
        }
      },
      JsonRpcProvider: class {
        constructor() {
          forbidden()
        }
      },
    },
  })
  const profile = {
    fresh: false,
    directory: '/owned/profile',
    account: { profile: identity, receive },
    recordAccount: jest.fn(async () => {}),
  }
  const persistentProfile = jest.fn(async () => profile)
  const importedHelper = { ...helper, persistentProfile }
  Object.defineProperty(importedHelper, 'testFunds', { get: forbidden })
  const runner = compile(runnerSource, {
    './e2e-profile.mjs': importedHelper,
    'node:child_process': { spawn },
    'node:fs/promises': fs,
  })
  return {
    runner,
    helper,
    forbidden,
    spawn,
    fs,
    process,
    console,
    profile,
    persistentProfile,
    clock,
  }
}

function domDriver({
  controlled = true,
  unknown = false,
  pending = false,
  breakOffline = false,
  stuckOffline = false,
  changeOnRestart = false,
  neverCommit = false,
  commitAfterPolls = 2,
} = {}) {
  const location = { hash: '#/wallet/monad' }
  const navigator = {
    onLine: true,
    serviceWorker: { controller: controlled ? {} : null },
  }
  let previous = location.hash
  let restarted = false
  let afterRestart = false
  let loaderId = 'initial-document'
  let documentNumber = 0
  let navigation
  const stats = {
    staleDomReads: 0,
    committedDocuments: 0,
    delayedFramePolls: 0,
  }
  function render() {
    const currentIdentity =
      restarted && changeOnRestart ? '0x' + '9'.repeat(40) : identity
    document.body.innerHTML = `<div data-test="identity-address-input"><input value="${currentIdentity}"></div>
      <div class="q-field"><input value="${receive}"><button data-testid="wallet-copy-address"></button></div>
      <div data-testid="wallet-balance" title="${unknown ? '' : '0 MONT'}">${
      unknown ? 'Unknown' : '0'
    }</div>
      <div data-testid="wallet-available"><span title="${
        unknown ? '' : '0 MONT'
      }"></span></div>
      <div data-testid="wallet-activity-empty"></div><div data-testid="contacts-page"></div>
      ${pending ? '<div data-testid="wallet-pending-operations"></div>' : ''}`
  }
  render()
  const history = {
    back: () => {
      location.hash = previous
    },
  }
  const page = {
    evaluate: jest.fn(async expression => {
      if (navigation) stats.staleDomReads++
      const before = location.hash
      const value = new Function(
        'document',
        'location',
        'navigator',
        'history',
        `return (${expression})`,
      )(document, location, navigator, history)
      if (location.hash !== before && expression !== 'history.back()')
        previous = before
      return value
    }),
    until: jest.fn(async (expression, timeout, label) => {
      if (
        breakOffline &&
        !navigator.onLine &&
        label === 'public identity ready'
      )
        throw new Error('offline fixture failed')
      if (!(await page.evaluate(expression))) throw new Error('not ready')
    }),
    call: jest.fn(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        if (navigation) {
          stats.delayedFramePolls++
          if (!neverCommit && --navigation.polls <= 0) {
            loaderId = 'committed-document-' + ++documentNumber
            if (navigation.hash) location.hash = navigation.hash
            navigation = undefined
            stats.committedDocuments++
            render()
          }
        }
        return { frameTree: { frame: { id: 'main-frame', loaderId } } }
      }
      if (method === 'Page.reload') {
        // Acknowledge immediately; deliberately retain the old DOM until later frame polls.
        navigation = { polls: commitAfterPolls }
        return {}
      }
      if (method === 'Network.emulateNetworkConditions')
        navigator.onLine = !params.offline && !stuckOffline
      else if (method === 'Page.navigate') {
        if (afterRestart) {
          navigation = {
            polls: commitAfterPolls,
            hash: new URL(params.url).hash,
          }
          afterRestart = false
          return {}
        }
        location.hash = new URL(params.url).hash
      } else throw new Error('Unexpected CDP method')
      render()
    }),
  }
  const restart = jest.fn(async () => {
    restarted = true
    afterRestart = true
    loaderId = 'restart-blank-document'
    location.hash = ''
    render()
  })
  return { page, restart, navigator, stats }
}

async function selectedNonfinancial(f, driver, results = []) {
  const screenshot = jest.fn(async () => {})
  const operations = {
    start: jest.fn(async () => {}),
    onboard: jest.fn(() =>
      f.runner.onboard({
        profile: f.profile,
        directory: f.profile.directory,
        origin: 'https://signet.mx',
        page: driver.page,
        results,
        captureScreenshot: screenshot,
      }),
    ),
    inspect: () =>
      f.runner.runNonfinancialJourney({
        page: driver.page,
        profile: f.profile,
        results,
        captureScreenshot: screenshot,
        restart: driver.restart,
        origin: 'https://signet.mx',
      }),
  }
  for (const name of ['createFunds', 'financial'])
    Object.defineProperty(operations, name, { get: f.forbidden })
  try {
    await f.runner.executeSelectedScenario('nonfinancial', operations)
  } finally {
    await f.runner.finishSelectedScenario('nonfinancial', f.forbidden)
  }
  return { results, screenshot, operations }
}

test('import has no profile, filesystem, browser or financial side effects', () => {
  const f = loadRunner()
  expect(f.persistentProfile).not.toHaveBeenCalled()
  expect(f.fs.mkdir).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
  expect(f.forbidden).not.toHaveBeenCalled()
})

function directOnboardingPage({
  pending = false,
  missingIdentity = false,
} = {}) {
  const location = { hash: '#/setup' }
  const steps = []
  let submitted = false
  const page = {
    evaluate: jest.fn(async expression =>
      new Function('document', 'location', `return (${expression})`)(
        document,
        location,
      ),
    ),
    call: jest.fn(async (method, params) => {
      expect(method).toBe('Page.navigate')
      location.hash = new URL(params.url).hash
      document.body.innerHTML =
        '<button data-test="new-account">New account</button>'
    }),
    click: jest.fn(async selector => {
      const button = document.querySelector(selector)
      if (!button || button.disabled) throw new Error('Control unavailable')
      steps.push(selector)
      if (selector === '[data-test="new-account"]') {
        document.body.innerHTML = `<input data-test="display-name"><button data-test="generate-backups">Create account</button>`
      } else if (selector === '[data-test="generate-backups"]') {
        expect(document.querySelector('[data-test="display-name"]').value).toBe(
          'Autonomous Tester',
        )
        if (submitted) throw new Error('Creation submitted twice')
        submitted = true
        button.disabled = true
      } else throw new Error('Unexpected click')
    }),
    typeInput: jest.fn(async (selector, value) => {
      const input = document.querySelector(selector)
      if (!input) throw new Error('Input unavailable')
      input.value = value
    }),
    until: jest.fn(async (expression, _timeout, label) => {
      if (submitted && label === 'navigated away from setup' && !pending) {
        // Account creation acknowledges first; activation completes asynchronously.
        await Promise.resolve()
        location.hash = '#/wallet/monad'
        document.body.innerHTML = `<div data-test="identity-address-input"><input value="${
          missingIdentity ? '' : identity
        }"></div>
          <div class="q-field"><input value="${receive}"><button data-testid="wallet-copy-address"></button></div>`
      }
      if (!(await page.evaluate(expression)))
        throw new Error('Not ready: ' + label)
    }),
  }
  return { page, steps }
}

test('fresh onboarding uses the current direct form once and records public identity after activation', async () => {
  const f = loadRunner()
  f.profile.account = null
  const driver = directOnboardingPage()
  const results = []
  const captureScreenshot = jest.fn(async () => {})
  await f.runner.onboard({
    profile: f.profile,
    directory: f.profile.directory,
    origin: 'https://signet.mx',
    page: driver.page,
    results,
    captureScreenshot,
  })
  expect(driver.steps).toEqual([
    '[data-test="new-account"]',
    '[data-test="generate-backups"]',
  ])
  expect(f.profile.recordAccount).toHaveBeenCalledWith({
    profile: identity,
    receive,
  })
  expect(results.find(row => row[0] === '1 onboarding')?.[1]).toBe('PASS')
  expect(captureScreenshot).toHaveBeenCalledTimes(1)
  expect(f.forbidden).not.toHaveBeenCalled()
})

test.each([
  [{ pending: true }, 'navigated away from setup'],
  [{ missingIdentity: true }, 'public identity ready'],
])(
  'unfinished direct creation never reports onboarding success or retries creation: %j',
  async (options, failure) => {
    const f = loadRunner()
    f.profile.account = null
    const driver = directOnboardingPage(options)
    const results = []
    await expect(
      f.runner.onboard({
        profile: f.profile,
        directory: f.profile.directory,
        origin: 'https://signet.mx',
        page: driver.page,
        results,
        captureScreenshot: jest.fn(async () => {}),
      }),
    ).rejects.toThrow(failure)
    expect(
      driver.steps.filter(step => step === '[data-test="generate-backups"]'),
    ).toHaveLength(1)
    expect(
      results.some(row => row[0] === '1 onboarding' && row[1] === 'PASS'),
    ).toBe(false)
    expect(f.profile.recordAccount).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  },
)

test.each([
  ['--scenario=payments'],
  ['--scenario=nonfinancial', '--scenario=full'],
  ['--unknown'],
  ['--scenario='],
])(
  'unsupported CLI selection fails before profile/browser work: %j',
  async (...args) => {
    const f = loadRunner()
    await expect(f.runner.main(args)).rejects.toThrow('Supported scenarios')
    expect(f.persistentProfile).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  },
)

test('default full selection preserves financial construction, onboarding and cleanup ordering', async () => {
  const { runner } = loadRunner()
  expect(runner.selectScenario()).toBe('full')
  const trace = []
  const funds = {}
  try {
    await runner.executeSelectedScenario(
      runner.selectScenario(['--scenario=full']),
      {
        createFunds: () => {
          trace.push('construct')
          return funds
        },
        start: async () => {
          trace.push('start')
        },
        onboard: async () => {
          trace.push('onboard')
        },
        financial: async received => {
          expect(received).toBe(funds)
          trace.push('financial')
        },
        inspect: () => {
          throw new Error('Wrong selected path')
        },
      },
    )
    trace.push('audit')
  } finally {
    await runner.finishSelectedScenario('full', async () => {
      trace.push('finish')
    })
  }
  expect(trace).toEqual([
    'construct',
    'start',
    'onboard',
    'financial',
    'audit',
    'finish',
  ])
})

test.each(['start', 'onboard', 'inspect'])(
  'nonfinancial %s failure never enters financial failure cleanup',
  async stage => {
    const f = loadRunner()
    const operations = {
      start: async () => {},
      onboard: async () => {},
      inspect: async () => {},
    }
    operations[stage] = async () => {
      throw new Error('Selected-stage failure')
    }
    for (const name of ['createFunds', 'financial'])
      Object.defineProperty(operations, name, { get: f.forbidden })
    try {
      await expect(
        f.runner.executeSelectedScenario('nonfinancial', operations),
      ).rejects.toThrow('Selected-stage failure')
    } finally {
      await f.runner.finishSelectedScenario('nonfinancial', f.forbidden)
    }
    expect(f.forbidden).not.toHaveBeenCalled()
  },
)

test('selected nonfinancial execution drives actual DOM checks/reload/offline/restart with financial traps', async () => {
  const f = loadRunner()
  const driver = domDriver()
  const { results, screenshot, operations } = await selectedNonfinancial(
    f,
    driver,
  )
  expect(operations.start).toHaveBeenCalledTimes(1)
  expect(operations.onboard).toHaveBeenCalledTimes(1)
  expect(results.find(row => row[0] === '1 onboarding')?.[1]).toBe(
    'NOT_RUN_REUSED',
  )
  expect(results.find(row => row[0] === 'wallet observation')).toEqual([
    'wallet observation',
    'PASS',
    'exact owned 0 MONT; available 0 MONT; no spending',
  ])
  for (const name of [
    'history',
    'navigation/back',
    'reload',
    'offline reload',
    'network restored',
    'browser restart',
  ])
    expect(results.find(row => row[0] === name)?.[1]).toBe('PASS')
  expect(
    results.find(row => row[0] === 'backend enrollment and sync')?.[1],
  ).toBe('UNVERIFIED')
  expect(
    driver.page.call.mock.calls.filter(([method]) => method === 'Page.reload'),
  ).toHaveLength(3)
  expect(driver.restart).toHaveBeenCalledTimes(1)
  expect(driver.stats.committedDocuments).toBe(4)
  expect(driver.stats.delayedFramePolls).toBeGreaterThanOrEqual(8)
  expect(driver.stats.staleDomReads).toBe(0)
  expect(driver.navigator.onLine).toBe(true)
  expect(screenshot).toHaveBeenCalledWith('nonfinancial_retained_wallet.png')
  expect(f.forbidden).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
})

test('acknowledged but never committed reload cannot pass using the still-readable old DOM', async () => {
  const f = loadRunner()
  const driver = domDriver({ neverCommit: true })
  const results = []
  await expect(selectedNonfinancial(f, driver, results)).rejects.toThrow(
    'New main document not observed',
  )
  expect(results.some(row => row[0] === 'reload' && row[1] === 'PASS')).toBe(
    false,
  )
  expect(driver.stats.committedDocuments).toBe(0)
  expect(driver.stats.staleDomReads).toBe(0)
  expect(driver.restart).not.toHaveBeenCalled()
  expect(f.clock.now).toBe(20000)
  expect(f.forbidden).not.toHaveBeenCalled()
})

test.each([{ unknown: true }, { pending: true }])(
  'unknown/pending wallet observations are blocked, never presented as zero proof: %j',
  async options => {
    const f = loadRunner()
    const { results } = await selectedNonfinancial(f, domDriver(options))
    expect(results.find(row => row[0] === 'wallet observation')?.[1]).toBe(
      'BLOCKED',
    )
    expect(f.forbidden).not.toHaveBeenCalled()
  },
)

test('uncontrolled PWA is explicitly blocked for offline proof without emulating an offline reload', async () => {
  const f = loadRunner()
  const driver = domDriver({ controlled: false })
  const { results } = await selectedNonfinancial(f, driver)
  expect(results.find(row => row[0] === 'offline reload')?.[1]).toBe('BLOCKED')
  expect(
    driver.page.call.mock.calls.some(
      ([method]) => method === 'Network.emulateNetworkConditions',
    ),
  ).toBe(false)
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('offline restore failure restores connectivity and preserves the profile without financial cleanup', async () => {
  const f = loadRunner()
  const driver = domDriver({ breakOffline: true })
  const { results } = await selectedNonfinancial(f, driver)
  expect(results.find(row => row[0] === 'offline reload')?.[1]).toBe('FAIL')
  expect(results.find(row => row[0] === 'network restored')?.[1]).toBe('PASS')
  expect(driver.navigator.onLine).toBe(true)
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('acknowledged online emulation cannot pass when the browser remains offline', async () => {
  const f = loadRunner()
  const driver = domDriver({ stuckOffline: true })
  const { results, screenshot } = await selectedNonfinancial(f, driver)
  expect(driver.page.call).toHaveBeenCalledWith(
    'Network.emulateNetworkConditions',
    expect.objectContaining({ offline: false }),
  )
  expect(results.find(row => row[0] === 'network restored')?.[1]).toBe('FAIL')
  expect(
    results.some(row => row[0] === 'network restored' && row[1] === 'PASS'),
  ).toBe(false)
  expect(driver.restart).not.toHaveBeenCalled()
  expect(screenshot).not.toHaveBeenCalled()
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('identity change on restart fails the selected path without replacement or financial cleanup', async () => {
  const f = loadRunner()
  await expect(
    selectedNonfinancial(f, domDriver({ changeOnRestart: true })),
  ).rejects.toThrow('Owned profile identity changed')
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('actual nonfinancial bootstrap and signals never construct funds or read wallet/env files', async () => {
  const f = loadRunner()
  // The actual CLI bootstrap reaches its browser-launch boundary, where the test refuses it.
  await f.runner.main(['--scenario=nonfinancial'])
  expect(f.spawn).toHaveBeenCalledTimes(1)
  expect(f.persistentProfile).toHaveBeenCalledTimes(1)
  expect(f.process.exitCode).toBe(1)
  expect(f.process.once.mock.calls.map(([signal]) => signal)).toEqual([
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
  ])
  for (const [, handler] of f.process.once.mock.calls) handler()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.process.exit).toHaveBeenCalledTimes(3)
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('pending owned-profile stop is preserved before directory writes or browser launch', async () => {
  const f = loadRunner()
  f.persistentProfile.mockRejectedValue(
    new Error('manual reconciliation required'),
  )
  await expect(f.runner.main(['--scenario=nonfinancial'])).rejects.toThrow(
    'manual reconciliation required',
  )
  expect(f.fs.mkdir).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('known invalid fixture paths fail before profile creation or browser launch', async () => {
  const f = loadRunner()
  f.process.env.E2E_BACKEND_LOGS_DIR = 'relative/logs'
  await expect(f.runner.main(['--scenario=nonfinancial'])).rejects.toThrow(
    'explicit canonical absolute fixture path',
  )
  expect(f.persistentProfile).not.toHaveBeenCalled()
  expect(f.fs.mkdir).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
  expect(f.forbidden).not.toHaveBeenCalled()
})
