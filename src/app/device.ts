/**
 * A phone: a finger for a pointer, on a small screen. Someone on one is there
 * as a commuter or a driver, so it opens on the commuter's app and leaves out
 * the operator's views. A narrow window on a laptop is still a laptop.
 */
export const onPhone =
  typeof matchMedia === 'function' &&
  matchMedia('(pointer: coarse) and (max-width: 1100px)').matches;
