// Same motion as the dashboard runs table: rows keep their identity across
// sort and filter changes, so a sort glides each row to its new place and a
// filter fades the dropped rows out.
const ROW_EASE = [0.2, 0.8, 0.2, 1] as const;

export const ROW_MOTION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: { duration: 0.15, ease: ROW_EASE } },
};

/** Layout glide plus an entrance staggered by position, capped at 12 rows. */
export function rowTransition(idx: number) {
  const enter = { duration: 0.3, ease: ROW_EASE, delay: Math.min(idx, 12) * 0.03 };
  return { layout: { duration: 0.3, ease: ROW_EASE }, opacity: enter, y: enter };
}
