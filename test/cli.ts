import { ConfigProvider, Effect, Layer, Path } from 'effect'
import { Command } from 'effect/cli'
import { TestConsole } from 'effect/testing'

import * as Cli from '#/cli.ts'

/**
 * Runs `tagteam` with `args` against the daemon listening at `socket`, and
 * returns its exit with what it printed.
 */
export const run = Effect.fnUntraced(
  function* (socket: string, args: ReadonlyArray<string>) {
    const path = yield* Path.Path
    const exit = yield* Command.runWith(Cli.cli, { version: '0.0.0' })(
      args
    ).pipe(
      Effect.exit,
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            XDG_RUNTIME_DIR: path.dirname(socket),
          })
        )
      )
    )
    return { exit, stdout: yield* TestConsole.logLines }
  },
  Effect.provide(Layer.fresh(TestConsole.layer))
)
