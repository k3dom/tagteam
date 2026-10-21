import { Effect, FileSystem, Option, Random, Schema } from 'effect'

/**
 * Reads and decodes a JSON file, or returns `None` when it doesn't exist.
 * Failing to read an existing file is a defect.
 */
export const read = Effect.fnUntraced(function* <S extends Schema.Constraint>(
  file: string,
  schema: S
) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie
  )
  if (Option.isNone(text)) {
    return Option.none<S['Type']>()
  }
  return Option.some(
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text.value)
  )
})

/**
 * Writes `value` as JSON that only its owner can read. The file is replaced
 * in one rename, so a reader never sees it half written.
 */
export const write = Effect.fnUntraced(function* (
  file: string,
  value: unknown,
  options: { readonly indent?: number } = {}
) {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${file}.${(yield* Random.nextIntBetween(0, 2 ** 32)).toString(36)}.tmp`
  yield* fs.writeFileString(
    temporary,
    JSON.stringify(value, null, options.indent),
    { mode: 0o600 }
  )
  yield* fs.rename(temporary, file)
}, Effect.orDie)
