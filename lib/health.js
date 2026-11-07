/**
 * Deployment diagnostics.
 *
 * The badge endpoint answers with an SVG document, which is exactly what a README
 * needs and exactly what an operator cannot read: a broken deployment and a
 * working one both look like "an image did not load". This module gathers the
 * same information as plain data, so `/api/health` can answer the two questions
 * that matter after a deploy — can the function reach GitHub with the credential
 * it was given, and did the moderation dictionaries load? — without ever
 * revealing the credential itself.
 */

import { loadPatternIndex, resolveDictionarySource } from './dictionaries.js';
import { MAX_BADGE_ENTRIES, selectBadgeEntries } from './entries.js';
import { describeToken, fetchGitHubJson } from './github.js';

export const SERVICE_NAME = 'issues-heroes-badge';

/** Quota GitHub grants to unauthenticated callers; above it a token was used. */
const ANONYMOUS_HOURLY_LIMIT = 60;

/** Same page size the badge endpoint uses, so both observe the same listing. */
const ISSUES_PER_PAGE = 100;

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Formats a dictionary source the way an operator writes it.
 *
 * @param {{ owner: string, name: string, branch: string }} source Resolved source.
 * @returns {string} `owner/name@branch`.
 */
export function formatSource(source) {
  return `${source.owner}/${source.name}@${source.branch}`;
}

/**
 * Summarises a GitHub `/rate_limit` payload.
 *
 * That endpoint does not count against the quota, which makes it the cheapest
 * possible proof that a credential is accepted: an authenticated answer reports
 * a limit far above the anonymous 60 requests per hour.
 *
 * @param {unknown} payload Parsed `/rate_limit` response.
 * @returns {{ limit: number, remaining: number | null, resetAt: string | null,
 *     authenticated: boolean } | null} Summary, or `null` when the payload is not
 *     shaped like GitHub's answer.
 */
export function summarizeRateLimit(payload) {
  const core = payload?.resources?.core;
  if (!core || !Number.isFinite(core.limit)) return null;

  return {
    limit: core.limit,
    remaining: Number.isFinite(core.remaining) ? core.remaining : null,
    resetAt: Number.isFinite(core.reset) ? new Date(core.reset * 1_000).toISOString() : null,
    authenticated: core.limit > ANONYMOUS_HOURLY_LIMIT,
  };
}

/**
 * Collects a health report for one repository.
 *
 * Each probe is isolated: a dictionary outage must not hide the fact that GitHub
 * is reachable, and a missing repository must not hide a misconfigured token.
 * Failures are reported as short messages that contain no URLs and no
 * credentials, because this document is meant to be pasted into an issue.
 *
 * @param {{ owner: string, repo: string }} target Repository to inspect.
 * @param {{ fetchJson?: (path: string) => Promise<unknown>,
 *     loadPatterns?: () => Promise<{ size: number, matches: (value: string) => boolean }> }}
 *     [dependencies] Overridable data sources, used by the tests.
 * @returns {Promise<Record<string, unknown>>} The report.
 */
export async function collectHealth(
  { owner, repo },
  { fetchJson = fetchGitHubJson, loadPatterns = loadPatternIndex } = {},
) {
  const startedAt = Date.now();
  const errors = [];

  const github = { ok: false, token: describeToken(), rateLimit: null };
  const dictionaries = {
    ok: false,
    source: formatSource(resolveDictionarySource()),
    patterns: 0,
  };
  const issues = { ok: false, fetched: 0, accepted: 0, slots: MAX_BADGE_ENTRIES };

  try {
    github.rateLimit = summarizeRateLimit(await fetchJson('/rate_limit'));
    github.ok = true;
  } catch (error) {
    errors.push(`github: ${describeError(error)}`);
  }

  let patterns = null;
  try {
    patterns = await loadPatterns();
    dictionaries.patterns = patterns.size;
    // An empty index means moderation silently degraded to "allow everything",
    // which is a degraded deployment even though the badge still renders.
    dictionaries.ok = patterns.size > 0;
    if (!dictionaries.ok) errors.push('dictionaries: no moderation patterns loaded');
  } catch (error) {
    errors.push(`dictionaries: ${describeError(error)}`);
  }

  try {
    const listing = await fetchJson(
      `/repos/${owner}/${repo}/issues` +
        `?state=all&sort=created&direction=desc&per_page=${ISSUES_PER_PAGE}`,
    );

    if (!Array.isArray(listing)) throw new Error('unexpected issues payload');

    issues.fetched = listing.length;
    issues.accepted = selectBadgeEntries(listing, {
      isBanned: (name) => (patterns ? patterns.matches(name) : false),
    }).length;
    issues.ok = true;
  } catch (error) {
    errors.push(`issues: ${describeError(error)}`);
  }

  return {
    // The badge is only broken when GitHub or the target repository is
    // unreachable; missing dictionaries degrade it and are reported separately.
    ok: github.ok && issues.ok,
    degraded: !dictionaries.ok,
    service: SERVICE_NAME,
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    runtime: {
      node: process.version,
      environment: process.env.VERCEL_ENV ?? 'local',
      url: process.env.VERCEL_URL ?? null,
      productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? null,
    },
    target: { owner, repo },
    github,
    dictionaries,
    issues,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
