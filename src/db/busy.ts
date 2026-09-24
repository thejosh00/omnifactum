/** Whether an error means another writer held the database past the busy timeout. */
export function isBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as {code?: unknown}).code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}
