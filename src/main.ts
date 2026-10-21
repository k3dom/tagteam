import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Console, Effect, Layer } from 'effect'
import { Command } from 'effect/cli'

import * as Add from '#/commands/add.ts'
import * as Daemon from '#/commands/daemon.ts'
import * as List from '#/commands/list.ts'
import * as Main from '#/commands/main.ts'
import * as Remove from '#/commands/remove.ts'
import * as Accounts from '#/services/accounts.ts'
import * as Anthropic from '#/services/anthropic.ts'
import * as ClaudeCode from '#/services/claude-code.ts'
import PackageJson from '#package.json' with { type: 'json' }

const report = Effect.fnUntraced(function* (error: Error) {
  yield* Console.error(error.message)
  yield* Effect.sync(() => {
    process.exitCode = 1
  })
})

Command.make('tagteam').pipe(
  Command.withDescription(PackageJson.description),
  Command.withSubcommands([
    Add.command,
    Remove.command,
    Main.command,
    List.command,
    Daemon.command,
  ]),
  Command.run({ version: PackageJson.version }),
  Effect.catchTag(
    [
      'NotLoggedInError',
      'AccountNotFoundError',
      'ClaudeCodeError',
      'LockTimeoutError',
    ],
    report
  ),
  Effect.provide(
    Layer.mergeAll(ClaudeCode.layer, Accounts.layer, Anthropic.layer).pipe(
      Layer.provideMerge(NodeServices.layer)
    )
  ),
  NodeRuntime.runMain
)
