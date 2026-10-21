# tagteam

A daemon and CLI that rotates Claude Code between several accounts. It prefers
one main account, switches to the next account in priority order when the active
one nears its 5-hour or weekly limit, and returns to the main account once it
recovers.

## Tooling

- Node.js 26 runs the TypeScript sources directly, without a build step.
- pnpm scripts: `start`, `test`, `format`, `lint` (includes type checking) and
  `check` (lint and format check).
- `lint` and `check` run oxlint with type-aware rules through tsgolint, which
  uses a lot of CPU and memory. Run it once when you have finished your changes,
  not after each edit.
- Issues live as GitHub issues in `k3dom/tagteam`, managed via the `gh` CLI.

## Vendored repositories

`.agents/repos/` holds git subtrees, registered in `.agents/repos/.subtrees` and
managed with `scripts/add-subtree.sh` and `scripts/update-subtree.sh`. Read them
instead of relying on memory, and leave them unchanged.

- Effect-TS (`.agents/repos/effect/`), pinned to the installed `effect`. Check
  APIs, usage and implementation details here.
- claude-swap (`.agents/repos/claude-swap/`) and clauth
  (`.agents/repos/clauth/`), two existing account switchers kept as references.
  They show how Claude Code stores credentials, which locks it takes while
  refreshing them, and how the OAuth token and usage endpoints behave. Treat
  them as research, not as code to port: tagteam keeps only the auto-switcher
  with a main account.
