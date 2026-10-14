/** 44px tap targets on phones and coarse-pointer tablets; the desktop size once a fine pointer is present. */
export const TOUCH_TAP =
  "min-h-[44px] sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]";

/** `TOUCH_TAP` for a square icon button: the width grows with the height. */
export const TOUCH_TAP_SQUARE = `${TOUCH_TAP} min-w-[44px] sm:min-w-0 [@media(hover:none)_and_(pointer:coarse)]:min-w-[44px]`;
