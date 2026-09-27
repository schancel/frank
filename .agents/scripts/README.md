# Cargo worktree caching

Adapted from `~/repos/finch`'s equivalent tooling (2026-09-26) — copied in wholesale and
genericized (Finch-specific naming only; the mechanism is project-agnostic), not reimplemented,
since it already has a real history of edge cases worked out (see each script's own comments).

This monorepo's ticket-dispatch pattern gives every ticket its own `git worktree` under
`../frank-worktrees/<ticket>-<slug>`. Without this tooling, each worktree's `cargo` invocation
either recompiles the entire dependency tree from scratch (slow — `backend/bitcoinsuite` alone
pulls in rocksdb, hyper, axum, and other heavy native/pure-Rust deps) or requires hand-managing a
shared `CARGO_TARGET_DIR` (fragile, and multiple concurrent builds in the same repo's worktrees can
race on it).

- **`with-cargo-slot <cargo command...>`** — run from inside any worktree of this repo. Gives that
  worktree its own deterministic, isolated `CARGO_TARGET_DIR` under `~/.cache/cargo-target/<repo
  hash>/<worktree hash>/`, serializes concurrent builds in the same repo via an `flock`, and (if
  `sccache` is on `PATH`) wires up cross-worktree compiler caching so identical dependency compiles
  hit cache instead of recompiling per worktree. Example:

  ```sh
  cd backend/cashweb
  bash ../../.agents/scripts/with-cargo-slot cargo test -p cashweb-registry
  ```

- **`reclaim-cargo-targets [--apply] [--repo <path>]`** — run periodically (e.g. after a wave of
  tickets' worktrees have been merged and removed via `git worktree remove`) to delete orphaned
  target directories left behind under the shared cache. Dry-run by default; `--apply` actually
  deletes. Refuses to touch anything still registered, dirty, or referenced by a live process —
  see the script's own header comment for the exact safety rules.

Both scripts are self-contained (bash + perl only) and were verified working against this repo on
2026-09-26.
