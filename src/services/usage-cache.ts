import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Record,
  Schema,
} from 'effect'

import * as Login from '#/domain/login.ts'
import * as Usage from '#/domain/usage.ts'
import * as JsonFile from '#/lib/json-file.ts'
import * as Xdg from '#/lib/xdg.ts'

const UsageJson = Schema.Struct({
  accounts: Schema.Record(
    Schema.String,
    Schema.Struct({
      usage: Usage.Usage,
      checkedAt: Schema.DateTimeUtcFromString,
    })
  ),
})

/**
 * The usage last fetched for each account, so that it can still be shown
 * while Anthropic rate limits the usage endpoint.
 */
export class UsageCache extends Context.Service<UsageCache>()(
  '@tagteam/UsageCache',
  {
    make: Effect.fnUntraced(function* (directory: string) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(directory, 'usage.json')

      const read = JsonFile.read(file, UsageJson).pipe(
        Effect.map(
          Option.match({
            onNone: () => ({}),
            onSome: ({ accounts }) => accounts,
          })
        ),
        Effect.orElseSucceed((): (typeof UsageJson.Type)['accounts'] => ({})),
        Effect.catchDefect(() => Effect.succeed({})),
        Effect.provideService(FileSystem.FileSystem, fs)
      )

      const get = Effect.fn('UsageCache.get')(function* (login: Login.Login) {
        return Record.get(yield* read, Login.id(login))
      })

      // Writers don't lock the file. Two writing at once can drop the entry
      // one of them wrote, which only leaves older usage until the next check.
      const set = Effect.fn('UsageCache.set')(
        function* (login: Login.Login, usage: Usage.Usage) {
          const checkedAt = yield* DateTime.now
          const accounts = Record.set(yield* read, Login.id(login), {
            usage,
            checkedAt,
          })
          yield* fs
            .makeDirectory(directory, { recursive: true, mode: 0o700 })
            .pipe(Effect.orDie)
          yield* JsonFile.write(
            file,
            yield* Schema.encodeEffect(UsageJson)({ accounts }).pipe(
              Effect.orDie
            )
          )
        },
        Effect.catchDefect((defect) =>
          Effect.logWarning(
            `Couldn't save usage to ${file}, so \`tagteam list\` can't show it while Anthropic rate limits usage checks.`,
            defect
          )
        ),
        Effect.provideService(FileSystem.FileSystem, fs)
      )

      return { get, set }
    }),
  }
) {}

export const layer = Layer.effect(
  UsageCache,
  Effect.gen(function* () {
    const path = yield* Path.Path
    return yield* UsageCache.make(path.join(yield* Xdg.cacheHome, 'tagteam'))
  })
)
