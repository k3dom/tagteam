import { Array, Equivalence, Schema } from 'effect'

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

/** The login of `login`'s account among `logins`. */
export const find = (logins: ReadonlyArray<Login>, login: Login) =>
  Array.findFirst(logins, (other) => sameAccount(other, login))

/** Replaces the login of `login`'s account among `logins` with `login`. */
export const replace = (
  logins: ReadonlyArray<Login>,
  login: Login
): ReadonlyArray<Login> =>
  Array.map(logins, (other) => (sameAccount(other, login) ? login : other))

export const remove = (
  logins: ReadonlyArray<Login>,
  login: Login
): ReadonlyArray<Login> =>
  Array.filter(logins, (other) => !sameAccount(other, login))
