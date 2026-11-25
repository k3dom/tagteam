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
import * as Mode from '#/domain/mode.ts'
import * as ClaudeCode from '#/lib/claude-code.ts'
import * as JsonFile from '#/lib/json-file.ts'
import * as Xdg from '#/lib/xdg.ts'

/**
 * What the daemon stores: the managed accounts in priority order, the first
 * one being the main account, and whether it switches between them by itself.
 */
export const State = Schema.Struct({
  accounts: Schema.Array(Login.Login),
  mode: Mode.Mode.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('auto' as const))
  ),
})
export type State = typeof State.Type

/** The account a user named by its number in `tagteam list` or its email. */
export const select = (
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
 * The daemon's stored state. The daemon is its only writer, so it keeps it in
 * memory and writes every change through to `accounts.json`.
 */
export class Accounts extends Context.Service<Accounts>()('@tagteam/Accounts', {
  make: Effect.fnUntraced(function* (directory: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const claude = yield* ClaudeCode.ClaudeCode
    const file = path.join(directory, 'accounts.json')
    const stored = yield* SynchronizedRef.make<State>(
      yield* JsonFile.read(file, State).pipe(
        Effect.map(
          Option.getOrElse((): State => ({ accounts: [], mode: 'auto' }))
        ),
        Effect.orDie
      )
    )

    const list = Effect.fn('Accounts.list')(function* () {
      return (yield* SynchronizedRef.get(stored)).accounts
    })

    const mode = Effect.fn('Accounts.mode')(function* () {
      return (yield* SynchronizedRef.get(stored)).mode
    })

    /** Replaces the state with what `f` returns, one change at a time. */
    const modify = Effect.fn('Accounts.modify')(function* <A, E, R>(
      f: (state: State) => Effect.Effect<readonly [A, State], E, R>
    ) {
      return yield* SynchronizedRef.modifyEffect(
        stored,
        Effect.fnUntraced(
          function* (state) {
            const [result, next] = yield* f(state)
            yield* fs
              .makeDirectory(directory, { recursive: true, mode: 0o700 })
              .pipe(Effect.orDie)
            yield* JsonFile.write(file, next, { indent: 2 })
            return [result, next] as const
          },
          Effect.provideService(FileSystem.FileSystem, fs)
        )
      )
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
      return yield* modify((state) => {
        const all = state.accounts
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
          { ...state, accounts: next },
        ] as const)
      })
    })

    const remove = Effect.fn('Accounts.remove')(function* (account: string) {
      return yield* modify(
        Effect.fnUntraced(function* (state) {
          const login = yield* select(state.accounts, account)
          return [
            { email: Login.email(login) },
            { ...state, accounts: Login.remove(state.accounts, login) },
          ] as const
        })
      )
    })

    const makeMain = Effect.fn('Accounts.makeMain')(function* (
      account: string
    ) {
      return yield* modify(
        Effect.fnUntraced(function* (state) {
          const login = yield* select(state.accounts, account)
          return [
            { email: Login.email(login) },
            {
              ...state,
              accounts: Array.prepend(
                Login.remove(state.accounts, login),
                login
              ),
            },
          ] as const
        })
      )
    })

    return { list, mode, modify, add, remove, makeMain }
  }),
}) {}

export const layer = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const path = yield* Path.Path
    return yield* Accounts.make(path.join(yield* Xdg.dataHome, 'tagteam'))
  })
)
