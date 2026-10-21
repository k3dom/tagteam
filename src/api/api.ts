import { Effect, Option, Path } from 'effect'
import { HttpApi, OpenApi } from 'effect/http-api'

import * as Accounts from '#/api/accounts.ts'
import * as Xdg from '#/lib/xdg.ts'

export class Api extends HttpApi.make('tagteam')
  .add(Accounts.Group)
  .annotate(
    OpenApi.Description,
    "Manage the accounts of tagteam's daemon, which rotates Claude Code between them"
  ) {}

/**
 * The Unix socket the daemon serves the API at, in `$XDG_RUNTIME_DIR`, or in
 * tagteam's data directory where that isn't set.
 */
export const socket = Effect.gen(function* () {
  const path = yield* Path.Path
  const runtimeDir = yield* Xdg.runtimeDir
  const directory = Option.isSome(runtimeDir)
    ? runtimeDir.value
    : path.join(yield* Xdg.dataHome, 'tagteam')
  return path.join(directory, 'tagteam.sock')
})
