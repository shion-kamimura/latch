// null represents an omitted, optional resource ceiling in profiles/reports.
export function formatLimit(value: number | null, unit = ''): string {
  return value === null ? 'なし' : `${value}${unit}`;
}

// Node timers overflow above 2^31-1ms. Long user-selected deadlines must not
// silently become a 1ms timeout. Return a cancellation function in all cases.
export function startTimeout(
  timeoutMs: number | null,
  callback: () => void,
): () => void {
  if (timeoutMs === null) return () => {};
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) callback();
    else timer = setTimeout(schedule, Math.min(remaining, 2 ** 31 - 1));
  };
  schedule();
  return () => clearTimeout(timer);
}
