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
tagteam list --json     # the same as JSON, for scripts and widgets
tagteam main 2          # make account 2 (or an email) the main account
tagteam remove 3        # stop managing account 3
```

- The first account added is the main account. The others follow in the order
  you add them.
- The daemon prefers the first account that is below its threshold for both
  limits. If none is, it uses the first account still below 100% of both limits.
  If no account has capacity left, Claude Code stays where it is.
- The threshold depends on the account's plan, which tagteam reads from the rate
  limit tier Claude Code stores with the login: 90% for Pro, 95% for Max 5x and
  97% for Max 20x. Team seats count as the Max plan with the same tier, and
  unknown tiers as Pro. `tagteam list` shows each account's plan.
- It checks the active account every minute and the others every five minutes.
  `tagteam list` shows the usage from these checks, so it doesn't spend more of
  the requests Anthropic allows.
- `--threshold-pro`, `--threshold-max-5x`, `--threshold-max-20x` and
  `--interval <seconds>` change the defaults.

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

- `services.tagteam.thresholds.pro`, `.max5x`, `.max20x` and
  `services.tagteam.interval` set the daemon's flags.
- `services.tagteam.herdr.enable` installs the [Herdr](#herdr) mod.
- With `programs.claude-code` enabled, the service puts Claude Code on its
  `PATH`, since tagteam identifies itself with Claude Code's version.

Without Nix, run `tagteam daemon` as a service of your own.

## Herdr

`herdr/tagteam-usage/` is a mod for the [Herdr](https://herdr.dev) desktop app.
It shows a small window with each account's 5-hour and weekly usage and when
each limit resets, marks the active account and lists failed checks on hover.

- Install it with the Home Manager option above, or copy the folder to
  `~/.config/herdr-app/mods/`.
- Open it with `herdr-app do mod.open --name tagteam-usage`, or run `mod.open`
  from the command palette. It floats over the layout it was opened in, any
  layout including the default one, and Herdr reopens it there on every start.
  Running `mod.open` again closes it.
- Drag it where you want it. Herdr remembers the spot.
- It runs `tagteam list --json` every 30 seconds, which answers from the
  daemon's cache, so it doesn't spend usage requests.

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
