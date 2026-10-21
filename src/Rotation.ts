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

import * as Accounts from '#/Accounts.ts'
import * as Anthropic from '#/Anthropic.ts'
import * as ClaudeCode from '#/ClaudeCode.ts'

interface Limit {
  readonly name: '5-hour' | 'weekly'
  readonly window: Anthropic.Window
}

const exhausted = (
  usage: Anthropic.Usage,
  threshold: number,
  now: DateTime.Utc
): Option.Option<Limit> =>
  Array.findFirst(
    [
      { name: '5-hour' as const, window: usage.fiveHour },
      { name: 'weekly' as const, window: usage.sevenDay },
    ],
    (limit): limit is Limit =>
      limit.window !== null &&
      limit.window.utilization >= threshold &&
      (limit.window.resetsAt === null ||
        DateTime.isGreaterThan(limit.window.resetsAt, now))
  )

interface Candidate {
  readonly login: ClaudeCode.Login
  readonly active: boolean
  readonly usage: Option.Option<Anthropic.Usage>
}

/**
 * The account Claude Code should switch to: the first one in priority order
 * that is under its limits. An account whose usage is unknown only counts as
 * under its limits while it is active, so that tagteam never switches to an
 * account it couldn't check.
 */
const choose = (
  candidates: ReadonlyArray<Candidate>,
  threshold: number,
  now: DateTime.Utc
): Option.Option<Candidate> =>
  pipe(
    Array.findFirst(candidates, ({ active, usage }) =>
      Option.match(usage, {
        onNone: () => active,
        onSome: (known) => Option.isNone(exhausted(known, threshold, now)),
      })
    ),
    Option.filter(({ active }) => !active)
  )

const isFresh = Effect.fnUntraced(function* (tokens: ClaudeCode.Tokens) {
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
const tokensOf = Effect.fnUntraced(function* (login: ClaudeCode.Login) {
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
        ClaudeCode.sameAccount(current, login)
      )
      if (Option.isSome(live)) {
        return [live.value.credentials.claudeAiOauth, stored] as const
      }
      const current = Option.getOrElse(
        Accounts.find(stored, login),
        () => login
      )
      const tokens = current.credentials.claudeAiOauth
      if (yield* isFresh(tokens)) {
        return [tokens, stored] as const
      }
      const refreshed = yield* anthropic.refresh(tokens)
      return [
        refreshed,
        Accounts.replace(stored, {
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
  login: ClaudeCode.Login,
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
  readonly usage: Option.Option<Anthropic.Usage>
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
      login: ClaudeCode.Login,
      active: boolean
    ) {
      const key = ClaudeCode.id(login)
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
              `Couldn't check the usage of ${ClaudeCode.email(login)}. ${error.message} Checking again in ${Duration.format(delay)}.`
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
      const stored = Accounts.find(managed, live.value)
      if (Option.isNone(stored)) {
        return yield* notice(
          `Claude Code is logged into ${ClaudeCode.email(live.value)}, which tagteam doesn't manage, so tagteam leaves it alone. Run \`tagteam add\` to add it.`
        )
      }
      // Claude Code refreshes the tokens of the account it uses. Keeping the
      // stored copy in step means the account survives a /login to another.
      if (!Equal.equals(stored.value, live.value)) {
        yield* accounts.update((all) => Accounts.replace(all, live.value))
      }

      const candidates = yield* Effect.forEach(
        managed,
        Effect.fnUntraced(function* (login) {
          const active = ClaudeCode.sameAccount(login, live.value)
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
        Option.flatMap((usage) => exhausted(usage, settings.threshold, now))
      )
      const target = choose(candidates, settings.threshold, now)
      if (Option.isNone(target)) {
        if (Option.isSome(limit)) {
          return yield* notice(
            `Every account is near its limits, so Claude Code stays on ${ClaudeCode.email(live.value)}.`
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
              Accounts.find(all, target.value.login),
              () => target.value.login
            ),
            live.value
          )
          return [
            Option.isSome(replaced),
            Option.match(replaced, {
              onNone: () => all,
              onSome: (outgoing) => Accounts.replace(all, outgoing),
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
          `${ClaudeCode.email(live.value)} has used ${window.utilization}% of its ${name} limit.`,
        onNone: () =>
          `${ClaudeCode.email(target.value.login)} comes first and is under its limits.`,
      })
      yield* Effect.logInfo(
        `Switched Claude Code from ${ClaudeCode.email(live.value)} to ${ClaudeCode.email(target.value.login)}, because ${reason}`
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
