import {
  Array,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Record,
  Schema,
} from 'effect'

import * as Login from '#/domain/login.ts'
import * as JsonFile from '#/lib/json-file.ts'
import * as Lockfile from '#/lib/lockfile.ts'

export class ClaudeCodeError extends Schema.TaggedError<
  ClaudeCodeError,
  { readonly brand: unique symbol }
>()('ClaudeCodeError', { path: Schema.String, cause: Schema.Defect() }) {
  override get message(): string {
    return `${this.path} isn't valid JSON, so tagteam can't tell which account Claude Code is logged into. Check the file, or log in to Claude Code again to rewrite it.`
  }
}

// Everything else in `.credentials.json`, such as MCP server tokens, belongs to
// the machine and stays in place across a switch.
const accountKeys: ReadonlyArray<string> = [
  'claudeAiOauth',
  'trustedDeviceToken',
]

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

const read = (file: string) =>
  JsonFile.read(file, JsonObject).pipe(
    Effect.mapError((cause) => new ClaudeCodeError({ path: file, cause }))
  )

const toLogin = (
  credentials: Option.Option<Record<string, unknown>>,
  config: Option.Option<Record<string, unknown>>
): Option.Option<Login.Login> =>
  Schema.decodeUnknownOption(Login.Login)({
    oauthAccount: Option.getOrUndefined(config)?.['oauthAccount'],
    credentials: Option.match(credentials, {
      onNone: () => ({}),
      onSome: Record.filter((_, key) => Array.contains(accountKeys, key)),
    }),
  })

export class ClaudeCode extends Context.Service<ClaudeCode>()(
  '@tagteam/ClaudeCode',
  {
    make: Effect.fnUntraced(function* (paths: {
      readonly configDir: string
      readonly globalConfig: string
    }) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const credentialsPath = path.join(paths.configDir, '.credentials.json')

      const current = Effect.fn('ClaudeCode.current')(
        function* () {
          return toLogin(
            yield* read(credentialsPath),
            yield* read(paths.globalConfig)
          )
        },
        Effect.provideService(FileSystem.FileSystem, fs)
      )

      /**
       * Makes `login` the one Claude Code uses, provided Claude Code is still
       * logged into the account of `replacing`. Returns the replaced login,
       * read under the same locks so that it includes any token refresh Claude
       * Code made in the meantime, or `None` when the login changed and nothing
       * was switched.
       */
      const activate = Effect.fn('ClaudeCode.activate')(
        function* (login: Login.Login, replacing: Login.Login) {
          const timeout = '10 seconds'
          const realConfigDir = yield* fs
            .realPath(paths.configDir)
            .pipe(Effect.orDie)
          // Claude Code refreshes tokens under both of these, in this order.
          yield* Lockfile.acquire(
            path.join(paths.configDir, '.oauth_refresh.lock'),
            { stale: '60 seconds', timeout }
          )
          yield* Lockfile.acquire(`${realConfigDir}.lock`, {
            stale: '60 seconds',
            timeout,
          })
          yield* Lockfile.acquire(`${paths.globalConfig}.lock`, {
            stale: '10 seconds',
            timeout,
          })

          const credentials = yield* read(credentialsPath)
          const config = yield* read(paths.globalConfig)
          const replaced = toLogin(credentials, config)
          if (
            !Option.exists(replaced, (live) =>
              Login.sameAccount(live, replacing)
            )
          ) {
            return Option.none()
          }
          yield* JsonFile.write(credentialsPath, {
            ...Option.match(credentials, {
              onNone: () => ({}),
              onSome: Record.filter(
                (_, key) => !Array.contains(accountKeys, key)
              ),
            }),
            ...login.credentials,
          })
          yield* JsonFile.write(
            paths.globalConfig,
            {
              ...Option.getOrElse(config, () => ({})),
              oauthAccount: login.oauthAccount,
            },
            { indent: 2 }
          )
          return replaced
        },
        Effect.scoped,
        Effect.provideService(FileSystem.FileSystem, fs)
      )

      return { current, activate }
    }),
  }
) {}

export const layer = Layer.effect(
  ClaudeCode,
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { home, configDir } = yield* Config.all({
      home: Config.String('HOME'),
      configDir: Config.option(Config.String('CLAUDE_CONFIG_DIR')),
    })
    return yield* ClaudeCode.make({
      configDir: Option.getOrElse(configDir, () => path.join(home, '.claude')),
      globalConfig: path.join(
        Option.getOrElse(configDir, () => home),
        '.claude.json'
      ),
    })
  })
)
