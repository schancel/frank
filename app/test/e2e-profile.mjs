// The Chrome profile of a browser check, kept between runs.
//
// A browser check creates a Frank account inside its Chrome profile and funds it with real
// testnet MON. The account's keys exist only in that profile, so the profile is PERSISTENT:
// `~/.frank-e2e-browser/<check>/` (or E2E_PROFILE_DIR), created once and reused. The same account
// is opened on every run and funded only when it holds less than the run needs; what a run leaves
// stays in the account for the next one. Nothing here ever deletes the profile: deleting it loses
// the account and whatever it holds. To run a check's first-time onboarding again, point
// E2E_PROFILE_DIR at a new directory (that account then has its own money; its address is
// printed).
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The profile directory of `check`, created when missing, and the account recorded in it. */
export async function persistentProfile(check) {
  const directory = resolve(
    process.env.E2E_PROFILE_DIR ?? join(homedir(), '.frank-e2e-browser', check),
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Addresses only (no key): written once the account exists, so the next run knows to open it
  // instead of creating another.
  const marker = join(directory, 'frank-account.json')
  let account
  try {
    account = JSON.parse(await readFile(marker, 'utf8'))
  } catch {
    account = undefined
  }
  return {
    directory,
    /** `{ receive, profile?, createdAt }` of the account in this profile, or undefined on a first run. */
    account,
    async recordAccount(addresses) {
      await writeFile(
        marker,
        JSON.stringify(
          { ...addresses, createdAt: new Date().toISOString() },
          null,
          2,
        ),
        { mode: 0o600 },
      )
    },
  }
}

const SESSION = `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name)`
const mon = wei => (Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(6)

function fundTool(repoRoot, args, timeout) {
  return new Promise((resolveRun, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'packages/bot/demo/fund.ts', ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: 'packages/bot/tsconfig.json',
        },
        timeout,
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error((stderr || error.message).trim().split('\n')[0]))
          : resolveRun(stdout.trim()),
    )
  })
}

/**
 * The money side of a browser check, the same for every check:
 *   const funds = testFunds({ repoRoot, directory, page: { evaluate, typeInput, click, until } })
 *   await funds.ensure(needWei)     funds the account from the test wallet only when it holds less
 *   await funds.finish()            in a `finally`: sends what it holds above the float back to the
 *                                   test wallet through the app's own send page and prints ONE line:
 *                                   funded X, returned Y, left Z in <profile> (why)
 * The float is the harness's one constant (TEST_ACCOUNT_FLOAT_WEI in
 * packages/bot/demo/real-stack.ts, read through `fund.ts --info`). `finish` never throws: money
 * that is not sent back stays in the persistent account for the next run. Ctrl-C, SIGTERM and
 * SIGHUP run `finish` and then `stop` before the process ends.
 */
export function testFunds({ repoRoot, directory, page, stop }) {
  let fundedWei = 0n
  let finished
  let info
  const testWallet = () =>
    (info ??= fundTool(repoRoot, ['--info'], 60000).then(
      out => {
        const parsed = JSON.parse(out)
        return { address: parsed.address, floatWei: BigInt(parsed.floatWei) }
      },
      () => undefined,
    ))
  const wallet = what =>
    page.evaluate(
      `${SESSION}.then(async m => { const w = await m.accountSession.getWallet(); return ${what} })`,
    )
  const spendable = async () =>
    BigInt(await wallet('(await w.getBalance()).toString()'))
  const receive = () => wallet('(await w.getReceiveAddress()).raw')

  /** One native send from the page, waited to its outcome. */
  async function sendFromPage(to, amountMon) {
    await page.evaluate(`location.hash = '#/wallet'`)
    await new Promise(r => setTimeout(r, 1000))
    await page.evaluate(`location.hash = '#/send'`)
    await page.typeInput('[data-test="send-address-input"]', to)
    await page.typeInput('[data-test="send-amount-input"]', amountMon)
    await page.click('[data-test="send-review-button"]')
    await page.until(
      `(() => { const b = document.querySelector('[data-test="review-confirm-button"]'); return b && !b.disabled && !b.classList.contains('q-btn--loading') && !b.querySelector('.q-spinner') })()`,
      20000,
      'confirm button ready',
    )
    await new Promise(r => setTimeout(r, 500))
    await page.click('[data-test="review-confirm-button"]')
    await page.until(
      `location.hash !== '#/send' || /sent on|reverted/i.test(document.querySelector('[data-test="native-operation-outcome"]')?.innerText ?? '')`,
      120000,
      'the transfer to finish',
    )
    const outcome = await page.evaluate(
      `location.hash !== '#/send' ? 'sent' : document.querySelector('[data-test="native-operation-outcome"]').innerText.replace(/\\n+/g, ' ')`,
    )
    if (/reverted/i.test(outcome)) throw new Error(outcome)
  }

  const finish = () =>
    (finished ??= (async () => {
      let address = '(account not open)'
      let before
      let held
      let why = ''
      try {
        address = await receive()
        before = await spendable()
        const target = await testWallet()
        const float = `the float a persistent test account keeps is ${mon(
          target?.floatWei ?? 0n,
        )} MON`
        if (!target)
          why =
            'FRANK_TEST_WALLET_JSON is not configured, so there is no wallet to return to'
        // Under 0.005 MON above the float the fee is not worth it.
        else if (before <= target.floatWei + 5n * 10n ** 15n) why = float
        else {
          why = float
          await sendFromPage(target.address, mon(before - target.floatWei))
          await new Promise(r => setTimeout(r, 3000))
        }
      } catch (err) {
        why = `the page did not confirm the return: ${String(
          err?.message ?? err,
        )
          .split('\n')[0]
          .slice(0, 160)}`
      }
      // What came back is read from the account, not taken from what the page said: the send
      // page can leave a transfer "unresolved" that the chain has in fact mined.
      held = await spendable().catch(() => undefined)
      const returnedWei =
        before !== undefined && held !== undefined && held < before
          ? before - held
          : 0n
      console.log(
        `[funds] funded ${mon(fundedWei)} MON, returned ${mon(
          returnedWei,
        )} MON (fee included), left ${
          held === undefined ? 'an unread amount' : `${mon(held)} MON`
        } in the account ${address} of the persistent profile ${directory} (${why}; reused by the next run, never delete it)`,
      )
    })())

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      console.error(`${signal}: returning test funds before stopping`)
      void finish()
        .catch(() => undefined)
        .then(() => stop?.())
        .catch(() => undefined)
        .then(() => process.exit(signal === 'SIGINT' ? 130 : 143))
    })
  }

  return {
    testWallet,
    spendable,
    sendFromPage,
    /** Funds the account up to `needWei` from the test wallet when it holds less. Returns what
     * the funding tool printed, or undefined when nothing was needed. */
    async ensure(needWei) {
      const held = await spendable()
      if (held >= needWei) return undefined
      const missing = needWei - held
      const out = await fundTool(
        repoRoot,
        [await receive(), mon(missing + 10n ** 12n)],
        180000,
      )
      fundedWei += missing
      return out
    },
    finish,
  }
}

/** The line every check prints last: where the money is and that it is kept. */
export function accountLine(directory, address, balanceWei) {
  const mon = (Number(BigInt(balanceWei) / 10n ** 12n) / 1e6).toFixed(6)
  return `ACCOUNT ${address} holds ${mon} MON; its keys are in the persistent profile ${directory} (reused by the next run; do not delete it)`
}
