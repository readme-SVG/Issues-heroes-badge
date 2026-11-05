import { renderBadge, renderErrorBadge } from '../lib/badge-svg.js';
import { loadPatternIndex } from '../lib/dictionaries.js';
import { selectBadgeEntries } from '../lib/entries.js';
import { fetchGitHubJson, GitHubRequestError } from '../lib/github.js';

const DEFAULT_OWNER = 'readme-SVG';
const DEFAULT_REPO = 'Issues-heroes-badge';
const ISSUES_PER_PAGE = 100;
const CACHE_SECONDS = 60;

/** Identifiers used by GitHub: alphanumerics, hyphen, underscore, dot. */
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Reads a single-valued query parameter.
 *
 * Query strings are caller-controlled: `?user=a&user=b` yields an array, and
 * anything that is not shaped like a GitHub identifier is rejected before it can
 * be spliced into a request path. The default keeps the endpoint usable when a
 * parameter is missing or malformed.
 */
function readIdentifier(value, fallback) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return GITHUB_NAME_RE.test(candidate) ? candidate : fallback;
}

function sendSvg(res, status, body, { cacheSeconds = null } = {}) {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The document is inert: it contains no scripts and imports no styles.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");

  res.setHeader(
    'Cache-Control',
    cacheSeconds === null
      ? 'no-store'
      : `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=300`,
  );

  res.status(status).send(body);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const owner = readIdentifier(req.query?.user, DEFAULT_OWNER);
  const repo = readIdentifier(req.query?.repo, DEFAULT_REPO);

  try {
    const issues = await fetchGitHubJson(
      `/repos/${owner}/${repo}/issues` +
        `?state=all&sort=created&direction=desc&per_page=${ISSUES_PER_PAGE}`,
    );

    if (!Array.isArray(issues)) throw new GitHubRequestError('Unexpected issues payload');

    const patterns = await loadPatternIndex();
    const entries = selectBadgeEntries(issues, { isBanned: (name) => patterns.matches(name) });

    sendSvg(res, 200, renderBadge(entries), { cacheSeconds: CACHE_SECONDS });
  } catch (error) {
    console.error(`Badge rendering failed for ${owner}/${repo}:`, error);

    // Upstream diagnostics stay in the logs: a status code or an internal URL is
    // useful when debugging and noise — or an information leak — in a badge
    // embedded in someone else's README.
    const notFound = error instanceof GitHubRequestError && error.status === 404;
    sendSvg(
      res,
      notFound ? 404 : 502,
      renderErrorBadge(notFound ? 'Repository not found' : 'Badge is temporarily unavailable'),
    );
  }
}
