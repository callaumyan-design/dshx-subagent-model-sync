// dshx-subagent-model-sync — pure merge logic.
//
// No Cordis, no IO: plain data in, plain data out. Everything the plugin
// decides about the official `subagent-model-selection-settings.allowedModels`
// list is computed here so it can be unit-tested without a Harness.
//
// THE SHADOW RULE (the whole point of this plugin):
//
//   * `shadow` records exactly which allowlist entries THIS PLUGIN wrote.
//   * Manual entries (added by the user in the official settings UI) never
//     enter the shadow, so they are never withdrawn by us.
//   * A shadow entry is withdrawn only when it is no longer desired (its
//     model left the catalog, it was excluded, or its provider was
//     deselected) AND its provider's catalog was successfully read.
//   * A provider whose catalog could NOT be read is "unknown": its shadow
//     entries are kept as-is — a transient catalog failure must never be
//     mistaken for an empty catalog.
//
// Verified against @deepseek-ai/dsh-tool-subagent 0.2.2-rc.3:
// the official schema is an exact-route array `{provider, model}` with no
// wildcards, and the official runtime rejects duplicates and empty lists
// while enabled.

/** Opaque identity for one exact provider/model route.
 * @param {{provider: string, model: string}} route
 * @returns {string}
 */
export function routeKey(route) {
  return `${route.provider}\u0000${route.model}`
}

/**
 * Normalize one candidate route; malformed entries yield undefined.
 * @param {unknown} value
 * @returns {{provider: string, model: string} | undefined}
 */
function normalizeRoute(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { provider, model } = value
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Deduplicate an array of routes, preserving first-seen order and dropping
 * malformed entries. The official runtime rejects duplicate routes, so every
 * list we produce must be duplicate-free.
 * @param {ReadonlyArray<unknown>} routes
 * @returns {Array<{provider: string, model: string}>}
 */
export function dedupeRoutes(routes) {
  const seen = new Set()
  const out = []
  for (const candidate of routes) {
    const route = normalizeRoute(candidate)
    if (route === undefined) continue
    const key = routeKey(route)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(route)
  }
  return out
}

/** Ordered equality of two deduplicated route lists.
 * @param {ReadonlyArray<{provider: string, model: string}>} left
 * @param {ReadonlyArray<{provider: string, model: string}>} right
 * @returns {boolean}
 */
function sameRoutes(left, right) {
  if (left.length !== right.length) return false
  return left.every((route, index) => routeKey(route) === routeKey(right[index]))
}

/**
 * Compute one sync step.
 *
 * Inputs are detached plain data:
 * - `current`  — the official allowlist as stored right now (manual + plugin
 *   entries together; the official schema guarantees no duplicates, but this
 *   function still deduplicates defensively).
 * - `shadow`   — routes previously written by this plugin (its managedRoutes).
 * - `selected` — provider ids the user selected in this plugin's settings.
 * - `catalog`  — exact model ids per successfully read selected provider
 *   (`ctx.llm.listModels(provider)` output projected to ids).
 * - `failed`   — selected provider ids whose catalog could not be read or that
 *   are not currently registered.
 * - `exclude`  — routes the user excluded from automatic sync.
 *
 * @param {object} input
 * @param {ReadonlyArray<unknown>} input.current
 * @param {ReadonlyArray<unknown>} input.shadow
 * @param {ReadonlyArray<string>} input.selected
 * @param {Record<string, ReadonlyArray<string>>} input.catalog
 * @param {ReadonlyArray<string>} input.failed
 * @param {ReadonlyArray<unknown>} input.exclude
 * @returns {{
 *   next: Array<{provider: string, model: string}>,
 *   nextShadow: Array<{provider: string, model: string}>,
 *   added: Array<{provider: string, model: string}>,
 *   removed: Array<{provider: string, model: string}>,
 *   retainedUnknown: Array<{provider: string, model: string}>,
 *   unchanged: boolean,
 * }}
 */
export function computeSyncStep({ current, shadow, selected, catalog, failed, exclude }) {
  const currentRoutes = dedupeRoutes(current)
  const shadowRoutes = dedupeRoutes(shadow)
  const failedSet = new Set(failed)
  const excludedKeys = new Set(dedupeRoutes(exclude).map(routeKey))

  // Desired: every model of every successfully read selected provider, minus
  // excluded routes, in provider-then-catalog order.
  const desired = []
  const desiredKeys = new Set()
  for (const provider of selected) {
    if (failedSet.has(provider)) continue
    const models = catalog[provider]
    if (!Array.isArray(models)) continue
    for (const model of models) {
      const route = normalizeRoute({ provider, model })
      if (route === undefined) continue
      const key = routeKey(route)
      if (desiredKeys.has(key) || excludedKeys.has(key)) continue
      desiredKeys.add(key)
      desired.push(route)
    }
  }

  // Stale plugin-managed routes: no longer desired and their provider's
  // catalog was read successfully. A failed provider is unknown, never stale.
  const staleKeys = new Set()
  for (const route of shadowRoutes) {
    const key = routeKey(route)
    if (desiredKeys.has(key)) continue
    if (failedSet.has(route.provider)) continue
    staleKeys.add(key)
  }

  // Shadow entries kept only because their catalog read failed; reported so
  // callers can warn instead of pretending everything is consistent.
  const retainedUnknown = shadowRoutes.filter(route =>
    !desiredKeys.has(routeKey(route)) && failedSet.has(route.provider))

  // Next: keep every current entry that is not being withdrawn (this always
  // includes manual entries — they are never in the shadow), then append
  // newly desired routes in catalog order.
  const keep = currentRoutes.filter(route => !staleKeys.has(routeKey(route)))
  const currentKeys = new Set(currentRoutes.map(routeKey))
  const added = desired.filter(route => !currentKeys.has(routeKey(route)))
  const next = [...keep, ...added]

  // Next shadow: old managed routes that are still desired and still present
  // in the next list, plus everything this step actually wrote. Two rules keep
  // it conservative:
  //   * A manual entry that overlaps a desired route never enters the shadow
  //     (it was in `current` before we ever wrote it), so a later catalog
  //     removal cannot withdraw it.
  //   * A managed route whose provider's catalog could not be read stays in
  //     the shadow (it is "unknown", not "unwanted"): the plugin keeps owning
  //     it so a later successful read can withdraw it correctly.
  const nextKeys = new Set(next.map(routeKey))
  const nextShadow = dedupeRoutes([
    ...shadowRoutes.filter(route => {
      const key = routeKey(route)
      return (desiredKeys.has(key) || failedSet.has(route.provider)) && nextKeys.has(key)
    }),
    ...added,
  ])

  const removed = currentRoutes.filter(route => staleKeys.has(routeKey(route)))
  const unchanged = sameRoutes(currentRoutes, next) && sameRoutes(shadowRoutes, nextShadow)

  return { next, nextShadow, added, removed, retainedUnknown, unchanged }
}
