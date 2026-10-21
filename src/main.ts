import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Cause, Console, Effect, Logger, Predicate, Runtime } from 'effect'
import { Command } from 'effect/cli'

import * as Cli from '#/cli.ts'
import PackageJson from '#package.json' with { type: 'json' }

Cli.cli.pipe(
  Command.run({ version: PackageJson.version }),
  Effect.provide(NodeServices.layer),
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
