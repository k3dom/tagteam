import {
  Array,
  Config,
  Context,
  Effect,
  Equivalence,
  FileSystem,
  Layer,
  Option,
  Path,
  Record,
  Schema,
} from 'effect'

import * as Lockfile from '#/Lockfile.ts'

const Rest = Schema.Record(Schema.String, Schema.Unknown)

export const Tokens = Schema.StructWithRest(
  Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
    scopes: Schema.optional(Schema.Array(Schema.String)),
  }),
  [Rest]
)
export type Tokens = typeof Tokens.Type

/**
 * One Claude Code login: the `oauthAccount` from its global config and the
 * account-bound part of `.credentials.json`.
 */
export const Login = Schema.Struct({
  oauthAccount: Schema.StructWithRest(
    Schema.Struct({
      accountUuid: Schema.String,
      emailAddress: Schema.String,
      organizationUuid: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    [Rest]
  ),
  credentials: Schema.StructWithRest(Schema.Struct({ claudeAiOauth: Tokens }), [
    Rest,
  ]),
})
export type Login = typeof Login.Type

/**
 * Identifies the account of a login. One person can sign in with the same
 * account to several organizations, each with its own limits.
 */
export const id = (login: Login): string =>
  `${login.oauthAccount.accountUuid}/${login.oauthAccount.organizationUuid ?? ''}`

export const sameAccount: Equivalence.Equivalence<Login> = Equivalence.mapInput(
  Equivalence.String,
  id
)

export const email = (login: Login): string => login.oauthAccount.emailAddress

export class ClaudeCodeError extends Schema.TaggedError<
  ClaudeCodeError,
  { readonly brand: unique symbol }
>()('ClaudeCodeError', { path: Schema.String, cause: Schema.Defect() }) {
  override get message(): string {
    return `Couldn't read ${this.path} because it isn't valid JSON. Check the file, or log in to Claude Code again to rewrite it.`
  }
}

// Everything else in `.credentials.json`, such as MCP server tokens, belongs to
// the machine and stays in place across a switch.
const accountKeys: ReadonlyArray<string> = [
  'claudeAiOauth',
  'trustedDeviceToken',
]

const JsonObject = Schema.fromJsonString(Rest)

const toLogin = (
  credentials: Option.Option<Record<string, unknown>>,
  config: Option.Option<Record<string, unknown>>
): Option.Option<Login> =>
  Schema.decodeUnknownOption(Login)({
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

      const read = Effect.fnUntraced(function* (file: string) {
        const text = yield* fs.readFileString(file).pipe(
          Effect.asSome,
          Effect.catchReason(
            'PlatformError',
            'NotFound',
            () => Effect.succeedNone
          ),
          Effect.orDie
        )
        if (Option.isNone(text)) {
          return Option.none()
        }
        return yield* Schema.decodeUnknownEffect(JsonObject)(text.value).pipe(
          Effect.asSome,
          Effect.mapError((cause) => new ClaudeCodeError({ path: file, cause }))
        )
      })

      const write = Effect.fnUntraced(function* (
        file: string,
        content: string
      ) {
        const temporary = `${file}.tagteam.tmp`
        yield* fs.writeFileString(temporary, content, { mode: 0o600 })
        yield* fs.rename(temporary, file)
      }, Effect.orDie)

      const current = Effect.fn('ClaudeCode.current')(function* () {
        return toLogin(
          yield* read(credentialsPath),
          yield* read(paths.globalConfig)
        )
      })

      /**
       * Makes `login` the one Claude Code uses, provided Claude Code is still
       * logged into the account of `replacing`. Returns the replaced login,
       * read under the same locks so that it includes any token refresh Claude
       * Code made in the meantime, or `None` when the login changed and nothing
       * was switched.
       */
      const activate = Effect.fn('ClaudeCode.activate')(function* (
        login: Login,
        replacing: Login
      ) {
        const timeout = '10 seconds'
        const realConfigDir = yield* fs
          .realPath(paths.configDir)
          .pipe(Effect.orDie)
        // Claude Code refreshes tokens under both of these, in this order.
        yield* Lockfile.acquire(
          path.join(paths.configDir, '.oauth_refresh.lock'),
          { stale: '60 seconds', timeout }
        ).pipe(Effect.provideService(FileSystem.FileSystem, fs))
        yield* Lockfile.acquire(`${realConfigDir}.lock`, {
          stale: '60 seconds',
          timeout,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs))
        yield* Lockfile.acquire(`${paths.globalConfig}.lock`, {
          stale: '10 seconds',
          timeout,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs))

        const credentials = yield* read(credentialsPath)
        const config = yield* read(paths.globalConfig)
        const replaced = toLogin(credentials, config)
        if (!Option.exists(replaced, (live) => sameAccount(live, replacing))) {
          return Option.none()
        }
        yield* write(
          credentialsPath,
          JSON.stringify({
            ...Option.match(credentials, {
              onNone: () => ({}),
              onSome: Record.filter(
                (_, key) => !Array.contains(accountKeys, key)
              ),
            }),
            ...login.credentials,
          })
        )
        yield* write(
          paths.globalConfig,
          JSON.stringify(
            {
              ...Option.getOrElse(config, () => ({})),
              oauthAccount: login.oauthAccount,
            },
            null,
            2
          )
        )
        return replaced
      }, Effect.scoped)

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
