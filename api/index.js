import { renderBadge, renderErrorBadge } from '../lib/badge-svg.js';
import { loadPatternIndex } from '../lib/dictionaries.js';
import { selectBadgeEntries } from '../lib/entries.js';
import { fetchGitHubJson, GitHubRequestError } from '../lib/github.js';
import { readTarget } from '../lib/query.js';

const ISSUES_PER_PAGE = 100;
const CACHE_SECONDS = 60;

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

/**
 * Renders the heroes board as an animated SVG badge.
 *
 * `GET /api?user=<owner>&repo=<name>`; both parameters are optional and fall
 * back to the repository this project ships for. Every failure is rendered as an
 * error badge, so an embedded image never turns into a broken icon, and
 * `/api/health` reports the same state as JSON for whoever operates the deploy.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const { owner, repo } = readTarget(req.query);

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
