/**
 * Minimal GitHub REST client shared by the serverless badge and the dictionary
 * loader.
 *
 * Every outbound request goes through `request()`, so the API version, user
 * agent, timeout and error contract stay in one place instead of being repeated
 * at each call site.
 */

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const GITHUB_API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = 'issues-heroes-badge';

/** Raised when GitHub answers with a non-2xx status or the request times out. */
export class GitHubRequestError extends Error {
  constructor(message, { status = 0, cause } = {}) {
    super(message, { cause });
    this.name = 'GitHubRequestError';
    this.status = status;
  }
}

/** Environment variables that may hold a credential, in precedence order. */
const TOKEN_ENV_VARS = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN']);

/**
 * Normalises a credential read from the environment.
 *
 * Tokens are pasted into a deployment dashboard, where a trailing newline or a
 * pair of surrounding quotes is easy to add and impossible to see. Both turn an
 * otherwise valid token into a 401, so they are stripped here rather than
 * diagnosed in production.
 *
 * @param {unknown} value Raw environment value.
 * @returns {string | null} The credential, or `null` when there is none.
 */
function normalizeToken(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns the configured GitHub credential.
 *
 * @returns {string | null} The token, or `null` for unauthenticated requests.
 */
export function resolveToken() {
  for (const name of TOKEN_ENV_VARS) {
    const token = normalizeToken(process.env[name]);
    if (token) return token;
  }

  return null;
}

/**
 * Describes the configured credential without revealing it.
 *
 * Diagnostics need to know whether a deployment runs authenticated and which
 * variable supplied the token; the value itself must never leave the function.
 *
 * @returns {{ configured: boolean, source: string | null }} Credential metadata.
 */
export function describeToken() {
  for (const name of TOKEN_ENV_VARS) {
    if (normalizeToken(process.env[name])) return { configured: true, source: name };
  }

  return { configured: false, source: null };
}

function buildHeaders(url, token) {
  const headers = {
    Accept: url.startsWith(GITHUB_RAW_BASE) ? 'text/plain' : 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };

  // Credentials are scoped to the API host. Sending the token to
  // raw.githubusercontent.com would leak it to a host that does not need it.
  if (token && url.startsWith(GITHUB_API_BASE)) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

/**
 * Issues a single request and turns every non-2xx answer into a typed error.
 *
 * @param {string} url Absolute request URL.
 * @param {{ token: string | null, accept?: string }} options Credential and media type.
 * @returns {Promise<Response>} A successful response.
 */
async function send(url, { token, accept }) {
  const headers = buildHeaders(url, token);
  if (accept) headers.Accept = accept;

  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GitHubRequestError('GitHub request failed', { cause });
  }

  if (!response.ok) {
    // An exhausted quota looks exactly like a permission error from the outside,
    // so it is named in the logs where the difference can still be acted on.
    if (response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0') {
      const scope = token && url.startsWith(GITHUB_API_BASE) ? 'token' : 'anonymous';
      console.warn(`GitHub ${scope} rate limit exhausted for ${url}`);
    }

    throw new GitHubRequestError(`GitHub responded with HTTP ${response.status}`, {
      status: response.status,
    });
  }

  return response;
}

async function request(url, { token = resolveToken(), accept } = {}) {
  try {
    return await send(url, { token, accept });
  } catch (error) {
    // A rejected credential must not take the badge down. Everything this project
    // reads is public, so the same request is repeated anonymously — at a lower
    // quota, but still answered — instead of failing outright.
    const credentialRejected =
      token !== null &&
      url.startsWith(GITHUB_API_BASE) &&
      error instanceof GitHubRequestError &&
      error.status === 401;

    if (!credentialRejected) throw error;

    console.warn('GitHub rejected the configured token (HTTP 401); retrying anonymously.');
    return send(url, { token: null, accept });
  }
}

/**
 * Fetches and parses a JSON document from the GitHub REST API.
 *
 * @param {string} path API path beginning with a slash, e.g. `/repos/o/r/issues`.
 * @param {{ token?: string | null }} [options] Optional token override.
 * @returns {Promise<unknown>} The parsed JSON body.
 */
export async function fetchGitHubJson(path, options = {}) {
  const response = await request(`${GITHUB_API_BASE}${path}`, options);
  return response.json();
}

/**
 * Fetches a text document from `raw.githubusercontent.com`.
 *
 * @param {string} owner Repository owner.
 * @param {string} repo Repository name.
 * @param {string} branch Branch, tag or commit SHA.
 * @param {string} path File path inside the repository.
 * @returns {Promise<string>} The raw file contents.
 */
export async function fetchRawFile(owner, repo, branch, path) {
  const url = `${GITHUB_RAW_BASE}/${owner}/${repo}/${branch}/${path}`;
  const response = await request(url, { token: null });
  return response.text();
}

/**
 * Lists the blob entries under a directory of a repository tree.
 *
 * GitHub truncates trees larger than 100k entries, in which case the caller
 * cannot rely on the listing being complete; such responses are rejected
 * instead of silently returning a partial dictionary.
 *
 * @param {string} owner Repository owner.
 * @param {string} repo Repository name.
 * @param {string} branch Branch name.
 * @param {string} directory Directory prefix, without a trailing slash.
 * @param {string} extension Required file extension, e.g. `.txt`.
 * @param {{ token?: string | null }} [options] Optional token override.
 * @returns {Promise<string[]>} Matching file paths.
 */
export async function listFiles(owner, repo, branch, directory, extension, options = {}) {
  const prefix = `${directory.replace(/\/+$/, '')}/`;
  const path = `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const tree = await fetchGitHubJson(path, options);

  if (!tree || !Array.isArray(tree.tree)) {
    throw new GitHubRequestError('GitHub returned an unexpected tree payload');
  }
  if (tree.truncated) {
    throw new GitHubRequestError('GitHub truncated the repository tree');
  }

  return tree.tree
    .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path)
    .filter((filePath) => filePath.startsWith(prefix) && filePath.endsWith(extension))
    .sort();
}
