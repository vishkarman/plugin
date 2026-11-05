/**
 * One pending explicit transfer from the Studio context bar to the DSH composer.
 *
 * The bar can only exist while the chat panel is hidden, so its click stores the already-verified,
 * frozen context here and switches the main panel. The composer dock consumes it once when it mounts;
 * later selections never rewrite a pending transfer.
 */
export interface PendingTransfer {
  id: string;
  text: string;
  createdAt: number;
}

let pending: PendingTransfer | null = null;
const listeners = new Set<() => void>();

export function setPendingTransfer(next: PendingTransfer) {
  pending = next;
  for (const listener of listeners) listener();
}

const MAX_AGE_MS = 45_000;

/** Consume only a recent transfer: a late unrelated session must not receive an old context. */
export function takePendingTransfer(): PendingTransfer | null {
  const next = pending;
  pending = null;
  if (next) for (const listener of listeners) listener();
  return next && Date.now() - next.createdAt <= MAX_AGE_MS ? next : null;
}

export function subscribePendingTransfer(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
