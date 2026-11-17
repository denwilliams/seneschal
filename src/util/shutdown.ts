/** Always exit within the supervisor's stop grace period, even if a turn or open stream hangs. */
export function boundedShutdown(stop: () => Promise<void>, exit: (code: number) => void, timeoutMs = 10_000): Promise<void> {
  const deadline = setTimeout(() => exit(0), timeoutMs);
  return Promise.resolve().then(stop).catch(() => { /* Shutdown errors may contain credentials; do not log them. */ }).finally(() => {
    clearTimeout(deadline);
    exit(0);
  });
}
