import { Config, Effect, Option, Path } from 'effect'

/** The base directory for user data, `$XDG_DATA_HOME` or `~/.local/share`. */
export const dataHome = Effect.gen(function* () {
  const path = yield* Path.Path
  const { home, dataHome: configured } = yield* Config.all({
    home: Config.String('HOME'),
    dataHome: Config.option(Config.String('XDG_DATA_HOME')),
  })
  return Option.getOrElse(configured, () => path.join(home, '.local', 'share'))
})
