import { NodeRuntime, NodeServices } from '@effect/platform-node'
import {
  Cause,
  Console,
  Effect,
  Layer,
  Logger,
  Predicate,
  Runtime,
} from 'effect'
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
  Effect.provide(
    Layer.mergeAll(ClaudeCode.layer, Accounts.layer, Anthropic.layer).pipe(
      Layer.provideMerge(NodeServices.layer)
    )
  ),
  // Expected failures print only their message, which says what to do next.
  // Defects keep the full cause. `Command.run` marks the errors it printed
  // itself, such as an unknown flag, as already reported.
  Effect.tapCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) {
      return Effect.void
    }
    if (Cause.hasDies(cause)) {
      return Effect.logError(cause)
    }
    const error = Cause.squash(cause)
    if (!Runtime.getErrorReported(error)) {
      return Effect.void
    }
    return Console.error(
      Predicate.hasProperty(error, 'message') ? error.message : error
    )
  }),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
