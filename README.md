# tagteam

Keeps Claude Code on your main account, switches to your next account when it
nears its 5-hour or weekly limit, and switches back once the main account
recovers. Running sessions use the new account from their next message.

## Usage

Start the daemon with `tagteam daemon`, or let the [Home Manager module](#nix)
run it. The other commands talk to it, so it needs to be running. For each
account, log in with `/login` in Claude Code, then run `tagteam add`. Don't
`/logout` in between, since that can revoke the login tagteam just stored.

```bash
tagteam daemon          # watch usage, switch accounts and serve the commands below
tagteam add             # add the account Claude Code is logged into
tagteam add --main      # add it and make it the main account
tagteam list            # accounts in priority order with their usage
tagteam main 2          # make account 2 (or an email) the main account
tagteam remove 3        # stop managing account 3
```

- The first account added is the main account. The others follow in the order
  you add them.
- The daemon keeps Claude Code on the first account that is below 90% of both
  limits. If none is, Claude Code stays where it is.
- It checks the active account every minute and the others every five minutes.
  `tagteam list` shows the usage from these checks, so it doesn't spend more of
  the requests Anthropic allows.
- `--threshold <percent>` and `--interval <seconds>` change the defaults.

## Nix

The flake provides a package and a Home Manager module that runs the daemon as a
systemd user service:

```nix
# flake.nix
inputs.tagteam.url = "github:k3dom/tagteam";

# Home Manager configuration
imports = [inputs.tagteam.homeManagerModules.default];
services.tagteam.enable = true;
```

- `services.tagteam.threshold` and `services.tagteam.interval` set the daemon's
  flags.
- With `programs.claude-code` enabled, the service puts Claude Code on its
  `PATH`, since tagteam identifies itself with Claude Code's version.

Without Nix, run `tagteam daemon` as a service of your own.

## How it works

- **Daemon and CLI:** the daemon keeps the accounts and their usage in memory
  and serves an HTTP API at the Unix socket `$XDG_RUNTIME_DIR/tagteam.sock` (or
  `tagteam.sock` in the data directory where that isn't set). The other commands
  are clients of that API. The daemon reads Claude Code's login, so
  `CLAUDE_CONFIG_DIR` matters in its environment rather than the shell's.
- **Storage:** accounts live in `$XDG_DATA_HOME/tagteam/accounts.json` (default
  `~/.local/share/tagteam/`), readable only by you. Only the daemon writes it.
- **Switching:** replaces the login in `~/.claude/.credentials.json` and
  `oauthAccount` in `~/.claude.json`. MCP server tokens and other settings stay.
  `CLAUDE_CONFIG_DIR` is respected.
- **Token refresh:** refresh tokens change on every refresh, so tagteam never
  refreshes the account Claude Code is using. It copies that account's tokens
  from Claude Code instead.
- **Locking:** a switch takes the same locks as Claude Code
  (`.oauth_refresh.lock`, `~/.claude.lock`, `~/.claude.json.lock`), checked
  against Claude Code 2.1.302.
- **Platform:** Linux only for now. The macOS Keychain isn't supported.

## Development

```bash
direnv allow   # or: nix develop
pnpm install
pnpm start --help
pnpm test
pnpm check     # oxlint with type checking, then oxfmt
nix flake check
```

After changing dependencies, update the hash in `nix/package.nix`: set it to
`""`, run `nix build`, and copy the hash it reports.
