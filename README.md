# tagteam

Keeps Claude Code on your main account and hands off to your other accounts as
it nears its 5-hour or weekly rate limit. Once the main account recovers,
tagteam switches back. Running sessions pick up the new account on their next
message, so a switch never waits for them to finish.

## Development

```bash
direnv allow   # or: nix develop
pnpm install
pnpm start --help
pnpm test
pnpm check     # oxlint with type checking, then oxfmt
```
