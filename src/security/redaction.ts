const sensitiveField = /KEY|PASSWORD|SECRET|TOKEN/iu
const replacement = '[REDACTED]'

/** Replace raw and URI-encoded secret values in text. */
export function redactText(value: string, secrets: readonly string[]): string {
  return secretVariants(secrets).reduce((result, secret) => result.replaceAll(secret, replacement), value)
}

/**
 * Clone plain JSON-like values while removing values identified as secrets.
 * @param value - Value crossing a process or credential boundary.
 * @param secrets - Secret strings that must not appear in the result.
 * @returns a recursively redacted copy.
 */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  assertAcyclic(value, new Set())
  return redact(value, secrets)
}

/** Return an error that is safe to show or log at a process boundary. */
export function sanitizeError(error: unknown, secrets: readonly string[]): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(redactText(message, secrets))
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(item => redact(item, secrets))
  if (!isPlainObject(value)) throw new TypeError('cannot redact a non-plain value')
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveField.test(key) ? replacement : redact(item, secrets),
  ]))
}

function assertAcyclic(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value !== 'object') return
  if (ancestors.has(value)) throw new TypeError('cannot redact cyclic values')
  if (!Array.isArray(value) && !isPlainObject(value)) throw new TypeError('cannot redact a non-plain value')
  ancestors.add(value)
  try {
    for (const item of Array.isArray(value) ? value : Object.values(value)) assertAcyclic(item, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

function secretVariants(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap(secret => secret.length === 0 ? [] : [secret, encodeURIComponent(secret)]))]
    .sort((left, right) => right.length - left.length)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.getPrototypeOf(value) === Object.prototype
}
