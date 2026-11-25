import {
  Array,
  Context,
  DateTime,
  Duration,
  Effect,
  Equal,
  Layer,
  Option,
  pipe,
  Ref,
  Schedule,
} from 'effect'

import * as Account from '#/domain/account.ts'
import * as Login from '#/domain/login.ts'
import type * as Mode from '#/domain/mode.ts'
import * as Plan from '#/domain/plan.ts'
import * as Policy from '#/domain/policy.ts'
import * as ClaudeCode from '#/lib/claude-code.ts'
import * as Accounts from '#/services/accounts.ts'
import * as UsageCache from '#/services/usage-cache.ts'

export interface Settings {
  readonly thresholds: Plan.Thresholds
  readonly interval: Duration.Input
}

export class Rotation extends Context.Service<Rotation>()('@tagteam/Rotation', {
  make: Effect.fnUntraced(function* (settings: Settings) {
    const claude = yield* ClaudeCode.ClaudeCode
    const accounts = yield* Accounts.Accounts
    const usageCache = yield* UsageCache.UsageCache
    const lastNotice = yield* Ref.make(Option.none<string>())

    const notice = Effect.fnUntraced(function* (message: string) {
      const previous = yield* Ref.getAndSet(lastNotice, Option.some(message))
      if (!Option.contains(previous, message)) {
        yield* Effect.logWarning(message)
      }
    })

    /**
     * Switches Claude Code from `live` to `target`, storing the replaced login
     * with any token refresh Claude Code made since `live` was read.
     */
    const activate = Effect.fnUntraced(function* (
      state: Accounts.State,
      target: Login.Login,
      live: Login.Login
    ) {
      const replaced = yield* claude.activate(
        Option.getOrElse(Login.find(state.accounts, target), () => target),
        live
      )
      return Option.map(replaced, (outgoing): Accounts.State => ({
        ...state,
        accounts: Login.replace(state.accounts, outgoing),
      }))
    })

    const tick = Effect.fn('Rotation.tick')(function* () {
      const live = yield* claude.current()
      if (Option.isNone(live)) {
        return yield* notice(
          "Claude Code isn't logged in, so tagteam has nothing to switch. Log in with /login in Claude Code."
        )
      }
      const managed = yield* accounts.list()
      const stored = Login.find(managed, live.value)
      if (Option.isNone(stored)) {
        return yield* notice(
          `Claude Code is logged into ${Login.email(live.value)}, which tagteam doesn't manage, so tagteam leaves it alone. Run \`tagteam add\` to add it.`
        )
      }
      // Claude Code refreshes the tokens of the account it uses. Keeping the
      // stored copy in step means the account survives a /login to another,
      // unless a switch has stored newer tokens since this tick read them.
      if (!Equal.equals(stored.value, live.value)) {
        yield* accounts.modify((state) =>
          Effect.succeed([
            undefined,
            Option.exists(Login.find(state.accounts, live.value), (current) =>
              Equal.equals(current, stored.value)
            )
              ? {
                  ...state,
                  accounts: Login.replace(state.accounts, live.value),
                }
              : state,
          ] as const)
        )
      }

      const candidates = yield* Effect.forEach(
        managed,
        Effect.fnUntraced(function* (login) {
          const active = Login.sameAccount(login, live.value)
          const current = active ? live.value : login
          const check = yield* usageCache.get(current, { active })
          return {
            login,
            active,
            usage: Option.map(check.latest, (latest) => latest.usage),
            threshold: settings.thresholds[Plan.of(current)],
          }
        })
      )
      const now = yield* DateTime.now
      const limit = pipe(
        Array.findFirst(candidates, ({ active }) => active),
        Option.flatMap(({ usage, threshold }) =>
          Option.flatMap(usage, (known) =>
            Policy.exhausted(known, threshold, now)
          )
        )
      )
      if ((yield* accounts.mode()) === 'manual') {
        if (Option.isSome(limit)) {
          return yield* notice(
            `${Login.email(live.value)} has used ${limit.value.window.utilization}% of its ${limit.value.name} limit, but automatic switching is off. Switch with \`tagteam switch\`, or turn it on with \`tagteam mode auto\`.`
          )
        }
        return yield* Ref.set(lastNotice, Option.none())
      }
      const target = Policy.choose(candidates, now)
      if (Option.isNone(target)) {
        if (Option.isSome(limit)) {
          return yield* notice(
            `Every account is near its limits, so Claude Code stays on ${Login.email(live.value)}.`
          )
        }
        return yield* Ref.set(lastNotice, Option.none())
      }

      // When Claude Code is logged into another account by now, or automatic
      // switching was turned off since this tick read the mode, nothing is
      // switched and the next tick looks again.
      const switched = yield* accounts.modify(
        Effect.fnUntraced(function* (state) {
          if (state.mode === 'manual') {
            return [false, state] as const
          }
          const next = yield* activate(state, target.value.login, live.value)
          return [
            Option.isSome(next),
            Option.getOrElse(next, () => state),
          ] as const
        })
      )
      if (!switched) {
        return
      }
      yield* Ref.set(lastNotice, Option.none())
      const reason = Option.match(limit, {
        onSome: ({ name, window }) =>
          `${Login.email(live.value)} has used ${window.utilization}% of its ${name} limit.`,
        onNone: () =>
          `${Login.email(target.value.login)} comes first and is under its limits.`,
      })
      yield* Effect.logInfo(
        `Switched Claude Code from ${Login.email(live.value)} to ${Login.email(target.value.login)}, because ${reason}`
      )
    })

    const switchTo = Effect.fn('Rotation.switchTo')(function* (
      account: string
    ) {
      const { from, to, switched } = yield* accounts
        .modify(
          Effect.fnUntraced(function* (state) {
            const target = yield* Accounts.select(state.accounts, account)
            const manual: Accounts.State = { ...state, mode: 'manual' }
            // Claude Code can log into another account between reading its
            // login and switching it, in which case the switch starts over.
            for (;;) {
              const live = yield* claude.current()
              if (Option.isNone(live)) {
                return yield* new Account.NotLoggedInError()
              }
              if (Option.isNone(Login.find(state.accounts, live.value))) {
                return yield* new Account.UnmanagedError({
                  email: Login.email(live.value),
                })
              }
              const done = (moved: boolean, next: Accounts.State) =>
                [
                  {
                    from: Login.email(live.value),
                    to: Login.email(target),
                    switched: moved,
                  },
                  next,
                ] as const
              if (Login.sameAccount(live.value, target)) {
                return done(false, manual)
              }
              const next = yield* activate(manual, target, live.value)
              if (Option.isSome(next)) {
                return done(true, next.value)
              }
            }
          })
        )
        .pipe(
          Effect.catchTags({
            ClaudeCodeError: ({ path }) =>
              new Account.ClaudeCodeConfigError({ path }),
            LockTimeoutError: ({ path }) =>
              new Account.ClaudeCodeBusyError({ path }),
          })
        )
      yield* Ref.set(lastNotice, Option.none())
      yield* Effect.logInfo(
        switched
          ? `Switched Claude Code from ${from} to ${to} with \`tagteam switch\`, and turned automatic switching off.`
          : `Turned automatic switching off with \`tagteam switch\`, so Claude Code stays on ${to}.`
      )
      return { email: to, switched }
    })

    const setMode = Effect.fn('Rotation.setMode')(function* (mode: Mode.Mode) {
      const previous = yield* accounts.modify((state) =>
        Effect.succeed([state.mode, { ...state, mode }] as const)
      )
      if (previous === mode) {
        return
      }
      yield* Ref.set(lastNotice, Option.none())
      if (mode === 'manual') {
        return yield* Effect.logInfo(
          'Turned automatic switching off, so Claude Code stays on its current account.'
        )
      }
      yield* Effect.logInfo('Turned automatic switching on.')
      yield* tick().pipe(
        Effect.catch((error) => Effect.logWarning(error.message))
      )
    })

    const run = Effect.fn('Rotation.run')(function* () {
      yield* Effect.logInfo(
        `Watching Claude Code's accounts, switching at this share of a limit: ${pipe(
          Plan.Plan.literals,
          Array.map(
            (plan) => `${settings.thresholds[plan]}% on ${Plan.label(plan)}`
          ),
          Array.join(', ')
        )}.`
      )
      if ((yield* accounts.mode()) === 'manual') {
        yield* Effect.logInfo(
          'Automatic switching is off, so Claude Code stays on the account chosen with `tagteam switch` until `tagteam mode auto` turns it on.'
        )
      }
      return yield* tick().pipe(
        Effect.catch((error) => Effect.logWarning(error.message)),
        Effect.repeat(Schedule.spaced(settings.interval))
      )
    })

    return { tick, switchTo, setMode, run }
  }),
}) {}

export const layer = (settings: Settings) =>
  Layer.effect(Rotation, Rotation.make(settings))
