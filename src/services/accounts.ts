import {
  Array,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Number,
  Option,
  Path,
  pipe,
  Schema,
  SynchronizedRef,
} from 'effect'

import * as Account from '#/domain/account.ts'
import * as Login from '#/domain/login.ts'
import * as ClaudeCode from '#/lib/claude-code.ts'
import * as JsonFile from '#/lib/json-file.ts'
import * as Xdg from '#/lib/xdg.ts'

const AccountsJson = Schema.Struct({ accounts: Schema.Array(Login.Login) })

/** The account a user named by its number in `tagteam list` or its email. */
const select = (
  logins: ReadonlyArray<Login.Login>,
  account: string
): Effect.Effect<Login.Login, Account.NotFoundError> =>
  pipe(
    Number.parse(account),
    Option.flatMap((position) => Array.get(logins, position - 1)),
    Option.orElse(() =>
      Array.findFirst(logins, (login) => Login.email(login) === account)
    ),
    Effect.fromOption,
    Effect.mapError(() => new Account.NotFoundError({ account }))
  )

/**
 * The managed accounts in priority order. The first one is the main account.
 * The daemon is their only writer, so it keeps them in memory and writes
 * every change through to `accounts.json`.
 */
export class Accounts extends Context.Service<Accounts>()('@tagteam/Accounts', {
  make: Effect.fnUntraced(function* (directory: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const claude = yield* ClaudeCode.ClaudeCode
    const file = path.join(directory, 'accounts.json')
    const stored = yield* SynchronizedRef.make(
      yield* JsonFile.read(file, AccountsJson).pipe(
        Effect.map(
          Option.match({
            onNone: (): ReadonlyArray<Login.Login> => [],
            onSome: ({ accounts }) => accounts,
          })
        ),
        Effect.orDie
      )
    )

    const list = Effect.fn('Accounts.list')(function* () {
      return yield* SynchronizedRef.get(stored)
    })

    /** Replaces the accounts with what `f` returns, one change at a time. */
    const modify = Effect.fn('Accounts.modify')(function* <A, E, R>(
      f: (
        accounts: ReadonlyArray<Login.Login>
      ) => Effect.Effect<readonly [A, ReadonlyArray<Login.Login>], E, R>
    ) {
      return yield* SynchronizedRef.modifyEffect(
        stored,
        Effect.fnUntraced(
          function* (accounts) {
            const [result, next] = yield* f(accounts)
            yield* fs
              .makeDirectory(directory, { recursive: true, mode: 0o700 })
              .pipe(Effect.orDie)
            yield* JsonFile.write(file, { accounts: next }, { indent: 2 })
            return [result, next] as const
          },
          Effect.provideService(FileSystem.FileSystem, fs)
        )
      )
    })

    const update = Effect.fn('Accounts.update')(function* (
      f: (accounts: ReadonlyArray<Login.Login>) => ReadonlyArray<Login.Login>
    ) {
      return yield* modify((accounts) => {
        const next = f(accounts)
        return Effect.succeed([next, next] as const)
      })
    })

    const add = Effect.fn('Accounts.add')(function* (options: {
      readonly main: boolean
    }) {
      const live = yield* claude
        .current()
        .pipe(
          Effect.catchTag(
            'ClaudeCodeError',
            (error) => new Account.ClaudeCodeConfigError({ path: error.path })
          )
        )
      if (Option.isNone(live)) {
        return yield* new Account.NotLoggedInError()
      }
      const login = live.value
      return yield* modify((all) => {
        const known = Option.isSome(Login.find(all, login))
        const next = Match.value({ main: options.main, known }).pipe(
          Match.when({ main: true }, () =>
            Array.prepend(Login.remove(all, login), login)
          ),
          Match.when({ known: true }, () => Login.replace(all, login)),
          Match.orElse(() => Array.append(all, login))
        )
        const position = pipe(
          Array.findFirstIndex(next, (other) =>
            Login.sameAccount(other, login)
          ),
          Option.getOrElse(() => 0),
          Number.increment
        )
        return Effect.succeed([
          { email: Login.email(login), position, added: !known },
          next,
        ] as const)
      })
    })

    const remove = Effect.fn('Accounts.remove')(function* (account: string) {
      return yield* modify(
        Effect.fnUntraced(function* (all) {
          const login = yield* select(all, account)
          return [
            { email: Login.email(login) },
            Login.remove(all, login),
          ] as const
        })
      )
    })

    const makeMain = Effect.fn('Accounts.makeMain')(function* (
      account: string
    ) {
      return yield* modify(
        Effect.fnUntraced(function* (all) {
          const login = yield* select(all, account)
          return [
            { email: Login.email(login) },
            Array.prepend(Login.remove(all, login), login),
          ] as const
        })
      )
    })

    return { list, modify, update, add, remove, makeMain }
  }),
}) {}

export const layer = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const path = yield* Path.Path
    return yield* Accounts.make(path.join(yield* Xdg.dataHome, 'tagteam'))
  })
)
