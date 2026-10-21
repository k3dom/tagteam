import { Effect, Layer } from 'effect'

import * as Api from '#/api/api.ts'
import * as Server from '#/app/server.ts'
import * as Anthropic from '#/lib/anthropic.ts'
import * as ClaudeCode from '#/lib/claude-code.ts'
import * as Accounts from '#/services/accounts.ts'
import * as Rotation from '#/services/rotation.ts'
import * as UsageCache from '#/services/usage-cache.ts'

/** Serves the API and rotates Claude Code's accounts until interrupted. */
export const run = Effect.fn('Daemon.run')(function* (
  settings: Rotation.Settings
) {
  const socket = yield* Api.socket
  return yield* Effect.gen(function* () {
    const rotation = yield* Rotation.Rotation
    return yield* rotation.run()
  }).pipe(
    Effect.provide(
      Server.layer(socket).pipe(
        Layer.provideMerge(Rotation.layer(settings)),
        Layer.provideMerge(UsageCache.layer(settings)),
        Layer.provideMerge(Accounts.layer),
        Layer.provideMerge(Layer.mergeAll(ClaudeCode.layer, Anthropic.layer))
      )
    )
  )
})
