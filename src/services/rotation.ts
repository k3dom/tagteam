import {
  Array,
  Context,
  DateTime,
  Duration,
  Effect,
  Equal,
  Match,
  Option,
  pipe,
  Record,
  Ref,
  Result,
  Schedule,
} from 'effect'

import * as Login from '#/domain/login.ts'
import * as Policy from '#/domain/policy.ts'
import type * as Usage from '#/domain/usage.ts'
import * as Accounts from '#/services/accounts.ts'
import * as Anthropic from '#/services/anthropic.ts'
import * as ClaudeCode from '#/services/claude-code.ts'

const isFresh = Effect.fnUntraced(function* (tokens: Login.Tokens) {
  return DateTime.isGreaterThan(
    DateTime.makeUnsafe(tokens.expiresAt),
    DateTime.add(yield* DateTime.now, { minutes: 5 })
  )
})

/**
 * Tokens for an account Claude Code isn't using, refreshed first when they
 * are about to expire. Only tagteam holds these tokens, so refreshing them
 * can't race with Claude Code.
 */
const tokensOf = Effect.fnUntraced(function* (login: Login.Login) {
  const claude = yield* ClaudeCode.ClaudeCode
  const accounts = yield* Accounts.Accounts
  const anthropic = yield* Anthropic.Anthropic
  if (yield* isFresh(login.credentials.claudeAiOauth)) {
    return login.credentials.claudeAiOauth
  }
  return yield* accounts.modify(
    Effect.fnUntraced(function* (stored) {
      // Another tagteam process may have switched Claude Code to this account
      // since `login` was read. Its tokens are then Claude Code's to refresh.
      const live = Option.filter(yield* claude.current(), (current) =>
        Login.sameAccount(current, login)
      )
      if (Option.isSome(live)) {
        return [live.value.credentials.claudeAiOauth, stored] as const
      }
      const current = Option.getOrElse(Login.find(stored, login), () => login)
      const tokens = current.credentials.claudeAiOauth
      if (yield* isFresh(tokens)) {
        return [tokens, stored] as const
      }
      const refreshed = yield* anthropic.refresh(tokens)
      return [
        refreshed,
        Login.replace(stored, {
          ...current,
          credentials: { ...current.credentials, claudeAiOauth: refreshed },
        }),
      ] as const
    })
  )
})

/**
 * Fetches the usage of an account. For the account Claude Code is using it
 * returns `None` once the access token has expired, since only Claude Code
 * may refresh it and does so on its next request.
 */
export const usageOf = Effect.fn('Rotation.usageOf')(function* (
  login: Login.Login,
  options: { readonly active: boolean }
) {
  const anthropic = yield* Anthropic.Anthropic
  const tokens = options.active
    ? login.credentials.claudeAiOauth
    : yield* tokensOf(login)
  if (
    !DateTime.isGreaterThan(
      DateTime.makeUnsafe(tokens.expiresAt),
      yield* DateTime.now
    )
  ) {
    return Option.none()
  }
  return Option.some(yield* anthropic.usage(tokens.accessToken))
})

export interface Settings {
  /** Percentage of a limit at which tagteam switches away from an account. */
  readonly threshold: number
  readonly interval: Duration.Input
}

interface Check {
  readonly usage: Option.Option<Usage.Usage>
  readonly checkedAt: DateTime.Utc
  readonly retryAt: DateTime.Utc
}

export class Rotation extends Context.Service<Rotation>()('@tagteam/Rotation', {
  make: Effect.fnUntraced(function* (settings: Settings) {
    const claude = yield* ClaudeCode.ClaudeCode
    const accounts = yield* Accounts.Accounts
    const services = yield* Effect.context<
      ClaudeCode.ClaudeCode | Accounts.Accounts | Anthropic.Anthropic
    >()
    const checks = yield* Ref.make<Record<string, Check>>({})
    const lastNotice = yield* Ref.make(Option.none<string>())

    const notice = Effect.fnUntraced(function* (message: string) {
      const previous = yield* Ref.getAndSet(lastNotice, Option.some(message))
      if (!Option.contains(previous, message)) {
        yield* Effect.logWarning(message)
      }
    })

    const retryDelay = Match.type<
      Effect.Error<ReturnType<typeof usageOf>>
    >().pipe(
      Match.when(
        { _tag: 'AnthropicError', reason: { _tag: 'RateLimited' } },
        ({ reason }) => reason.retryAfter ?? Duration.minutes(5)
      ),
      Match.when(
        { _tag: 'AnthropicError', reason: { _tag: 'InvalidGrant' } },
        () => Duration.hours(1)
      ),
      Match.orElse(() => Duration.fromInputUnsafe(settings.interval))
    )

    // The active account is checked on every tick. The others only change
    // when they are used elsewhere, so they are checked less often.
    const cachedUsageOf = Effect.fnUntraced(function* (
      login: Login.Login,
      active: boolean
    ) {
      const key = Login.id(login)
      const now = yield* DateTime.now
      const previous = Record.get(yield* Ref.get(checks), key)
      const known = Option.flatMap(previous, (check) => check.usage)
      const due = Option.match(previous, {
        onNone: () => true,
        onSome: (check) =>
          DateTime.isGreaterThanOrEqualTo(now, check.retryAt) &&
          (active ||
            Duration.isGreaterThanOrEqualTo(
              DateTime.distance(check.checkedAt, now),
              Duration.minutes(5)
            )),
      })
      if (!due) {
        return known
      }

      const next = yield* Result.match(
        yield* usageOf(login, { active }).pipe(
          Effect.provideContext(services),
          Effect.result
        ),
        {
          onSuccess: (usage) =>
            Effect.succeed<Check>({
              usage: Option.orElse(usage, () => known),
              checkedAt: now,
              retryAt: now,
            }),
          onFailure: Effect.fnUntraced(function* (error) {
            const delay = retryDelay(error)
            yield* Effect.logWarning(
              `Couldn't check the usage of ${Login.email(login)}. ${error.message} Checking again in ${Duration.format(delay)}.`
            )
            return {
              usage: known,
              checkedAt: Option.match(previous, {
                onNone: () => DateTime.makeUnsafe(0),
                onSome: (check) => check.checkedAt,
              }),
              retryAt: DateTime.addDuration(now, delay),
            }
          }),
        }
      )
      yield* Ref.update(checks, Record.set(key, next))
      return next.usage
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
          const usage = yield* cachedUsageOf(
            active ? live.value : login,
            active
          )
          return { login, active, usage }
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
