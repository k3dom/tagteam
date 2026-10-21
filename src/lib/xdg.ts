import { Config, Effect, Option, Path } from 'effect'

const base = Effect.fnUntraced(function* (
  variable: string,
  fallback: ReadonlyArray<string>
) {
  const path = yield* Path.Path
  const { home, configured } = yield* Config.all({
    home: Config.String('HOME'),
    configured: Config.option(Config.String(variable)),
  })
  return Option.getOrElse(configured, () => path.join(home, ...fallback))
})

/** The base directory for user data, `$XDG_DATA_HOME` or `~/.local/share`. */
export const dataHome = base('XDG_DATA_HOME', ['.local', 'share'])

/** The base directory for user caches, `$XDG_CACHE_HOME` or `~/.cache`. */
export const cacheHome = base('XDG_CACHE_HOME', ['.cache'])
