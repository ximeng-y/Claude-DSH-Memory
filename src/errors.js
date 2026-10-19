/**
 * Structured errors for every tool result and internal failure.
 *
 * Nothing in this plugin throws a `MemoryError` past the tool boundary: tools
 * convert it into an error result (see src/tools.js). Codes are the contract
 * documented below, so they are exported for tests.
 */

export const CODES = Object.freeze({
  CONFIG_INVALID: 'CM_CONFIG_INVALID',
  NO_SESSION: 'CM_NO_SESSION',
  DIR_UNDETERMINED: 'CM_DIR_UNDETERMINED',
  DIR_NEEDS_MAPPING: 'CM_DIR_NEEDS_MAPPING',
  DIR_UNCONFIRMED: 'CM_DIR_UNCONFIRMED',
  DIR_NOT_FOUND: 'CM_DIR_NOT_FOUND',
  GIT_UNAVAILABLE: 'CM_GIT_UNAVAILABLE',
  GIT_LAYOUT_UNSUPPORTED: 'CM_GIT_LAYOUT_UNSUPPORTED',
  FILE_NOT_FOUND: 'CM_FILE_NOT_FOUND',
  FILE_EXISTS: 'CM_FILE_EXISTS',
  AMBIGUOUS_NAME: 'CM_AMBIGUOUS_NAME',
  REVISION_REQUIRED: 'CM_REVISION_REQUIRED',
  REVISION_MISMATCH: 'CM_REVISION_MISMATCH',
  INVALID_FILENAME: 'CM_INVALID_FILENAME',
  INVALID_TYPE: 'CM_INVALID_TYPE',
  BODY_EMPTY: 'CM_BODY_EMPTY',
  FRONTMATTER_INVALID: 'CM_FRONTMATTER_INVALID',
  INDEX_WRITE_FAILED: 'CM_INDEX_WRITE_FAILED',
  LOCK_TIMEOUT: 'CM_LOCK_TIMEOUT',
  QUERY_EMPTY: 'CM_QUERY_EMPTY',
  PROTECTED_PATH: 'CM_PROTECTED_PATH',
  EXTRACT_ROUTE_MISSING: 'CM_EXTRACT_ROUTE_MISSING',
  EXTRACT_PARSE: 'CM_EXTRACT_PARSE',
  EXTRACT_STALE: 'CM_EXTRACT_STALE',
  INTERNAL: 'CM_INTERNAL',
})

export class MemoryError extends Error {
  /**
   * @param {string} code one of {@link CODES}.
   * @param {string} message human-readable, model-facing explanation.
   * @param {Record<string, unknown>} [details] extra JSON returned to the model.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
    if (details !== undefined) this.details = details
  }

  /** @returns {{ code: string, message: string } & Record<string, unknown>} */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
export function fail(code, message, details) {
  throw new MemoryError(code, message, details)
}

/**
 * Normalize anything thrown by the filesystem or a caller into a MemoryError so
 * a tool can always answer with the same shape.
 *
 * @param {unknown} error
 * @returns {MemoryError}
 */
export function asMemoryError(error) {
  if (error instanceof MemoryError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = /** @type {{ code?: unknown }} */ (error)?.code
  if (code === 'ENOENT') return new MemoryError(CODES.FILE_NOT_FOUND, `目标不存在：${message}`)
  if (code === 'EACCES' || code === 'EPERM') {
    return new MemoryError(CODES.DIR_UNCONFIRMED, `没有权限访问记忆目录：${message}`)
  }
  return new MemoryError(CODES.INTERNAL, message)
}
