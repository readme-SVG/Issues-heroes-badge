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

export function resolveToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
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

async function request(url, { token = resolveToken(), accept } = {}) {
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
    throw new GitHubRequestError(`GitHub responded with HTTP ${response.status}`, {
      status: response.status,
    });
  }

  return response;
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
