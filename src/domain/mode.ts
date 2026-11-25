import { Schema } from 'effect'

/**
 * Whether the daemon switches Claude Code between the accounts by their usage,
 * or leaves it on the account it was last switched to with `tagteam switch`.
 */
export const Mode = Schema.Literals(['auto', 'manual']).annotate({
  description:
    'auto: switch by usage. manual: stay on the account chosen with `tagteam switch`',
})
export type Mode = typeof Mode.Type
