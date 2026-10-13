/**
 * Order reasoning sections so the lanes still thinking come last.
 *
 * The thinking box follows its bottom edge, so whichever section sits last is
 * the one the user sees move. A lane that already finished stays above the
 * live ones; otherwise a long metric think grows out of sight under the run
 * lane's frozen last lines.
 */
export function liveLanesLast(order: readonly string[], live: ReadonlySet<string>): string[] {
  return [...order.filter((key) => !live.has(key)), ...order.filter((key) => live.has(key))];
}
