import {
  Array,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  SchemaTransformation,
  String,
} from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
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

const Usage = Schema.Struct({
  fiveHour: Schema.NullOr(Window),
  sevenDay: Schema.NullOr(Window),
}).pipe(Schema.encodeKeys({ fiveHour: 'five_hour', sevenDay: 'seven_day' }))
export type Usage = typeof Usage.Type

export class RateLimited extends Schema.TaggedError<
  RateLimited,
  { readonly brand: unique symbol }
>()('RateLimited', { retryAfter: Schema.optional(Schema.Duration) }) {
  override get message(): string {
    return "Couldn't check usage because Anthropic limits how often it can be checked."
  }
}

export class Unauthorized extends Schema.TaggedError<
  Unauthorized,
  { readonly brand: unique symbol }
>()('Unauthorized', {}) {
  override get message(): string {
    return "Couldn't check usage because Anthropic no longer accepts this login. Log in to the account again with /login in Claude Code, then run `tagteam add`."
  }
}

export class InvalidGrant extends Schema.TaggedError<
  InvalidGrant,
  { readonly brand: unique symbol }
>()('InvalidGrant', {}) {
  override get message(): string {
    return 'This login has expired or was revoked. Log in to the account again with /login in Claude Code, then run `tagteam add`.'
  }
}

export class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()('Unavailable', { cause: Schema.Defect() }) {
  override get message(): string {
    return "Couldn't reach Anthropic or understand its response."
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
  scope: Schema.optional(
    Schema.String.pipe(
      Schema.decodeTo(
        Schema.Array(Schema.String),
        SchemaTransformation.transform({
          decode: (scope): ReadonlyArray<string> => String.split(scope, ' '),
          encode: Array.join(' '),
        })
      )
    )
  ),
  refresh_token_expires_in: Schema.optional(Schema.Number),
})

const ErrorResponse = Schema.Struct({ error: Schema.String })

const ClaudeVersion = Schema.TemplateLiteralParser([
  Schema.String,
  ' (Claude Code)',
])

const unavailable = (cause: unknown) =>
  new AnthropicError({ reason: new Unavailable({ cause }) })

export class Anthropic extends Context.Service<Anthropic>()(
  '@tagteam/Anthropic',
  {
    make: Effect.fnUntraced(function* (userAgent: Effect.Effect<string>) {
      // Retrying a 429 would only spend more of the usage endpoint's budget,
      // so only failures without a response are retried.
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequestEffect(
          Effect.fnUntraced(function* (request) {
            return request.pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.setHeader('user-agent', yield* userAgent)
            )
          })
        ),
        HttpClient.retryTransient({
          retryOn: 'errors-only',
          schedule: Schedule.exponential('1 second'),
          times: 2,
        }),
        HttpClient.filterStatusOk
      )

      const usageRejection = Effect.fnUntraced(function* ({
        response,
      }: HttpClientError.StatusCodeError) {
        if (response.status === 401) {
          return yield* new AnthropicError({ reason: new Unauthorized() })
        }
        if (response.status === 429) {
          return yield* new AnthropicError({
            reason: new RateLimited({
              retryAfter: pipe(
                Option.fromNullishOr(response.headers['retry-after']),
                Option.flatMap(
                  Schema.decodeUnknownOption(Schema.FiniteFromString)
                ),
                Option.map(Duration.seconds),
                Option.getOrUndefined
              ),
            }),
          })
        }
        return yield* unavailable(response.status)
      })

      const usage = Effect.fn('Anthropic.usage')(
        function* (accessToken: string) {
          const response = yield* http.execute(
            HttpClientRequest.get(
              'https://api.anthropic.com/api/oauth/usage'
            ).pipe(
              HttpClientRequest.bearerToken(accessToken),
              HttpClientRequest.setHeader('anthropic-beta', 'oauth-2025-04-20')
            )
          )
          return yield* HttpClientResponse.schemaBodyJson(Usage)(response)
        },
        Effect.catchReason(
          'HttpClientError',
          'StatusCodeError',
          usageRejection
        ),
        Effect.catchTag(['HttpClientError', 'SchemaError'], (cause) =>
          Effect.fail(unavailable(cause))
        )
      )

      const refreshRejection = Effect.fnUntraced(function* (
        failure: HttpClientError.StatusCodeError
      ) {
        const body = yield* failure.response.json.pipe(
          Effect.map(Schema.decodeUnknownOption(ErrorResponse)),
          Effect.orElseSucceed(Option.none)
        )
        if (Option.exists(body, ({ error }) => error === 'invalid_grant')) {
          return yield* new AnthropicError({ reason: new InvalidGrant() })
        }
        return yield* unavailable(failure)
      })

      const refresh = Effect.fn('Anthropic.refresh')(
        function* (tokens: ClaudeCode.Tokens) {
          const response = yield* http.execute(
            HttpClientRequest.post(
              'https://platform.claude.com/v1/oauth/token'
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                grant_type: 'refresh_token',
                refresh_token: tokens.refreshToken,
                client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
                ...(tokens.scopes && {
                  scope: Array.join(tokens.scopes, ' '),
                }),
              })
            )
          )
          const body =
            yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response)
          const now = yield* DateTime.now
          const after = (seconds: number) =>
            DateTime.toEpochMillis(DateTime.add(now, { seconds }))
          return {
            ...tokens,
            accessToken: body.access_token,
            refreshToken: body.refresh_token ?? tokens.refreshToken,
            expiresAt: after(body.expires_in),
            ...(body.scope && { scopes: body.scope }),
            ...(body.refresh_token_expires_in !== undefined && {
              refreshTokenExpiresAt: after(body.refresh_token_expires_in),
            }),
          } satisfies ClaudeCode.Tokens
        },
        Effect.catchReason(
          'HttpClientError',
          'StatusCodeError',
          refreshRejection
        ),
        Effect.catchTag(['HttpClientError', 'SchemaError'], (cause) =>
          Effect.fail(unavailable(cause))
        )
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
        Effect.flatMap((stdout) =>
          Schema.decodeUnknownEffect(ClaudeVersion)(String.trim(stdout))
        ),
        Effect.timeout('10 seconds'),
        Effect.map(([version]) => `claude-cli/${version} (external, cli)`),
        Effect.orElseSucceed(() => 'claude-cli'),
        Effect.cached
      )
    return yield* Anthropic.make(userAgent)
  })
).pipe(Layer.provide(FetchHttpClient.layer))
