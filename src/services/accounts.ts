import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from 'effect'

import * as Login from '#/domain/login.ts'
import * as JsonFile from '#/lib/json-file.ts'
import * as Lockfile from '#/lib/lockfile.ts'
import * as Xdg from '#/lib/xdg.ts'

const AccountsJson = Schema.Struct({ accounts: Schema.Array(Login.Login) })

/**
 * The managed accounts in priority order. The first one is the main account.
 */
export class Accounts extends Context.Service<Accounts>()('@tagteam/Accounts', {
  make: Effect.fnUntraced(function* (directory: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(directory, 'accounts.json')

    const read = JsonFile.read(file, AccountsJson).pipe(
      Effect.map(
        Option.match({ onNone: () => [], onSome: ({ accounts }) => accounts })
      ),
      Effect.orDie
    )

    const list = Effect.fn('Accounts.list')(
      function* () {
        return yield* read
      },
      Effect.provideService(FileSystem.FileSystem, fs)
    )

    /**
     * Replaces the accounts with what `f` returns, holding a lock so that the
     * daemon and the CLI don't overwrite each other's changes.
     */
    const modify = Effect.fn('Accounts.modify')(
      function* <A, E, R>(
        f: (
          accounts: ReadonlyArray<Login.Login>
        ) => Effect.Effect<readonly [A, ReadonlyArray<Login.Login>], E, R>
      ) {
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(Effect.orDie)
        yield* Lockfile.acquire(path.join(directory, 'accounts.lock'), {
          stale: '60 seconds',
          timeout: '1 minute',
        })
        const [result, accounts] = yield* f(yield* read)
        yield* JsonFile.write(file, { accounts }, { indent: 2 })
        return result
      },
      Effect.scoped,
      Effect.provideService(FileSystem.FileSystem, fs)
    )

    const update = Effect.fn('Accounts.update')(function* (
      f: (accounts: ReadonlyArray<Login.Login>) => ReadonlyArray<Login.Login>
    ) {
      return yield* modify((accounts) => {
        const next = f(accounts)
        return Effect.succeed([next, next] as const)
      })
    })

    return { list, modify, update }
  }),
}) {}

export const layer = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const path = yield* Path.Path
    return yield* Accounts.make(path.join(yield* Xdg.dataHome, 'tagteam'))
  })
)
