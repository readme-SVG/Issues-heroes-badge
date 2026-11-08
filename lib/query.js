/**
 * Request-target parsing shared by every endpoint.
 *
 * Query strings are caller-controlled: `?user=a&user=b` yields an array, and
 * anything that is not shaped like a GitHub identifier is rejected before it can
 * be spliced into a request path. The badge and the health endpoint resolve
 * their target through this module, so the two cannot drift apart.
 */

/** Owner inspected when a request does not name one. */
export const DEFAULT_OWNER = 'readme-SVG';

/** Repository inspected when a request does not name one. */
export const DEFAULT_REPO = 'Issues-heroes-badge';

/** Identifiers used by GitHub: alphanumerics, hyphen, underscore, dot. */
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Reads a single-valued query parameter as a GitHub identifier.
 *
 * The default keeps an endpoint usable when a parameter is missing or malformed
 * instead of failing the whole request.
 *
 * @param {unknown} value Raw query value; arrays and objects are rejected.
 * @param {string} fallback Returned when the value is missing or malformed.
 * @returns {string} An identifier that is safe to interpolate into a path.
 */
export function readIdentifier(value, fallback) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return GITHUB_NAME_RE.test(candidate) ? candidate : fallback;
}

/**
 * Resolves the `?user=&repo=` pair of a request.
 *
 * @param {Record<string, unknown> | null | undefined} query Parsed query string.
 * @returns {{ owner: string, repo: string }} Repository the request is about.
 */
export function readTarget(query) {
  return {
    owner: readIdentifier(query?.user, DEFAULT_OWNER),
    repo: readIdentifier(query?.repo, DEFAULT_REPO),
  };
}
