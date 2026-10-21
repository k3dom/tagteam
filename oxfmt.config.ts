import { defineConfig } from 'oxfmt'

export default defineConfig({
  printWidth: 80,
  proseWrap: 'always',
  semi: false,
  singleQuote: true,
  trailingComma: 'es5',
  sortImports: true,
  ignorePatterns: ['coverage', 'pnpm-lock.yaml', 'flake.lock', '.agents'],
})
