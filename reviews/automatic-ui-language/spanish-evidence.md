# Spanish catalog candidate

Scope: `app/src/i18n/es-es/index.ts` and its lightweight `verify.cjs` check. Base contract: `reviews/automatic-ui-language/contract.md` at `48fcda46`. Selected worker model: GPT-6.1 Sol, medium. No hidden runtime or native-speaker verification is claimed.

The catalog contains all 1,660 resolved English leaves: the complete base catalog, embedded local Spanish account-recovery values, `settings.languageAutomatic`, and the stable `signedSwap` namespace read from the signed-negotiation UI worktree. It has no English imports, spreads, calls, or fallback scaffolding. The checker imports English solely to compare catalogs; application catalog evaluation does not.

Terminology uses neutral Spanish: cartera, sello, comisión de red, fragmento de recuperación, servidor de retransmisión, intercambio, clave de acceso. Product/network identifiers, asset symbols, raw recovery-line labels Seed/Check and the exact confirmation word REPLACE remain intact. Mathematical labels such as AVU (Hash)/(Spot) are retained. SHA-256/HMAC-SHA256 algorithm names remain unchanged; explanatory argument names are translated.

Safety-sensitive wording preserves unknown versus failed submissions, message delivery versus chain payment, held funds, repeat-send risks, backup thresholds, independently saved descriptor checks, and permanent loss/access warnings. Signed swap text explicitly says acceptance transfers and authorizes no funds. Legal licence and non-commercial restrictions remain explicit.

Verification from this worktree root:

```sh
node app/src/i18n/es-es/verify.cjs /Users/shammah/repos/frank/.worktrees/signed-negotiation-ui/app/src/i18n/en-us/index.ts
/Users/shammah/repos/frank/node_modules/.bin/prettier --check app/src/i18n/es-es/index.ts app/src/i18n/es-es/verify.cjs
git diff --check
```

Result: 1,660 leaves passed exact recursive key parity, interpolation-token parity, numeric-literal preservation, URL preservation, TypeScript transpilation diagnostics and Intlify message compilation. AST inspection rejects catalog imports/spreads/calls. Identical English/Spanish values were inspected and consist of product/network names, asset quantities, formula/chart identifiers, literal recovery labels/confirmation word, shared technical terms (Bot, Cc), format-only interpolations and Google Calendar. Temporary translation working files were removed.

No full typecheck, app render smoke, dependency installation, live service, funds operation or shared-dependency mutation was performed. Parent integration must run final combined parity with the final English catalog, all configured typechecks, and actual Spanish render/Settings smoke. Independent semantic review remains required; automated checks do not establish translation quality.
