import { NodeServices } from '@effect/platform-node'
import { DateTime, Effect, FileSystem, Layer, Path, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import type * as Login from '#/domain/login.ts'
import * as Accounts from '#/services/accounts.ts'
import * as Anthropic from '#/services/anthropic.ts'
import * as ClaudeCode from '#/services/claude-code.ts'

export const start = DateTime.makeUnsafe('2026-10-21T08:00:00Z')

export const at = (offset: Partial<DateTime.DateTime.PartsForMath>) =>
  DateTime.toEpochMillis(DateTime.add(start, offset))

export const login = (
  name: string,
  options: { readonly generation?: number; readonly expiresAt?: number } = {}
): Login.Login => ({
  oauthAccount: {
    accountUuid: `${name}-uuid`,
    emailAddress: `${name}@example.com`,
    organizationUuid: 'org-uuid',
    organizationName: 'Example',
  },
  credentials: {
    claudeAiOauth: {
      accessToken: `${name}:access:${options.generation ?? 0}`,
      refreshToken: `${name}:refresh:${options.generation ?? 0}`,
      expiresAt: options.expiresAt ?? at({ hours: 8 }),
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  },
})

export type Usage =
  | {
      readonly fiveHour: number
      readonly sevenDay?: number
      readonly resetsAt?: number
    }
  | 'unauthorized'

const Token = Schema.TemplateLiteralParser([
  Schema.String,
  ':',
  Schema.Literals(['access', 'refresh']),
  ':',
  Schema.FiniteFromString,
])

const Authorization = Schema.TemplateLiteralParser([
  'Bearer ',
  Schema.String,
  ':access:',
  Schema.FiniteFromString,
])

const RefreshRequest = Schema.fromJsonString(
  Schema.Struct({ refresh_token: Token })
)

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

/**
 * Stands in for Anthropic. Access and refresh tokens look like
 * `<account>:<kind>:<generation>`, and a refresh hands out the next generation.
 */
const fakeAnthropic = (usage: Map<string, Usage>, refreshed: Array<string>) =>
  HttpClient.make((request, url) =>
    Effect.gen(function* () {
      if (url.pathname === '/v1/oauth/token') {
        const body =
          request.body._tag === 'Uint8Array' ? request.body.body : undefined
        const {
          refresh_token: [name, , , , generation],
        } = yield* Schema.decodeUnknownEffect(RefreshRequest)(
          new TextDecoder().decode(body)
        )
        refreshed.push(`${name}:refresh:${generation}`)
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: `${name}:access:${generation + 1}`,
            refresh_token: `${name}:refresh:${generation + 1}`,
            expires_in: 8 * 60 * 60,
          })
        )
      }
      const [, name] = yield* Schema.decodeUnknownEffect(Authorization)(
        request.headers['authorization']
      )
      const current = usage.get(name) ?? 'unauthorized'
      if (current === 'unauthorized') {
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: 401 })
        )
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          five_hour: {
            utilization: current.fiveHour,
            resets_at: iso(current.resetsAt ?? at({ hours: 2 })),
          },
          seven_day: {
            utilization: current.sevenDay ?? 0,
            resets_at: iso(at({ days: 3 })),
          },
        })
      )
    }).pipe(Effect.orDie)
  )

const JsonObject = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown)
)

/**
 * A Claude Code config directory logged into `live` and a tagteam store
 * holding `accounts`, in a temporary directory, with a fake Anthropic.
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly live: Login.Login
  readonly accounts: ReadonlyArray<Login.Login>
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  const configDir = path.join(directory, '.claude')
  const globalConfig = path.join(directory, '.claude.json')
  const credentials = path.join(configDir, '.credentials.json')
  const data = path.join(directory, 'tagteam')

  /** Simulates Claude Code logging in or refreshing its tokens. */
  const logIn = Effect.fnUntraced(function* (next: Login.Login) {
    yield* fs.writeFileString(
      credentials,
      JSON.stringify({
        ...next.credentials,
        mcpOAuth: { linear: { accessToken: 'mcp-token' } },
      })
    )
    yield* fs.writeFileString(
      globalConfig,
      JSON.stringify({ numStartups: 7, oauthAccount: next.oauthAccount })
    )
  })

  yield* fs.makeDirectory(configDir)
  yield* fs.makeDirectory(data)
  yield* logIn(options.live)
  yield* fs.writeFileString(
    path.join(data, 'accounts.json'),
    JSON.stringify({ accounts: options.accounts })
  )

  const usage = new Map<string, Usage>()
  const refreshed: Array<string> = []
  const layer = Layer.mergeAll(
    Layer.effect(
      ClaudeCode.ClaudeCode,
      ClaudeCode.ClaudeCode.make({ configDir, globalConfig })
    ),
    Layer.effect(Accounts.Accounts, Accounts.Accounts.make(data)),
    Layer.effect(
      Anthropic.Anthropic,
      Anthropic.Anthropic.make(Effect.succeed('test'))
    ).pipe(
      Layer.provide(
        Layer.succeed(HttpClient.HttpClient, fakeAnthropic(usage, refreshed))
      )
    )
  ).pipe(Layer.provide(NodeServices.layer))

  const readJson = Effect.fnUntraced(function* (file: string) {
    return yield* Schema.decodeUnknownEffect(JsonObject)(
      yield* fs.readFileString(file)
    )
  })

  return {
    layer,
    usage,
    /** The refresh tokens sent to Anthropic. */
    refreshed,
    logIn,
    /** What Claude Code finds on disk. */
    claudeCode: Effect.all({
      credentials: readJson(credentials),
      config: readJson(globalConfig),
    }),
    stored: Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts
      return yield* accounts.list()
    }).pipe(Effect.provide(layer)),
  }
})
