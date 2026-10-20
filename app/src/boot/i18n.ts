import { messages, defaultLocale } from 'src/i18n'
import { defineBoot as boot } from '@quasar/app-vite'
import { createI18n } from 'vue-i18n'
// you'll need to create the src/i18n/index.js file too

type MessageCompilerContext = {
  normalize: (values: unknown[]) => unknown
  interpolate: (val: unknown) => unknown
  named: (key: string) => unknown
  list: (index: number) => unknown
  plural?: (messages: unknown[]) => unknown
}

function compileBranch(branch: string) {
  const tokens: Array<
    | { kind: 'text'; value: string }
    | { kind: 'list'; index: number }
    | { kind: 'named'; key: string }
  > = []
  const regex = /\{([^}]+)\}/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(branch)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        kind: 'text',
        value: branch.slice(lastIndex, match.index),
      })
    }
    const key = match[1].trim()
    if (/^\d+$/.test(key)) {
      tokens.push({ kind: 'list', index: Number(key) })
    } else {
      tokens.push({ kind: 'named', key })
    }
    lastIndex = regex.lastIndex
  }
  if (lastIndex < branch.length) {
    tokens.push({ kind: 'text', value: branch.slice(lastIndex) })
  }
  return (ctx: MessageCompilerContext) => {
    if (tokens.length === 0) return ctx.normalize([''])
    const parts = tokens.map(token => {
      if (token.kind === 'text') return token.value
      const raw =
        token.kind === 'list' ? ctx.list(token.index) : ctx.named(token.key)
      return ctx.interpolate(raw)
    })
    return ctx.normalize(parts)
  }
}

function cspSafeMessageCompiler(message: unknown) {
  if (typeof message === 'function') {
    return message as (ctx: MessageCompilerContext) => unknown
  }
  const source = typeof message === 'string' ? message : String(message ?? '')
  const branches = source.includes('|') ? source.split(/\s*\|\s*/) : [source]
  const compiledBranches = branches.map(compileBranch)
  return (ctx: MessageCompilerContext) => {
    if (compiledBranches.length > 1 && typeof ctx.plural === 'function') {
      return ctx.plural(compiledBranches.map(fn => fn(ctx)))
    }
    return compiledBranches[0](ctx)
  }
}

// Active locale strings may fall back; the default catalog owns the message schema.
function createAppI18n() {
  const origWarn = typeof console !== 'undefined' ? console.warn : undefined
  if (typeof console !== 'undefined' && typeof origWarn === 'function') {
    console.warn = (...args: unknown[]) => {
      if (
        typeof args[0] === 'string' &&
        args[0].includes('Custom Message Compiler')
      ) {
        return
      }
      origWarn.apply(console, args)
    }
  }
  try {
    return createI18n<[(typeof messages)[typeof defaultLocale]], string>({
      locale: defaultLocale,
      fallbackLocale: defaultLocale,
      globalInjection: true,
      missingWarn: false,
      fallbackWarn: false,
      messageCompiler: cspSafeMessageCompiler as never,
      messages,
    })
  } finally {
    if (typeof console !== 'undefined' && typeof origWarn === 'function') {
      console.warn = origWarn
    }
  }
}

const i18n = createAppI18n()

export default boot(({ app }) => {
  // Set i18n instance on app
  app.use(i18n)
})

export { i18n }
