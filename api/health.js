import { collectHealth } from '../lib/health.js';
import { readTarget } from '../lib/query.js';

/** Diagnostics are cheap but not free; edge caching blunts a refresh loop. */
const CACHE_SECONDS = 30;

function sendJson(res, status, payload, { cacheSeconds = null } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The report describes this deployment and nothing about the caller, so status
  // pages and dashboards on other origins are allowed to read it.
  res.setHeader('Access-Control-Allow-Origin', '*');

  res.setHeader(
    'Cache-Control',
    cacheSeconds === null
      ? 'no-store'
      : `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=60`,
  );

  res.status(status).json(payload);
}

/**
 * JSON diagnostics for this deployment.
 *
 * `GET /api/health` answers `200` when the badge can be rendered and `503` when
 * it cannot, so an uptime monitor needs no JSON parsing to raise an alarm. The
 * body explains which of the three upstream dependencies failed.
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
    const report = await collectHealth({ owner, repo });
    sendJson(res, report.ok ? 200 : 503, report, {
      cacheSeconds: report.ok ? CACHE_SECONDS : null,
    });
  } catch (error) {
    // `collectHealth` isolates its own probes, so reaching this branch means the
    // diagnostics themselves failed; that is still reported as data.
    console.error(`Health check failed for ${owner}/${repo}:`, error);
    sendJson(res, 500, {
      ok: false,
      target: { owner, repo },
      errors: [`health: ${error instanceof Error ? error.message : String(error)}`],
    });
  }
}
