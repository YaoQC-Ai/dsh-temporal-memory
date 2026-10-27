/**
 * Process-wide runtime flags shared by the host plugin and the optional
 * standalone tools plugin.
 *
 * Both entry points import the same package instance; Node's ESM cache
 * guarantees this module is a singleton. That makes it the right place to:
 *   - prevent duplicate tool registration when a profile still loads the old
 *     standalone tools row alongside the bundle;
 *   - detect a data-root mismatch between host and tools before two processes
 *     (or two loads) write to different directories;
 *   - expose the most recent L4 profile injection so `memory_health` can prove
 *     that a profile was actually applied, not merely generated.
 *
 * Nothing here is persisted. It is diagnostic state for the current process.
 */
export const runtime = {
  hostRoot: null,
  toolsRoot: null,
  toolsRegistered: false,
  embeddedTools: false,
  // Last successful L4 injection, consumed by memory_health. `month` is the
  // profile version that was injected, not the current calendar month.
  growthApplied: { applied: false, session: null, month: null, at: null },
}
