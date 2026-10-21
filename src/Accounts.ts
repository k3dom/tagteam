import {
  Array,
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

/** The stored login of `login`'s account. */
export const find = (
  accounts: ReadonlyArray<ClaudeCode.Login>,
  login: ClaudeCode.Login
): Option.Option<ClaudeCode.Login> =>
  Array.findFirst(accounts, (account) => ClaudeCode.sameAccount(account, login))

/** Replaces the stored login of `login`'s account with `login`. */
export const replace = (
  accounts: ReadonlyArray<ClaudeCode.Login>,
  login: ClaudeCode.Login
): ReadonlyArray<ClaudeCode.Login> =>
  Array.map(accounts, (account) =>
    ClaudeCode.sameAccount(account, login) ? login : account
  )

export const remove = (
  accounts: ReadonlyArray<ClaudeCode.Login>,
  login: ClaudeCode.Login
): ReadonlyArray<ClaudeCode.Login> =>
  Array.filter(accounts, (account) => !ClaudeCode.sameAccount(account, login))

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

    const write = Effect.fnUntraced(function* (
      accounts: ReadonlyArray<ClaudeCode.Login>
    ) {
      const temporary = `${file}.tmp`
      yield* fs.writeFileString(
        temporary,
        JSON.stringify({ accounts }, null, 2),
        { mode: 0o600 }
      )
      yield* fs.rename(temporary, file)
    }, Effect.orDie)

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
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      const [result, accounts] = yield* f(yield* read)
      yield* write(accounts)
      return result
    }, Effect.scoped)

    const update = Effect.fn('Accounts.update')(function* (
      f: (
        accounts: ReadonlyArray<ClaudeCode.Login>
      ) => ReadonlyArray<ClaudeCode.Login>
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
