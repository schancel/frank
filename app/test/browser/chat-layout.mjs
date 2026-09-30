// Real-browser layout check for the chat page (#390, and the layout-test gap in #302): jsdom cannot
// measure layout, so this drives Chromium against the dev server.
//
//   yarn test:browser                       # starts its own `quasar dev` on port 9080
//   APP_URL=http://localhost:8080 yarn test:browser   # or reuse an already-running app
//
// Env: CHROME_PATH (default: macOS/Linux Chrome/Chromium lookup), PORT (default 9080).
// It signs up a throwaway account in a fresh private browser context, opens a chat, sends one
// message (it stays as a local "failed" bubble without funds; that is enough to lay out), and
// asserts at phone and desktop widths that: the first bubble clears the header by the list's
// top spacing, the last bubble clears the footer, the scroll area does not run under the footer,
// and the header text meets the 4.5:1 WCAG AA contrast ratio. Exits non-zero on any failure.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = process.env.PORT ?? '9080'
const PEER = '0x47EE31F2edbefb5e97569378CE72974384929A40'
const SPACING_MIN = 8 // px: anything below this is "flush"; the list uses q-py-md (16px)

const chromePath = () =>
  process.env.CHROME_PATH ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find(existsSync)

const lum = ([r, g, b]) => {
  const f = c =>
    (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const rgb = s =>
  s
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number)

async function startServer() {
  if (process.env.APP_URL) return { url: process.env.APP_URL, stop() {} }
  const proc = spawn('npx', ['quasar', 'dev', '-p', PORT], {
    cwd: appDir,
    stdio: 'ignore',
  })
  const url = `http://localhost:${PORT}/`
  for (let i = 0; i < 120; i++) {
    if (
      await fetch(url).then(
        r => r.ok,
        () => false,
      )
    )
      break
    await new Promise(r => setTimeout(r, 1000))
  }
  return { url, stop: () => proc.kill() }
}

async function signUpAndOpenChat(page, url, name) {
  await page.goto(url)
  const click = async (n, t = 60000) =>
    page.getByRole('button', { name: n }).click({ timeout: t })
  await click('Agree')
  await click('New Account')
  const input = page.locator('input').first()
  await input.fill(name)
  await input.blur()
  const words = (await page.locator('textarea').inputValue()).split(' ')
  await click('Next')
  const labels = await page.locator('text=/Word #\\d+/').allInnerTexts()
  const ins = page.locator('input')
  for (let i = 0; i < labels.length; i++) {
    await ins.nth(i).fill(words[Number(labels[i].match(/\d+/)[0]) - 1])
  }
  await click('Check my answers')
  await click('Finish')
  await page.waitForTimeout(6000)
  await page.goto(`${url}#/chat/${PEER}`)
  await page.locator('textarea').first().waitFor({ timeout: 30000 })
  await page.locator('textarea').first().fill('layout check')
  await page.keyboard.press('Enter')
  await page.locator('.q-message').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(1000)
}

const measure = page =>
  page.evaluate(() => {
    const box = sel => document.querySelector(sel).getBoundingClientRect()
    const bubbles = [...document.querySelectorAll('.q-message')]
    const header = document.querySelector('.q-header')
    const hs = getComputedStyle(header)
    return {
      headerBottom: box('.q-header').bottom,
      footerTop: box('.q-footer').top,
      scrollBottom: box('.q-scrollarea').bottom,
      firstTop: bubbles[0].getBoundingClientRect().top,
      lastBottom: bubbles.at(-1).getBoundingClientRect().bottom,
      headerColor: hs.color,
      headerBg: hs.backgroundColor,
    }
  })

const failures = []
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failures.push(msg)
}

const server = await startServer()
const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
})
try {
  for (const [label, viewport] of [
    ['phone 375px', { width: 375, height: 700 }],
    ['desktop 1280px', { width: 1280, height: 800 }],
  ]) {
    const context = await browser.newContext({ viewport }) // fresh, private
    const page = await context.newPage()
    await signUpAndOpenChat(page, server.url, `Layout${viewport.width}`)
    const m = await measure(page)
    const gapTop = m.firstTop - m.headerBottom
    const gapBottom = m.footerTop - m.lastBottom
    check(
      gapTop >= SPACING_MIN,
      `${label}: first bubble clears the header (${gapTop}px)`,
    )
    check(
      gapBottom >= SPACING_MIN,
      `${label}: last bubble clears the footer (${gapBottom}px)`,
    )
    check(
      m.scrollBottom <= m.footerTop + 0.5,
      `${label}: scroll area ends above the footer`,
    )
    const ratio = contrast(rgb(m.headerColor), rgb(m.headerBg))
    check(
      ratio >= 4.5,
      `${label}: header text contrast ${ratio.toFixed(2)}:1 >= 4.5`,
    )
    await context.close()
  }
} finally {
  await browser.close()
  server.stop()
}
process.exit(failures.length ? 1 : 0)
