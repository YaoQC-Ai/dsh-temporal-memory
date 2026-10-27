/**
 * Logical namespace isolation.
 *
 * A namespace separates memories that must never leak into each other — for
 * example two projects, two clients, or a work/personal split. It is not a
 * security boundary against someone with filesystem access; it is an
 * application-level filter applied to every read path.
 *
 * Records written before namespaces existed have no field and are treated as
 * `default`, so upgrading does not orphan old memories.
 */
export const DEFAULT_NAMESPACE = 'default'

/** Accept either a record or a plain namespace string. */
export function namespaceOf(value) {
  if (typeof value === 'string') return value || DEFAULT_NAMESPACE
  return value?.namespace || DEFAULT_NAMESPACE
}

/** True when a record may be read in the requested namespace. */
export function inNamespace(record, namespace) {
  return !namespace || namespaceOf(record) === namespace
}

/** True when a namespace filter is active and the record belongs elsewhere. */
export function namespaceMismatch(record, namespace) {
  return Boolean(namespace) && namespaceOf(record) !== namespace
}
