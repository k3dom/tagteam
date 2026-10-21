import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import { DateTime, Effect, FileSystem, Layer, Path, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import * as Accounts from '#/Accounts.ts'
import * as Anthropic from '#/Anthropic.ts'
import * as ClaudeCode from '#/ClaudeCode.ts'
import * as Rotation from '#/Rotation.ts'

const start = Date.parse('2026-10-21T08:00:00Z')
const hours = (n: number) => n * 60 * 60 * 1000
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

const login = (
  name: string,
  options: { readonly generation?: number; readonly expiresAt?: number } = {}
): ClaudeCode.Login => ({
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
      expiresAt: options.expiresAt ?? start + hours(8),
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  },
})

type Usage =
  | {
      readonly fiveHour: number
      readonly sevenDay?: number
      readonly resetsAt?: number
    }
  | 'unauthorized'

const RefreshRequest = Schema.Struct({ refresh_token: Schema.String })

/**
 * Stands in for Anthropic. Access and refresh tokens look like
 * `<account>:<kind>:<generation>`, and a refresh hands out the next generation.
 */
const fakeAnthropic = (usage: Map<string, Usage>, refreshed: Array<string>) =>
  HttpClient.make((request, url) =>
    Effect.sync(() => {
      if (url.pathname === '/v1/oauth/token') {
        assert.strictEqual(request.body._tag, 'Uint8Array')
        const { refresh_token } = Schema.decodeUnknownSync(
          Schema.fromJsonString(RefreshRequest)
        )(
          new TextDecoder().decode(
            request.body._tag === 'Uint8Array' ? request.body.body : undefined
          )
        )
        refreshed.push(refresh_token)
        const [name, , generation] = refresh_token.split(':')
        const next = globalThis.Number(generation) + 1
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: `${name}:access:${next}`,
            refresh_token: `${name}:refresh:${next}`,
            expires_in: 8 * 60 * 60,
          })
        )
      }
      const name = (request.headers['authorization'] ?? '')
        .replace('Bearer ', '')
        .split(':')[0]
      const current = usage.get(name ?? '')
      if (current === undefined || current === 'unauthorized') {
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: 401 })
        )
      }
      const resetsAt = iso(current.resetsAt ?? start + hours(2))
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          five_hour: { utilization: current.fiveHour, resets_at: resetsAt },
          seven_day: {
            utilization: current.sevenDay ?? 0,
            resets_at: iso(start + hours(72)),
          },
        })
      )
    })
  )

/**
 * A Claude Code config directory logged into `live` and a tagteam store
 * holding `accounts`, in a temporary directory.
 */
const sandbox = Effect.fnUntraced(function* (options: {
  readonly live: ClaudeCode.Login
  readonly accounts: ReadonlyArray<ClaudeCode.Login>
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  const configDir = path.join(directory, '.claude')
  const globalConfig = path.join(directory, '.claude.json')
  const credentials = path.join(configDir, '.credentials.json')
  const data = path.join(directory, 'tagteam')
  yield* fs.makeDirectory(configDir)
  yield* fs.makeDirectory(data)
  yield* fs.writeFileString(
    credentials,
    JSON.stringify({
      ...options.live.credentials,
      mcpOAuth: { linear: { accessToken: 'mcp-token' } },
    })
  )
  yield* fs.writeFileString(
    globalConfig,
    JSON.stringify({ numStartups: 7, oauthAccount: options.live.oauthAccount })
  )
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

  const readJson = (file: string) =>
    fs
      .readFileString(file)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
          )
        )
      )

  return {
    layer,
    usage,
    refreshed,
    /** What Claude Code would find on disk. */
    claudeCode: Effect.all({
      credentials: readJson(credentials),
      config: readJson(globalConfig),
    }),
    stored: Effect.flatMap(Accounts.Accounts, (accounts) =>
      accounts.list()
    ).pipe(Effect.provide(layer)),
    /** Simulates Claude Code refreshing the tokens of its login. */
    refreshLive: (next: ClaudeCode.Login) =>
      fs.writeFileString(
        credentials,
        JSON.stringify({
          ...next.credentials,
          mcpOAuth: { linear: { accessToken: 'mcp-token' } },
        })
      ),
  }
})

const tick = (
  settings: Rotation.Settings = { threshold: 90, interval: '1 minute' }
) => Effect.flatMap(Rotation.make(settings), (rotation) => rotation.tick())

describe('Rotation', () => {
  it.effect(
    'switches to the next account once the active one nears a limit',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const main = login('main')
        const backup = login('backup')
        const box = yield* sandbox({ live: main, accounts: [main, backup] })
        box.usage.set('main', { fiveHour: 92 })
        box.usage.set('backup', { fiveHour: 10 })
        // Claude Code refreshed the main account since tagteam stored it.
        const refreshedMain = login('main', { generation: 1 })
        yield* box.refreshLive(refreshedMain)

        yield* tick().pipe(Effect.provide(box.layer))

        const { credentials, config } = yield* box.claudeCode
        deepStrictEqual(credentials, {
          ...backup.credentials,
          mcpOAuth: { linear: { accessToken: 'mcp-token' } },
        })
        deepStrictEqual(config, {
          numStartups: 7,
          oauthAccount: backup.oauthAccount,
        })
        deepStrictEqual(yield* box.stored, [refreshedMain, backup])
      }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect('returns to the main account once its limit resets', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const main = login('main')
      const backup = login('backup')
      const box = yield* sandbox({ live: main, accounts: [main, backup] })
      box.usage.set('main', { fiveHour: 95, resetsAt: start + hours(2) })
      box.usage.set('backup', { fiveHour: 10 })
      const rotation = yield* Rotation.make({
        threshold: 90,
        interval: '1 minute',
      }).pipe(Effect.provide(box.layer))

      yield* rotation.tick().pipe(Effect.provide(box.layer))
      deepStrictEqual(
        (yield* box.claudeCode).config['oauthAccount'],
        backup.oauthAccount
      )

      yield* TestClock.adjust('1 hour')
      yield* rotation.tick().pipe(Effect.provide(box.layer))
      deepStrictEqual(
        (yield* box.claudeCode).config['oauthAccount'],
        backup.oauthAccount
      )

      yield* TestClock.adjust('61 minutes')
      yield* rotation.tick().pipe(Effect.provide(box.layer))
      deepStrictEqual(
        (yield* box.claudeCode).config['oauthAccount'],
        main.oauthAccount
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect('prefers accounts in priority order', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const main = login('main')
      const second = login('second')
      const third = login('third')
      const box = yield* sandbox({
        live: third,
        accounts: [main, second, third],
      })
      box.usage.set('main', { fiveHour: 99 })
      box.usage.set('second', { fiveHour: 50 })
      box.usage.set('third', { fiveHour: 0 })

      yield* tick().pipe(Effect.provide(box.layer))

      deepStrictEqual(
        (yield* box.claudeCode).config['oauthAccount'],
        second.oauthAccount
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect(
    'stays put when every other account is near its limits or unknown',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const main = login('main')
        const exhausted = login('exhausted')
        const unknown = login('unknown')
        const box = yield* sandbox({
          live: main,
          accounts: [main, exhausted, unknown],
        })
        box.usage.set('main', { fiveHour: 95 })
        box.usage.set('exhausted', { fiveHour: 40, sevenDay: 90 })
        box.usage.set('unknown', 'unauthorized')

        yield* tick().pipe(Effect.provide(box.layer))

        deepStrictEqual(
          (yield* box.claudeCode).config['oauthAccount'],
          main.oauthAccount
        )
      }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect('leaves a login it does not manage alone', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const stranger = login('stranger')
      const backup = login('backup')
      const box = yield* sandbox({ live: stranger, accounts: [backup] })
      box.usage.set('stranger', { fiveHour: 100 })
      box.usage.set('backup', { fiveHour: 0 })

      yield* tick().pipe(Effect.provide(box.layer))

      deepStrictEqual(
        (yield* box.claudeCode).config['oauthAccount'],
        stranger.oauthAccount
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect(
    "refreshes an inactive account's expired token but never the active one's",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const main = login('main', { expiresAt: start - hours(1) })
        const backup = login('backup', { expiresAt: start - hours(1) })
        const box = yield* sandbox({ live: main, accounts: [main, backup] })
        box.usage.set('main', { fiveHour: 0 })
        box.usage.set('backup', { fiveHour: 0 })

        yield* tick().pipe(Effect.provide(box.layer))

        deepStrictEqual(box.refreshed, ['backup:refresh:0'])
        const stored = yield* box.stored
        assert.strictEqual(
          stored[1]?.credentials.claudeAiOauth.refreshToken,
          'backup:refresh:1'
        )
        assert.strictEqual(
          stored[1]?.credentials.claudeAiOauth.expiresAt,
          start + hours(8)
        )
      }).pipe(Effect.provide(NodeServices.layer))
  )
})
