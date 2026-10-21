import {
  Array,
  Clock,
  DateTime,
  Duration,
  Effect,
  Equal,
  Match,
  Option,
  pipe,
  Ref,
  Result,
  Schedule,
} from 'effect'

import * as Accounts from '#/Accounts.ts'
import * as Anthropic from '#/Anthropic.ts'
import * as ClaudeCode from '#/ClaudeCode.ts'

export interface Limit {
  readonly name: '5-hour' | 'weekly'
  readonly window: Anthropic.Window
}

/**
 * The first limit that `usage` has used up to `threshold` percent and that
 * hasn't reset since.
 */
export const exhausted = (
  usage: Anthropic.Usage,
  threshold: number,
  now: DateTime.Utc
): Option.Option<Limit> =>
  pipe(
    [
      { name: '5-hour' as const, window: usage.fiveHour },
      { name: 'weekly' as const, window: usage.sevenDay },
    ],
    Array.findFirst(
      (limit): limit is Limit =>
        limit.window !== null &&
        limit.window.utilization >= threshold &&
        (limit.window.resetsAt === null ||
          DateTime.isGreaterThan(limit.window.resetsAt, now))
    )
  )

/**
 * Picks the account Claude Code should switch to, given each account's usage
 * in priority order: the first one under its limits. An account whose usage
 * is unknown only counts as under its limits while it is active, so that
 * tagteam never switches to an account it couldn't check.
 */
export const choose = (
  candidates: ReadonlyArray<{
    readonly active: boolean
    readonly usage: Option.Option<Anthropic.Usage>
  }>,
  threshold: number,
  now: DateTime.Utc
): Option.Option<number> =>
  pipe(
    Array.findFirstIndex(candidates, ({ active, usage }) =>
      Option.match(usage, {
        onNone: () => active,
        onSome: (known) => Option.isNone(exhausted(known, threshold, now)),
      })
    ),
    Option.filter((index) => candidates[index]?.active === false)
  )

const replace = (
  accounts: ReadonlyArray<ClaudeCode.Login>,
  login: ClaudeCode.Login
): ReadonlyArray<ClaudeCode.Login> =>
  Array.map(accounts, (account) =>
    ClaudeCode.id(account) === ClaudeCode.id(login) ? login : account
  )

const isFresh = (tokens: ClaudeCode.Tokens) =>
  Effect.map(
    Clock.currentTimeMillis,
    (now) => tokens.expiresAt - Duration.toMillis('5 minutes') > now
  )

/**
 * Tokens for an account Claude Code isn't using, refreshed first when they
 * are about to expire. Only tagteam holds these tokens, so refreshing them
 * can't race with Claude Code.
 */
const tokensOf = Effect.fnUntraced(function* (login: ClaudeCode.Login) {
  const accounts = yield* Accounts.Accounts
  const anthropic = yield* Anthropic.Anthropic
  if (yield* isFresh(login.credentials.claudeAiOauth)) {
    return login.credentials.claudeAiOauth
  }
  return yield* accounts.modify(
    Effect.fnUntraced(function* (stored) {
      const current = pipe(
        Array.findFirst(
          stored,
          (account) => ClaudeCode.id(account) === ClaudeCode.id(login)
        ),
        Option.getOrElse(() => login)
      )
      const tokens = current.credentials.claudeAiOauth
      if (yield* isFresh(tokens)) {
        return [tokens, stored] as const
      }
      const refreshed = yield* anthropic.refresh(tokens)
      return [
        refreshed,
        replace(stored, {
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
  if (tokens.expiresAt <= (yield* Clock.currentTimeMillis)) {
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
  readonly checkedAt: number
  readonly retryAt: number
}

export const make = Effect.fnUntraced(function* (settings: Settings) {
  const claude = yield* ClaudeCode.ClaudeCode
  const accounts = yield* Accounts.Accounts
  const checks = yield* Ref.make<Record<string, Check>>({})
  const lastNotice = yield* Ref.make(Option.none<string>())

  const notice = Effect.fnUntraced(function* (message: string) {
    const previous = yield* Ref.getAndSet(lastNotice, Option.some(message))
    if (!Option.contains(previous, message)) {
      yield* Effect.logWarning(message)
    }
  })

  // The active account is checked on every tick. The others only change when
  // they are used elsewhere, so they are checked less often.
  const cachedUsageOf = Effect.fnUntraced(function* (
    login: ClaudeCode.Login,
    active: boolean
  ) {
    const key = ClaudeCode.id(login)
    const now = yield* Clock.currentTimeMillis
    const previous = Option.fromNullishOr((yield* Ref.get(checks))[key])
    const due = Option.match(previous, {
      onNone: () => true,
      onSome: (check) =>
        now >= check.retryAt &&
        (active || now - check.checkedAt >= Duration.toMillis('5 minutes')),
    })
    if (!due) {
      return Option.flatMap(previous, (check) => check.usage)
    }

    const known = Option.flatMap(previous, (check) => check.usage)
    const result = yield* Effect.result(usageOf(login, { active }))
    const next = yield* Result.match(result, {
      onSuccess: (usage) =>
        Effect.succeed<Check>({
          usage: Option.orElse(usage, () => known),
          checkedAt: now,
          retryAt: now,
        }),
      onFailure: (error) =>
        Effect.as(
          Effect.logWarning(
            `Couldn't check the usage of ${ClaudeCode.email(login)}. ${error.message}`
          ),
          {
            usage: known,
            checkedAt: Option.match(previous, {
              onNone: () => 0,
              onSome: (check) => check.checkedAt,
            }),
            retryAt:
              now +
              Match.value(error).pipe(
                Match.when(
                  {
                    _tag: 'AnthropicError',
                    reason: { _tag: 'RateLimited' },
                  },
                  ({ reason }) => (reason.retryAfterSeconds ?? 300) * 1000
                ),
                Match.when(
                  { _tag: 'AnthropicError', reason: { _tag: 'InvalidGrant' } },
                  () => Duration.toMillis('1 hour')
                ),
                Match.orElse(() => Duration.toMillis(settings.interval))
              ),
          }
        ),
    })
    yield* Ref.update(checks, (all) => ({ ...all, [key]: next }))
    return next.usage
  })

  const tick = Effect.fn('Rotation.tick')(function* () {
    const live = yield* claude.current()
    if (Option.isNone(live)) {
      return yield* notice(
        "Claude Code isn't logged in, so tagteam has nothing to switch. Log in with /login in Claude Code."
      )
    }
    const isActive = (login: ClaudeCode.Login) =>
      ClaudeCode.id(login) === ClaudeCode.id(live.value)

    const managed = yield* accounts.list()
    const stored = Array.findFirst(managed, isActive)
    if (Option.isNone(stored)) {
      return yield* notice(
        `Claude Code is logged into ${ClaudeCode.email(live.value)}, which tagteam doesn't manage, so tagteam leaves it alone. Run \`tagteam add\` to add it.`
      )
    }
    // Claude Code refreshes the tokens of the account it uses. Keeping the
    // stored copy in step means the account survives a /login to another one.
    if (!Equal.equals(stored.value, live.value)) {
      yield* accounts.modify((all) =>
        Effect.succeed([undefined, replace(all, live.value)] as const)
      )
    }

    const candidates = yield* Effect.forEach(managed, (login) =>
      Effect.map(
        isActive(login)
          ? cachedUsageOf(live.value, true)
          : cachedUsageOf(login, false),
        (usage) => ({ login, active: isActive(login), usage })
      )
    )
    const now = yield* DateTime.now
    const limit = pipe(
      Array.findFirst(candidates, ({ active }) => active),
      Option.flatMap(({ usage }) => usage),
      Option.flatMap((usage) => exhausted(usage, settings.threshold, now))
    )
    const target = pipe(
      choose(candidates, settings.threshold, now),
      Option.flatMap((index) => Array.get(candidates, index))
    )
    if (Option.isNone(target)) {
      if (Option.isSome(limit)) {
        return yield* notice(
          `Every account is near its limits, so Claude Code stays on ${ClaudeCode.email(live.value)}.`
        )
      }
      return yield* Ref.set(lastNotice, Option.none())
    }

    yield* accounts.modify(
      Effect.fnUntraced(function* (all) {
        const login = pipe(
          Array.findFirst(
            all,
            (account) =>
              ClaudeCode.id(account) === ClaudeCode.id(target.value.login)
          ),
          Option.getOrElse(() => target.value.login)
        )
        // The replaced login includes any token refresh Claude Code made since
        // this tick read it.
        const replaced = yield* claude.activate(login)
        return [
          undefined,
          Option.match(replaced, {
            onNone: () => all,
            onSome: (outgoing) => replace(all, outgoing),
          }),
        ] as const
      })
    )
    yield* Ref.set(lastNotice, Option.none())
    yield* Effect.logInfo(
      `Switched Claude Code from ${ClaudeCode.email(live.value)} to ${ClaudeCode.email(target.value.login)}, because ${Option.match(
        limit,
        {
          onSome: ({ name, window }) =>
            `${ClaudeCode.email(live.value)} has used ${window.utilization}% of its ${name} limit.`,
          onNone: () =>
            `${ClaudeCode.email(target.value.login)} comes first and is under its limits.`,
        }
      )}`
    )
  })

  return { tick }
})

export const run = Effect.fn('Rotation.run')(function* (settings: Settings) {
  const { tick } = yield* make(settings)
  yield* Effect.logInfo(
    `Watching Claude Code's accounts, switching at ${settings.threshold}% of a limit.`
  )
  return yield* tick().pipe(
    Effect.catch((error) => Effect.logWarning(error.message)),
    Effect.repeat(Schedule.spaced(settings.interval))
  )
})
