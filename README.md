# tagteam

Keeps Claude Code on your main account and hands off to your other accounts as
it nears its 5-hour or weekly rate limit. Once the main account recovers,
tagteam switches back. Running sessions pick up the new account on their next
message, so a switch never waits for them to finish.

## Usage

Add every account once. Log in to it with `/login` in Claude Code, then run
`tagteam add`. The first account you add becomes the main account, and the
others follow in the order you add them. Don't `/logout` between accounts, since
that can revoke the login tagteam just stored.

```bash
tagteam add             # add the account Claude Code is logged into
tagteam add --main      # add it and make it the main account
tagteam list            # accounts in priority order with their usage
tagteam main 2          # make account 2 (or an email) the main account
tagteam remove 3        # stop managing account 3
tagteam daemon          # watch usage and switch accounts
```

`tagteam daemon` checks the active account's usage every minute and the other
accounts every five minutes. Claude Code always runs on the first account in
priority order that is below 90% of both its 5-hour and its weekly limit. That
moves it off an account nearing a limit, and back to the main account as soon as
that account's limit resets. When every account is near its limits, Claude Code
stays where it is. Change the defaults with `--threshold <percent>` and
`--interval <seconds>`.

To keep the daemon running, run it as a systemd user service, for example:

```ini
# ~/.config/systemd/user/tagteam.service
[Unit]
Description=Rotate Claude Code between accounts

[Service]
ExecStart=%h/path/to/tagteam/src/index.ts daemon
Restart=on-failure

[Install]
WantedBy=default.target
```

## How it works

tagteam keeps the accounts in `$XDG_DATA_HOME/tagteam/accounts.json`, by default
`~/.local/share/tagteam/accounts.json`, readable only by you. A switch replaces
the login in `~/.claude/.credentials.json` and `oauthAccount` in
`~/.claude.json`, and leaves everything else, such as MCP server tokens, in
place. `CLAUDE_CONFIG_DIR` is respected.

Claude Code refreshes the tokens of the account it uses, and the refresh token
changes each time. tagteam therefore never refreshes that account itself. It
copies the account's latest tokens from Claude Code and only refreshes the
accounts Claude Code isn't using. A switch takes the same locks Claude Code
takes for a token refresh (`~/.claude/.oauth_refresh.lock`, then
`~/.claude.lock`) and for writing its config (`~/.claude.json.lock`), so it
can't land in the middle of a refresh. These were checked against Claude Code
2.1.302.

tagteam reads credentials from files, as Claude Code stores them on Linux. The
macOS Keychain isn't supported yet.

## Development

```bash
direnv allow   # or: nix develop
pnpm install
pnpm start --help
pnpm test
pnpm check     # oxlint with type checking, then oxfmt
```
