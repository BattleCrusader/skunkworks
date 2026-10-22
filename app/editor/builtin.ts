/**
 * GrapesJS's **built-in** component types — the ones it defines for itself, not ones this
 * product registered.
 *
 * Why this file exists. `data-gjs-type` was treated as a claim of registration: every value in
 * a body had to name a component in `app/editor/registry.ts`, or the body was refused with
 * `SKW_E_RT_COMPONENT_UNKNOWN`. That held while the only content was registry blocks. It stopped
 * being true in S8s, when the palette began emitting plain HTML — and GrapesJS labels a plain
 * `<h1>`, `<p>` or `<div>` with its own type the moment it parses one. Measured on the live
 * editor: an h1 copied out of the canvas arrives as `<h1 data-gjs-type="text">`, and pasting it
 * was refused by name, because `text` is GrapesJS's, not ours.
 *
 * The distinction the validator actually wants is **"a component this build can render"**, and
 * a plain element is one: it renders as itself. What must stay refused is a type nobody defines
 * — a page claiming a component the deployment cannot draw, which is what a degraded paste
 * leaves behind.
 *
 * The list is `GRAPESJS_TYPES` from the registry, not a second copy of it: the registry already
 * refuses a component whose name collides with one of these (adding `addType('image', …)` does
 * not replace the built-in model), so that set is the authority and this module only asks it a
 * different question. Because a registry type can never be a built-in, a `data-gjs-type` in a
 * body is unambiguous.
 *
 * On the way **out**, `canon()` strips these values, so a stored body and an exported page carry
 * our components' locks and no editor internals.
 */
import { GRAPESJS_TYPES } from './registry.ts';

export const BUILT_IN_TYPES: ReadonlySet<string> = GRAPESJS_TYPES;

export function isBuiltInType(type: string): boolean {
  return BUILT_IN_TYPES.has(type);
}

/** A type this build can render: one of ours, or one of GrapesJS's. */
export function isKnownType(type: string, registered: ReadonlyMap<string, unknown>): boolean {
  return registered.has(type) || BUILT_IN_TYPES.has(type);
}
