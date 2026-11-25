import { Schema } from 'effect'

export const Mode = Schema.Literals(['auto', 'manual']).annotate({
  description:
    'auto: switch by usage. manual: stay on the account chosen with `tagteam switch`',
})
export type Mode = typeof Mode.Type
