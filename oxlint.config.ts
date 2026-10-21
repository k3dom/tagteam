import { recommended } from '@effect/tsgo/oxlint-presets'
import { defineConfig } from 'oxlint'

export default defineConfig({
  ignorePatterns: ['coverage', '.agents'],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: 'deny',
    typeAware: true,
    typeCheck: true,
  },
  // Replaces oxlint's default plugin set rather than adding to it, so the
  // defaults (unicorn, typescript, oxc) have to be repeated here.
  plugins: ['unicorn', 'typescript', 'oxc', 'import', 'vitest', 'effecttsgo'],
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'error',
  },
  rules: {
    'eslint/array-callback-return': 'error',
    'eslint/curly': ['error', 'all'],
    'eslint/eqeqeq': ['error', 'always', { null: 'ignore' }],
    'eslint/no-case-declarations': 'error',
    'eslint/no-console': 'error',
    'eslint/no-promise-executor-return': 'error',
    'eslint/no-template-curly-in-string': 'error',
    'eslint/prefer-const': 'error',
    'import/no-cycle': 'error',
    'oxc/no-barrel-file': 'error',
    'typescript/ban-ts-comment': 'error',
    'typescript/no-import-type-side-effects': 'error',
    'typescript/no-unsafe-function-type': 'error',
    'typescript/switch-exhaustiveness-check': 'error',
    'unicorn/no-abusive-eslint-disable': 'error',
    'unicorn/prefer-node-protocol': 'error',

    // `@effect/vitest` hands a `layer` block its own `it`, so every test in
    // one shadows the imported name.
    'eslint/no-shadow': ['error', { allow: ['it'] }],
    'eslint/no-underscore-dangle': ['error', { allow: ['_tag'] }],
    'unicorn/no-array-sort': 'off',
    'vitest/no-standalone-expect': [
      'error',
      {
        additionalTestBlockFunctions: [
          'it.effect',
          'it.effect.each',
          'it.live',
        ],
      },
    ],

    ...recommended.rules,
    'effecttsgo/crypto-random-uuid-in-effect': 'error',
    'effecttsgo/extends-native-error': 'error',
    'effecttsgo/global-console-in-effect': 'error',
    'effecttsgo/global-date-in-effect': 'error',
    'effecttsgo/global-fetch-in-effect': 'error',
    'effecttsgo/global-random-in-effect': 'error',
    'effecttsgo/global-timers-in-effect': 'error',
    'effecttsgo/instance-of-schema': 'error',
    'effecttsgo/process-env-in-effect': 'error',
    'effecttsgo/service-not-as-class': 'error',

    // Effect ships these off, but the categories above turn them on.
    'effecttsgo/any-unknown-in-error-context': 'off',
    'effecttsgo/strict-effect-provide': 'off',

    // These flag code outside Effect too, such as the entrypoint that starts
    // the runtime.
    'effecttsgo/async-function': 'off',
    'effecttsgo/crypto-random-uuid': 'off',
    'effecttsgo/global-console': 'off',
    'effecttsgo/global-date': 'off',
    'effecttsgo/global-fetch': 'off',
    'effecttsgo/global-random': 'off',
    'effecttsgo/global-timers': 'off',
    'effecttsgo/new-promise': 'off',
    'effecttsgo/node-builtin-import': 'off',
    'effecttsgo/prefer-schema-over-json': 'off',
    'effecttsgo/process-env': 'off',
    'effecttsgo/schema-sync': 'off',

    // `decodeUnknown*` marks input that arrives untyped, even where its static
    // type fits the schema.
    'effecttsgo/prefer-typed-schema-decoder': 'off',
    // No decoded input here carries `NaN` or `Infinity`.
    'effecttsgo/schema-number': 'off',
    // Effect's HTTP and CLI modules are unstable, and the exact version pin
    // guards against their breaking changes.
    'effecttsgo/unstable-api-usage': 'off',

    // Reads the `return yield*` that `missing-return-yield-star` asks for as
    // returning a value.
    'typescript/consistent-return': 'off',
  },
  overrides: [
    {
      files: ['**/test/**', '**/*.test.*'],
      rules: {
        // Fixtures stand in for large generated types (`as never`).
        'typescript/no-unsafe-type-assertion': 'off',
        // Tests mint throwaway ids, decode fixtures synchronously, provide a
        // layer per case and fail with plain errors.
        'effecttsgo/crypto-random-uuid-in-effect': 'off',
        'effecttsgo/global-error-in-effect-failure': 'off',
        'effecttsgo/multiple-effect-provide': 'off',
        'effecttsgo/schema-sync-in-effect': 'off',
        'eslint/no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'vitest',
                // Vitest hoists `vi.mock` only when `vi` comes from `vitest`.
                allowImportNames: ['vi'],
                message:
                  'Import from @effect/vitest, which re-exports vitest and adds it.effect, layer and the assertion helpers.',
              },
            ],
          },
        ],
        // Count the `@effect/vitest/utils` helpers as assertions alongside
        // Vitest's own.
        'vitest/expect-expect': [
          'error',
          {
            assertFunctionNames: [
              'expect',
              'expectTypeOf',
              'assert',
              'assertType',
              'assert*',
              'deepStrictEqual',
              'notDeepStrictEqual',
              'strictEqual',
              'throws',
              'throwsAsync',
              'doesNotThrow',
            ],
          },
        ],
      },
    },
  ],
})
