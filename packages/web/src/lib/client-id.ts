/**
 * Stable per-browser identity for ui_state rows (SPEC §11): reloads restore
 * this client's own layout; other machines seed from the latest snapshot but
 * write to their own row.
 */
const KEY = 'puddle.client-id';

export function clientId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
