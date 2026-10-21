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

import * as Login from '#/domain/login.ts'
import * as Policy from '#/domain/policy.ts'
import * as ClaudeCode from '#/lib/claude-code.ts'
import * as Accounts from '#/services/accounts.ts'
import * as UsageCache from '#/services/usage-cache.ts'

export interface Settings {
  /** Percentage of a limit at which tagteam switches away from an account. */
  readonly threshold: number
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
      // stored copy in step means the account survives a /login to another.
      if (!Equal.equals(stored.value, live.value)) {
        yield* accounts.update((all) => Login.replace(all, live.value))
      }

      const candidates = yield* Effect.forEach(
        managed,
        Effect.fnUntraced(function* (login) {
          const active = Login.sameAccount(login, live.value)
          const check = yield* usageCache.get(active ? live.value : login, {
            active,
          })
          return {
            login,
            active,
            usage: Option.map(check.latest, (latest) => latest.usage),
          }
        })
      )
      const now = yield* DateTime.now
      const limit = pipe(
        Array.findFirst(candidates, ({ active }) => active),
        Option.flatMap(({ usage }) => usage),
        Option.flatMap((usage) =>
          Policy.exhausted(usage, settings.threshold, now)
        )
      )
      const target = Policy.choose(candidates, settings.threshold, now)
      if (Option.isNone(target)) {
        if (Option.isSome(limit)) {
          return yield* notice(
            `Every account is near its limits, so Claude Code stays on ${Login.email(live.value)}.`
          )
        }
        return yield* Ref.set(lastNotice, Option.none())
      }

      // The replaced login includes any token refresh Claude Code made since
      // this tick read it. When Claude Code is logged into another account by
      // now, nothing is switched and the next tick looks again.
      const switched = yield* accounts.modify(
        Effect.fnUntraced(function* (all) {
          const replaced = yield* claude.activate(
            Option.getOrElse(
              Login.find(all, target.value.login),
              () => target.value.login
            ),
            live.value
          )
          return [
            Option.isSome(replaced),
            Option.match(replaced, {
              onNone: () => all,
              onSome: (outgoing) => Login.replace(all, outgoing),
            }),
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

    const run = Effect.fn('Rotation.run')(function* () {
      yield* Effect.logInfo(
        `Watching Claude Code's accounts, switching at ${settings.threshold}% of a limit.`
      )
      return yield* tick().pipe(
        Effect.catch((error) => Effect.logWarning(error.message)),
        Effect.repeat(Schedule.spaced(settings.interval))
      )
    })

    return { tick, run }
  }),
}) {}

export const layer = (settings: Settings) =>
  Layer.effect(Rotation, Rotation.make(settings))
