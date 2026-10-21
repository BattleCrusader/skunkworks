/**
 * `nothing` — the zero-capability package D1 is about.
 *
 * Its only job is to be a real package that declares no capability, so `skwctl plugin install`
 * prints the zero-capability line of the §8.5 screen. It exports `activate(ctx)` and registers
 * nothing: if this file ever does something, the fixture has stopped being a witness.
 */
export function activate(_ctx) {
  // Nothing. That is the point.
}
