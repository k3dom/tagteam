import {
  Array,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  pipe,
  Schema,
  String,
} from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import type * as ClaudeCode from '#/ClaudeCode.ts'

const Window = Schema.Struct({
  utilization: Schema.Number,
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}).pipe(Schema.encodeKeys({ resetsAt: 'resets_at' }))
export type Window = typeof Window.Type

export const Usage = Schema.Struct({
  fiveHour: Schema.NullOr(Window),
  sevenDay: Schema.NullOr(Window),
}).pipe(Schema.encodeKeys({ fiveHour: 'five_hour', sevenDay: 'seven_day' }))
export type Usage = typeof Usage.Type

export class RateLimited extends Schema.TaggedError<
  RateLimited,
  { readonly brand: unique symbol }
>()('RateLimited', { retryAfterSeconds: Schema.optional(Schema.Number) }) {
  override get message(): string {
    return 'Anthropic is rate limiting usage requests.'
  }
}

export class Unauthorized extends Schema.TaggedError<
  Unauthorized,
  { readonly brand: unique symbol }
>()('Unauthorized', {}) {
  override get message(): string {
    return 'Anthropic rejected the access token.'
  }
}

export class InvalidGrant extends Schema.TaggedError<
  InvalidGrant,
  { readonly brand: unique symbol }
>()('InvalidGrant', {}) {
  override get message(): string {
    return 'Anthropic rejected the refresh token, so this login has expired or was revoked. Log in to the account again with /login in Claude Code, then run `tagteam add`.'
  }
}

export class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()('Unavailable', { cause: Schema.Defect() }) {
  override get message(): string {
    return "Couldn't get a valid response from Anthropic."
  }
}

export class AnthropicError extends Schema.TaggedError<
  AnthropicError,
  { readonly brand: unique symbol }
>()('AnthropicError', {
  reason: Schema.Union([RateLimited, Unauthorized, InvalidGrant, Unavailable]),
}) {
  override get message(): string {
    return this.reason.message
  }
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  scope: Schema.optional(Schema.String),
  refresh_token_expires_in: Schema.optional(Schema.Number),
})

const ErrorResponse = Schema.Struct({ error: Schema.String })

const fail = (
  reason: AnthropicError['reason']
): Effect.Effect<never, AnthropicError> =>
  Effect.fail(new AnthropicError({ reason }))

const unavailable = (cause: unknown) => fail(new Unavailable({ cause }))

export class Anthropic extends Context.Service<Anthropic>()(
  '@tagteam/Anthropic',
  {
    make: Effect.fnUntraced(function* (userAgent: Effect.Effect<string>) {
      const http = yield* HttpClient.HttpClient

      const usage = Effect.fn('Anthropic.usage')(
        function* (accessToken: string) {
          const response = yield* http.execute(
            HttpClientRequest.get(
              'https://api.anthropic.com/api/oauth/usage'
            ).pipe(
              HttpClientRequest.bearerToken(accessToken),
              HttpClientRequest.acceptJson,
              HttpClientRequest.setHeaders({
                'anthropic-beta': 'oauth-2025-04-20',
                'user-agent': yield* userAgent,
              })
            )
          )
          if (response.status === 401) {
            return yield* fail(new Unauthorized())
          }
          if (response.status === 429) {
            return yield* fail(
              new RateLimited({
                retryAfterSeconds: pipe(
                  Option.fromNullishOr(response.headers['retry-after']),
                  Option.flatMap(
                    Schema.decodeUnknownOption(Schema.FiniteFromString)
                  ),
                  Option.getOrUndefined
                ),
              })
            )
          }
          if (response.status !== 200) {
            return yield* unavailable(
              `Usage request returned ${response.status}`
            )
          }
          return yield* HttpClientResponse.schemaBodyJson(Usage)(response)
        },
        Effect.catchTags({
          HttpClientError: unavailable,
          SchemaError: unavailable,
        })
      )

      const refresh = Effect.fn('Anthropic.refresh')(
        function* (tokens: ClaudeCode.Tokens) {
          const response = yield* http.execute(
            HttpClientRequest.post(
              'https://platform.claude.com/v1/oauth/token'
            ).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bodyJsonUnsafe({
                grant_type: 'refresh_token',
                refresh_token: tokens.refreshToken,
                client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
                ...(tokens.scopes && { scope: tokens.scopes.join(' ') }),
              })
            )
          )
          if (response.status >= 400 && response.status < 500) {
            const rejection = yield* response.json.pipe(
              Effect.map(Schema.decodeUnknownOption(ErrorResponse)),
              Effect.orElseSucceed(Option.none)
            )
            if (
              Option.exists(rejection, ({ error }) => error === 'invalid_grant')
            ) {
              return yield* fail(new InvalidGrant())
            }
          }
          if (response.status !== 200) {
            return yield* unavailable(
              `Token refresh returned ${response.status}`
            )
          }
          const body =
            yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response)
          const now = yield* Clock.currentTimeMillis
          return {
            ...tokens,
            accessToken: body.access_token,
            refreshToken: body.refresh_token ?? tokens.refreshToken,
            expiresAt: now + body.expires_in * 1000,
            ...(body.scope !== undefined && {
              scopes: String.split(body.scope, ' '),
            }),
            ...(body.refresh_token_expires_in !== undefined && {
              refreshTokenExpiresAt: now + body.refresh_token_expires_in * 1000,
            }),
          } satisfies ClaudeCode.Tokens
        },
        Effect.catchTags({
          HttpClientError: unavailable,
          SchemaError: unavailable,
        })
      )

      return { usage, refresh }
    }),
  }
) {}

// Anthropic rate limits the usage endpoint harder for clients that don't
// identify as Claude Code, so requests carry its user agent.
export const layer = Layer.effect(
  Anthropic,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const userAgent = yield* spawner
      .string(ChildProcess.make('claude', ['--version']))
      .pipe(
        Effect.timeout('10 seconds'),
        Effect.option,
        Effect.map((stdout) =>
          pipe(
            stdout,
            Option.flatMap((output) =>
              Array.head(String.split(String.trim(output), ' '))
            ),
            Option.filter(String.isNonEmpty),
            Option.match({
              onNone: () => 'claude-cli',
              onSome: (version) => `claude-cli/${version} (external, cli)`,
            })
          )
        ),
        Effect.cached
      )
    return yield* Anthropic.make(userAgent)
  })
).pipe(Layer.provide(FetchHttpClient.layer))
