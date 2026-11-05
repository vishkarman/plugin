/**
 * Local type declaration for the DSH composer slot we extend.
 *
 * The conversation package is shipped inside DSH and augments these tables itself; our plugin does not
 * depend on it at runtime (the slot name is a public string and `slots.inject` waits until it exists).
 * Declaring the entry here keeps `ctx.slots.register` type-checked without pulling the whole chat package
 * into our dependency graph. `inputActions` is the standard session-scope prop provided by `ui-conversation`.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.composer.dock': { kind: 'list'; scope: 'session' };
  }
  interface SessionStandardProps {
    /** Public draft actions exposed to session-scope slots; optional outside a mounted composer. */
    inputActions?: {
      captureInsertion(): { start: number; end: number; draftRev: number };
      insertText(text: string, span: { start: number; end: number; draftRev: number }): boolean;
    };
  }
}
