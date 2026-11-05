/**
 * Turns a repository issue listing into the entries drawn on the badge.
 *
 * This is the single place where admission rules live. The serverless endpoint
 * and the static validator both follow the same rules, and keeping them here
 * avoids the drift the two copies used to have.
 */

import { pickFallbackColor } from './badge-svg.js';
import { parseIssueTitle } from './issue-title.js';

export const VALID_LABEL = 'Valid';
export const MAX_ENTRIES_PER_AUTHOR = 2;
export const MAX_BADGE_ENTRIES = 10;

/**
 * GitHub's `/issues` endpoint returns pull requests alongside issues; they are
 * not badge submissions and must be ignored.
 */
function isPullRequest(issue) {
  return Boolean(issue?.pull_request);
}

function hasLabel(issue, label) {
  return Array.isArray(issue?.labels) && issue.labels.some((entry) => entry?.name === label);
}

function authorOf(issue) {
  return String(issue?.user?.login ?? '').toLowerCase();
}

/**
 * Selects the entries that belong on the badge.
 *
 * Ordering follows the API response (newest first), so the badge shows the most
 * recent submissions. The result is capped at one slot per display name and two
 * slots per author to keep the board varied, and is limited to the number of
 * slots the renderer can display.
 *
 * @param {ReadonlyArray<unknown>} issues Issues as returned by the GitHub API.
 * @param {{ isBanned: (name: string) => boolean, random?: () => number }} options
 *     Moderation predicate and optional randomness source for fallback colours.
 * @returns {Array<{ name: string, color: string }>} Entries ready for rendering.
 */
export function selectBadgeEntries(issues, { isBanned, random = Math.random }) {
  const entries = [];
  const seenNames = new Set();
  const perAuthor = new Map();

  for (const issue of issues) {
    if (entries.length >= MAX_BADGE_ENTRIES) break;
    if (isPullRequest(issue) || !hasLabel(issue, VALID_LABEL)) continue;

    const parsed = parseIssueTitle(issue.title);
    if (!parsed) continue;

    const author = authorOf(issue);
    const acceptedForAuthor = perAuthor.get(author) ?? 0;
    if (acceptedForAuthor >= MAX_ENTRIES_PER_AUTHOR) continue;

    const dedupeKey = parsed.name.toLowerCase();
    if (seenNames.has(dedupeKey) || isBanned(parsed.name)) continue;

    // The quota is consumed only by entries that actually reach the board.
    perAuthor.set(author, acceptedForAuthor + 1);
    seenNames.add(dedupeKey);
    entries.push({
      name: parsed.name,
      color: parsed.color ?? pickFallbackColor(random),
    });
  }

  return entries;
}
