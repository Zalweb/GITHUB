export function computeBackoffDelay(attempt: number, baseMs = 400, maxMs = 8000): number {
  if (attempt <= 0) {
    return 0;
  }
  const raw = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 200);
  return raw + jitter;
}
