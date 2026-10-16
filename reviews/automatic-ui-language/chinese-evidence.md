# Chinese catalogs

Tier 1 localized prose implementation, following the accepted automatic UI language contract and implement workflow. Both `zh-cn` and `zh-tw` are complete standalone static objects, with no English imports, object spreads or runtime translation dependency. The account recovery namespace is translated inline. Scope: these two catalog directories and this evidence file only.

Each catalog has 1,660 string leaves, matching resolved base English plus `settings.languageAutomatic` and the signed UI's `signedSwap` namespace. Signed UI reference was read from `.worktrees/signed-negotiation-ui` at `b06fb4248691c5d7182e74e64606731ac355a1a3`; no source there was edited.

Traditional Chinese received a local Foundation `Hans-Hant` orthographic conversion followed by regional terminology and phrasing edits, including 帳戶, 訊息, 設定, 網路, 聯絡人, 儲存, 伺服器, 軟體, 硬體, 檔案, 資料夾, 剪貼簿, 分頁, 雜湊, 位元組, 身分, 使用者名稱, 收件者, 副本 and 密件副本. It is not an unedited character conversion. Simplified uses corresponding Mainland terminology. Recovery phrase is 助记词 / 助記詞; threshold recovery shards remain 分片. Literal Seed and Check line names are retained alongside localized explanations.

Safety-sensitive readings checked: unknown delivery versus failed delivery; no duplicate payment on retry; ambiguous broadcast warnings; pending funds versus spendable balance; sender-claimed versus chain-verified amounts; original signed negotiation only with no funds transfer or authorization; data reset consequences; independently retained account descriptor; backup sets must not mix; threshold access; passkey failure leaves no account activated; partial native operations; swap fee-only failure versus unknown settlement. Blackjack 3:2 is explicitly a payout ratio, not a score. Product, protocol, network names and denominations remain unchanged. English-identical leaves are proper names, symbols, numeric amounts, REPLACE, formula-only labels and `{fee} {unit}`.

## Completed checks

- Recursive full leaf-key parity: both catalogs 1,660/1,660, no extras or omissions.
- Exact interpolation/literal brace-token parity: all leaves pass, including `{'@'}`.
- `@intlify/message-compiler` parsing/compilation: all 3,320 localized messages pass.
- AST check rejects English imports and object spread fallback scaffolding.
- Numeric token inspection: values preserved; the only intentional representation difference is English “September 2023” localized as “2023 年 9 月”.
- Donation address, protocol names and algorithm expressions inspected; address unchanged.
- Both files formatted with the repository's installed Prettier and `app/.prettierrc.json`; `git diff --check` passes.

No full typecheck, live services, translation service, installation, browser rendering or native-speaker attestation was performed. Combined typechecks, actual render smoke and independent translation review belong to parent integration.

## Reproduce lightweight checks

Run from the integrated worktree. The script uses bundled dependencies and the integrated English catalog. Before signed UI integration, supply `SIGNED_EN` pointing to its English catalog; before host integration the automatic label is supplied as below.

```sh
node <<'JS'
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')
const ts = require('typescript')
const { baseCompile } = require('@intlify/message-compiler')
function load(file) {
  const exports = {}
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(js, {
    exports,
    require: specifier => load(path.resolve(path.dirname(file), specifier + '.ts')),
  })
  return exports
}
function flatten(value, prefix = '', result = {}) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? prefix + '.' + key : key
    if (typeof item === 'string') result[name] = item
    else flatten(item, name, result)
  }
  return result
}
const english = load('app/src/i18n/en-us/index.ts').default
english.settings.languageAutomatic ??= 'Automatic (browser language)'
if (!english.signedSwap && process.env.SIGNED_EN) {
  english.signedSwap = load(process.env.SIGNED_EN).default.signedSwap
}
assert(english.signedSwap, 'Integrate signed UI or set SIGNED_EN')
const expected = flatten(english)
const tokens = text => [...text.matchAll(/\{[^{}]+\}/g)].map(m => m[0]).sort()
for (const locale of ['zh-cn', 'zh-tw']) {
  const file = 'app/src/i18n/' + locale + '/index.ts'
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  function inspect(node) {
    assert(!ts.isImportDeclaration(node) && !ts.isSpreadAssignment(node), file)
    ts.forEachChild(node, inspect)
  }
  inspect(ast)
  const actual = flatten(load(file).default)
  assert.deepStrictEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
  for (const [key, text] of Object.entries(actual)) {
    assert.deepStrictEqual(tokens(text), tokens(expected[key]), locale + ':' + key)
    baseCompile(text, { onError(error) { throw error } })
  }
  console.log(locale, Object.keys(actual).length, 'leaves: keys, tokens, compilation and no-fallback AST pass')
}
JS
```

## Independent review corrections

The parent independently confirmed orthographic conversion artifacts in Traditional Chinese. Corrected the 11 reply-related 回復 occurrences to 回覆, the six conjunction 併 occurrences to 並, and accountRecovery.profile_unavailable 名稱稱 to 名稱. No other regional terminology changed. Re-ran recursive key parity, brace-token parity, all 3,320 message compilations, no-fallback AST checks and whitespace checks; all pass.
