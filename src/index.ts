#!/usr/bin/env node

import { enableCompileCache } from 'node:module'

enableCompileCache()

await import('#/main.ts')
