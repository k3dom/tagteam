import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from 'effect'

import * as ClaudeCode from '#/ClaudeCode.ts'
import * as Lockfile from '#/Lockfile.ts'

const AccountsJson = Schema.fromJsonString(
  Schema.Struct({ accounts: Schema.Array(ClaudeCode.Login) })
)

/**
 * The managed accounts in priority order. The first one is the main account.
 */
export class Accounts extends Context.Service<Accounts>()('@tagteam/Accounts', {
  make: Effect.fnUntraced(function* (directory: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(directory, 'accounts.json')

    const read = fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AccountsJson)),
      Effect.map(({ accounts }) => accounts),
      Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed([])),
      Effect.orDie
    )

    const list = Effect.fn('Accounts.list')(function* () {
      return yield* read
    })

    /**
     * Replaces the accounts with what `f` returns, holding a lock so that the
     * daemon and the CLI don't overwrite each other's changes.
     */
    const modify = Effect.fn('Accounts.modify')(function* <A, E, R>(
      f: (
        accounts: ReadonlyArray<ClaudeCode.Login>
      ) => Effect.Effect<readonly [A, ReadonlyArray<ClaudeCode.Login>], E, R>
    ) {
      yield* fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.orDie)
      yield* Lockfile.acquire(path.join(directory, 'accounts.lock'), {
        stale: '60 seconds',
        timeout: '1 minute',
      })
      const [result, accounts] = yield* f(yield* read)
      const temporary = `${file}.tmp`
      yield* fs
        .writeFileString(temporary, JSON.stringify({ accounts }, null, 2), {
          mode: 0o600,
        })
        .pipe(Effect.andThen(fs.rename(temporary, file)), Effect.orDie)
      return result
    }, Effect.scoped)

    return { list, modify }
  }),
}) {}

export const layer = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { home, dataHome } = yield* Config.all({
      home: Config.String('HOME'),
      dataHome: Config.option(Config.String('XDG_DATA_HOME')),
    })
    return yield* Accounts.make(
      path.join(
        Option.getOrElse(dataHome, () => path.join(home, '.local', 'share')),
        'tagteam'
      )
    )
  })
)
