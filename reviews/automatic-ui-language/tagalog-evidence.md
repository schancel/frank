# Tagalog catalog evidence

Scope: tier 1 translation-only catalog, executing the existing automatic UI language contract. No runtime, registry, English/French, persistence or wire-format edits. `app/src/i18n/tl-ph/index.ts` is a standalone static object with all translated recovery values inline, without English imports or spreads.

Reference: base `f409b28a0af0f083d72bfb847c34cfe4865ffb0e` English catalog and its resolved account-recovery values, plus `settings.languageAutomatic` and the stable `signedSwap` namespace initially read from sibling signed-negotiation UI at `b06fb4248691c5d7182e74e64606731ac355a1a3`, with three wording corrections from exact English revision `7a17f623`. Final integration must compare against the combined English catalog again.

Catalog SHA-256: `6182a5dd147ff358bb07854ac462a7c5447e914733f84081f7af7772183502d6`.

Checks passed: 1,660 expected and actual message leaves; exact recursive keys, interpolation/literal tokens, numeric literals and URLs; all messages compile with the installed `@intlify/message-compiler`; no import or spread nodes; 229 protocol/product/asset name comparisons; Prettier check; `git diff --check`. The 136 English-identical leaves contain names, asset symbols, structural templates, or established technical labels (for example Wallet, Username, Code, Recovery Phrase). Complete sentences and recovery/payment warnings are translated; identical values do not originate from runtime fallback scaffolding.

Translation preserves recipient amounts versus fees, uncertain submission versus failed transfers, recovery activation warnings, backup thresholds, independent descriptor requirements, and signed negotiation versus fund authorization. Common technical terms remain where useful in understandable Tagalog. No native-speaker validation is claimed. Parent integration and independent semantic/UI review remain required; this catalog-only worker did not run broad typechecks or live services.

Reproduce from the catalog worktree using existing dependencies. The optional argument supplies the signedSwap English reference before integration; after integration omit that argument to use the combined English catalog.

```sh
node - ../signed-negotiation-ui/app/src/i18n/en-us/index.ts <<'JS'
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { baseCompile } = require('@intlify/message-compiler');
function load(file) {
  const source = fs.readFileSync(file, 'utf8');
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS } });
  if (result.diagnostics.length) throw new Error(`TypeScript diagnostics in ${file}`);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputText)(name => load(path.resolve(path.dirname(file), `${name}.ts`)), module, module.exports);
  return module.exports;
}
function flatten(value, prefix = [], output = new Map()) {
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') output.set([...prefix, key].join('.'), item);
    else flatten(item, [...prefix, key], output);
  }
  return output;
}
const expected = load('app/src/i18n/en-us/index.ts').default;
expected.settings.languageAutomatic = 'Automatic (browser language)';
expected.signedSwap = load(process.argv[2] || 'app/src/i18n/en-us/index.ts').default.signedSwap;
if (!expected.signedSwap) throw new Error('signedSwap reference missing');
const english = flatten(expected);
const tagalog = flatten(load('app/src/i18n/tl-ph/index.ts').default);
const extraction = {
  tokens: text => text.match(/\{[^}]*\}/g) || [],
  numbers: text => text.match(/\d+(?:[.,]\d+)*/g) || [],
  urls: text => text.match(/(?:https?:\/\/|bitcoincash:)[^\s]+/g) || [],
};
const errors = [];
for (const [key, text] of english) {
  const translation = tagalog.get(key);
  if (translation === undefined) { errors.push(`${key}: missing`); continue; }
  for (const [kind, extract] of Object.entries(extraction)) {
    if (JSON.stringify(extract(text).sort()) !== JSON.stringify(extract(translation).sort())) errors.push(`${key}: ${kind} differ`);
  }
  baseCompile(translation, { onError: error => errors.push(`${key}: ${error.message}`) });
}
for (const key of tagalog.keys()) if (!english.has(key)) errors.push(`${key}: extra`);
const catalogSource = fs.readFileSync('app/src/i18n/tl-ph/index.ts', 'utf8');
const ast = ts.createSourceFile('index.ts', catalogSource, ts.ScriptTarget.Latest, true);
function checkNoFallback(node) {
  if (ts.isImportDeclaration(node) || ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) errors.push('Import or spread found in standalone catalog');
  ts.forEachChild(node, checkNoFallback);
}
checkNoFallback(ast);
const names = ['Frank','Monad','MONT','MON','BCH','BIP39','PRF','Mera','secp256k1','SHA-256','HMAC-SHA256','DKSAP','CashWeb','AVU','CPI','EIA','Proof-of-Work','DeFi','Silence Laboratories','DKLs23','MIT','Uniswap Labs','SOL','Solana','eCash','Bitcoin','Litecoin','Dogecoin','Monero','Cambridge','RandomX','scrypt','MetaMask','Phantom','Ledger','EVM','PNG','JPEG','WebP','GIF','UTF-8','HTTPS','HTTP','frankdesc','Google Calendar','Apple','OS','vCard','Nostr','GitHub','Telegram','Discord','Twitter','Tollbooth'];
let nameChecks = 0;
for (const [key, text] of english) {
  const translation = tagalog.get(key);
  if (translation === undefined) continue;
  for (const name of names) {
    // Named protocol/product/asset values must retain their exact spelling.
    const count = value => value.split(name).length - 1;
    if (count(text)) {
      nameChecks++;
      if (count(text) !== count(translation)) errors.push(`${key}: named value ${name} differs`);
    }
  }
}
console.log(JSON.stringify({ nameChecks, englishLeaves: english.size, tagalogLeaves: tagalog.size, unchangedTechnicalOrSymbolLeaves: [...english].filter(([key, value]) => tagalog.get(key) === value).length, errors }, null, 2));
if (errors.length) process.exit(1);
JS
/Users/shammah/repos/frank/node_modules/.bin/prettier --check app/src/i18n/tl-ph/index.ts
git diff --check
```

Observed checker result:

```json
{
  "nameChecks": 229,
  "englishLeaves": 1660,
  "tagalogLeaves": 1660,
  "unchangedTechnicalOrSymbolLeaves": 136,
  "errors": []
}
```

Requested dispatch lane/model: GPT-6.1 Sol, medium. No model attestation beyond the orchestrator's actual dispatch is asserted. Candidate remains isolated for parent integration; no merge, push, deployment or cleanup performed.

## Signed-swap wording correction

Follow-up to catalog commit `8bfa16289215bfe32fba478f23a32cb39eb1900d`: exactly three catalog leaves changed, with no keys or placeholders changed. `signedSwap.negotiationOnly` and `signedSwap.states.accept` now refer specifically to the funds being swapped, leaving message-stamp payments distinct. `signedSwap.errors.failed` now conditionally retains a saved authorization without implying one necessarily exists.

Read the English wording directly with `git show 7a17f623:app/src/i18n/en-us/index.ts`. Re-ran the checker above against that exact English namespace (temporary reference file with unchanged account-recovery dependency): 1,660 leaf keys, tokens/numbers/URLs, all message compilation, 229 name comparisons, and no imports/spreads pass with zero errors. Prettier and diff checks pass. Source diff against `8bfa1628` contains only the three named message changes. No broad typecheck or native-speaker validation claimed.
