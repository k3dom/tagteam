import { Command } from 'effect/cli'

import * as Client from '#/client.ts'
import * as Accounts from '#/commands/accounts.ts'
import * as Daemon from '#/commands/daemon.ts'
import PackageJson from '#package.json' with { type: 'json' }

export const cli = Command.make('tagteam').pipe(
  Command.withDescription(PackageJson.description),
  Command.withSubcommands([
    Accounts.add.pipe(Command.provide(Client.layer)),
    Accounts.remove.pipe(Command.provide(Client.layer)),
    Accounts.main.pipe(Command.provide(Client.layer)),
    Accounts.list.pipe(Command.provide(Client.layer)),
    Daemon.command,
  ])
)
