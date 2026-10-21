import {
  Context,
  Layer,
  DateTime,
  Duration,
  Effect,
  Match,
  Option,
  Record,
  Result,
  SynchronizedRef,
} from 'effect'

import * as Account from '#/domain/account.ts'
import * as Login from '#/domain/login.ts'
import type * as Usage from '#/domain/usage.ts'
import * as Anthropic from '#/lib/anthropic.ts'
import * as ClaudeCode from '#/lib/claude-code.ts'
import * as Accounts from '#/services/accounts.ts'

const isFresh = Effect.fnUntraced(function* (tokens: Login.Tokens) {
  return DateTime.isGreaterThan(
    DateTime.makeUnsafe(tokens.expiresAt),
    DateTime.add(yield* DateTime.now, { minutes: 5 })
  )
})

/**
 * Keeps the latest usage of every account in memory, so that the rotation and
 * `tagteam list` share one budget of usage requests, which Anthropic rate
 * limits hard. The active account is checked at most once per interval and
 * the others at most every five minutes, since they only change when they are
 * used elsewhere.
 */
export class UsageCache extends Context.Service<UsageCache>()(
  '@tagteam/UsageCache',
  {
    make: Effect.fnUntraced(function* (settings: {
      readonly interval: Duration.Input
    }) {
      const claude = yield* ClaudeCode.ClaudeCode
      const accounts = yield* Accounts.Accounts
      const anthropic = yield* Anthropic.Anthropic
      const interval = Duration.fromInputUnsafe(settings.interval)
      const checks = yield* SynchronizedRef.make<Record<string, Usage.Check>>(
        {}
      )

      /**
       * Tokens for an account Claude Code isn't using, refreshed first when
       * they are about to expire. Only tagteam holds these tokens, so
       * refreshing them can't race with Claude Code.
       */
      const tokensOf = Effect.fnUntraced(function* (login: Login.Login) {
        if (yield* isFresh(login.credentials.claudeAiOauth)) {
          return login.credentials.claudeAiOauth
        }
        return yield* accounts.modify(
          Effect.fnUntraced(function* (stored) {
            // The rotation may have switched Claude Code to this account since
            // `login` was read. Its tokens are then Claude Code's to refresh.
            const live = Option.filter(yield* claude.current(), (current) =>
              Login.sameAccount(current, login)
            )
            if (Option.isSome(live)) {
              return [live.value.credentials.claudeAiOauth, stored] as const
            }
            const current = Option.getOrElse(
              Login.find(stored, login),
              () => login
            )
            const tokens = current.credentials.claudeAiOauth
            if (yield* isFresh(tokens)) {
              return [tokens, stored] as const
            }
            const refreshed = yield* anthropic.refresh(tokens)
            return [
              refreshed,
              Login.replace(stored, {
                ...current,
                credentials: {
                  ...current.credentials,
                  claudeAiOauth: refreshed,
                },
              }),
            ] as const
          })
        )
      })

      /**
       * Fetches the usage of an account. For the account Claude Code is using
       * it returns `None` once the access token has expired, since only Claude
       * Code may refresh it and does so on its next request.
       */
      const fetch = Effect.fnUntraced(function* (
        login: Login.Login,
        active: boolean
      ) {
        const tokens = active
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

      const retryDelay = Match.type<
        Effect.Error<ReturnType<typeof fetch>>
      >().pipe(
        Match.when(
          { _tag: 'AnthropicError', reason: { _tag: 'RateLimited' } },
          ({ reason }) => reason.retryAfter ?? Duration.minutes(5)
        ),
        Match.when(
          { _tag: 'AnthropicError', reason: { _tag: 'InvalidGrant' } },
          () => Duration.hours(1)
        ),
        Match.orElse(() => interval)
      )

      /**
       * The usage of `login`, checked again only once the cached check is due.
       * Checks run one at a time, so the rotation and a request for the same
       * account never both ask Anthropic.
       */
      const get = Effect.fn('UsageCache.get')(function* (
        login: Login.Login,
        options: { readonly active: boolean }
      ) {
        const key = Login.id(login)
        return yield* SynchronizedRef.modifyEffect(
          checks,
          Effect.fnUntraced(function* (all) {
            const now = yield* DateTime.now
            const previous = Record.get(all, key)
            const latest = Option.flatMap(previous, (check) => check.latest)
            const waiting = Option.exists(
              Option.flatMap(previous, (check) => check.failure),
              ({ retryAt }) => DateTime.isLessThan(now, retryAt)
            )
            const fresh = Option.exists(latest, ({ checkedAt }) =>
              Duration.isLessThan(
                DateTime.distance(checkedAt, now),
                options.active ? interval : Duration.minutes(5)
              )
            )
            if (Option.isSome(previous) && (waiting || fresh)) {
              return [previous.value, all] as const
            }

            const check = yield* Result.match(
              yield* fetch(login, options.active).pipe(Effect.result),
              {
                onSuccess: (usage) =>
                  Effect.succeed<Usage.Check>({
                    latest: Option.match(usage, {
                      onNone: () => latest,
                      onSome: (fetched) =>
                        Option.some({ usage: fetched, checkedAt: now }),
                    }),
                    failure: Option.none(),
                  }),
                onFailure: Effect.fnUntraced(function* (error) {
                  const delay = retryDelay(error)
                  yield* Effect.logWarning(
                    `Couldn't check the usage of ${Login.email(login)}. ${error.message} Checking again in ${Duration.format(delay)}.`
                  )
                  return {
                    latest,
                    failure: Option.some({
                      message: error.message,
                      retryAt: DateTime.addDuration(now, delay),
                    }),
                  } satisfies Usage.Check
                }),
              }
            )
            return [check, Record.set(all, key, check)] as const
          })
        )
      })

      const list = Effect.fn('UsageCache.list')(function* () {
        const live = yield* claude
          .current()
          .pipe(
            Effect.catchTag(
              'ClaudeCodeError',
              ({ path }) => new Account.ClaudeCodeConfigError({ path })
            )
          )
        return yield* Effect.forEach(
          yield* accounts.list(),
          Effect.fnUntraced(function* (stored) {
            const current = Option.filter(live, (login) =>
              Login.sameAccount(login, stored)
            )
            const active = Option.isSome(current)
            return {
              email: Login.email(stored),
              active,
              usage: yield* get(
                Option.getOrElse(current, () => stored),
                { active }
              ),
            } satisfies Account.Account
          })
        )
      })

      return { get, list }
    }),
  }
) {}

export const layer = (settings: { readonly interval: Duration.Input }) =>
  Layer.effect(UsageCache, UsageCache.make(settings))
