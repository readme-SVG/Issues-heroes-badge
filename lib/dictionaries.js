/**
 * Remote moderation dictionary loading.
 *
 * The dictionaries live in a separate repository and change rarely, while the
 * badge endpoint is hit on every README view. Two mechanisms keep the cost low:
 *
 *   - a TTL cache, refreshed in the background once it expires, so a warm
 *     container never blocks a request on GitHub;
 *   - single-flight loading, so concurrent cold-start requests share one
 *     fetch instead of each issuing its own.
 */

import { fetchRawFile, listFiles } from './github.js';
import { createPatternIndex, parseDictionary } from './patterns.js';

const CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_REPO = 'readme-SVG/Banned-words';
const DEFAULT_BRANCH = 'main';
const DICTIONARY_DIRECTORY = 'Banned-words-list';
const DICTIONARY_EXTENSION = '.txt';

/** Concurrency cap for dictionary downloads; keeps GitHub from throttling us. */
const DOWNLOAD_CONCURRENCY = 6;

/** Identifiers used by GitHub: alphanumerics, hyphen, underscore, dot. */
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

const cache = new Map();
const inFlight = new Map();

let emptyIndex = null;

function emptyPatternIndex() {
  emptyIndex ??= createPatternIndex([]);
  return emptyIndex;
}

/**
 * Reports which moderation source the loader resolved.
 *
 * Exported for diagnostics: an operator looking at a failing badge needs to know
 * which repository and branch the dictionaries were read from.
 *
 * @returns {{ owner: string, name: string, branch: string }} Validated source.
 */
export function resolveDictionarySource() {
  const repo = (process.env.BANNED_WORDS_REPO || DEFAULT_REPO).trim();
  const branch = (process.env.BANNED_WORDS_BRANCH || DEFAULT_BRANCH).trim();
  const [owner, name, ...rest] = repo.split('/');

  // A malformed value is a deployment error, not a user error: fall back to the
  // public dictionaries instead of requesting an arbitrary URL.
  if (rest.length > 0 || !GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(name ?? '')) {
    return { owner: 'readme-SVG', name: 'Banned-words', branch: DEFAULT_BRANCH };
  }

  return {
    owner,
    name,
    branch: GITHUB_NAME_RE.test(branch) ? branch : DEFAULT_BRANCH,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function download(source, files) {
  const documents = await mapWithConcurrency(files, DOWNLOAD_CONCURRENCY, async (filePath) => {
    try {
      return await fetchRawFile(source.owner, source.name, source.branch, filePath);
    } catch (error) {
      // A single unavailable file must not invalidate the whole index.
      console.warn(`Skipping dictionary "${filePath}": ${error.message}`);
      return '';
    }
  });

  return createPatternIndex(documents.flatMap(parseDictionary));
}

async function refresh(source, { failFast = false } = {}) {
  const key = `${source.owner}/${source.name}@${source.branch}`;

  try {
    const files = await listFiles(
      source.owner,
      source.name,
      source.branch,
      DICTIONARY_DIRECTORY,
      DICTIONARY_EXTENSION,
    );

    if (files.length === 0) throw new Error('dictionary listing is empty');

    const index = await download(source, files);
    cache.set(key, { index, expiresAt: Date.now() + CACHE_TTL_MS });
    return index;
  } catch (error) {
    console.error(`Unable to refresh banned patterns: ${error.message}`);

    const stale = cache.get(key);
    if (stale) {
      // Serve the stale index rather than silently dropping moderation.
      cache.set(key, { ...stale, expiresAt: Date.now() + CACHE_TTL_MS });
      return stale.index;
    }

    if (failFast) throw error;
    return emptyPatternIndex();
  }
}

/**
 * Returns the moderation index for the configured dictionary repository.
 *
 * @param {{ failFast?: boolean }} [options] When `failFast` is set and no index
 *     has ever been loaded, the error is propagated instead of degrading to an
 *     empty index. Useful for callers that must not run unmoderated.
 * @returns {Promise<{ size: number, matches: (value: string) => boolean }>} Compiled matchers.
 */
export function loadPatternIndex({ failFast = false } = {}) {
  const source = resolveDictionarySource();
  const key = `${source.owner}/${source.name}@${source.branch}`;
  const cached = cache.get(key);

  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.index);

  // Serve stale content immediately and refresh behind the scenes: README badge
  // latency matters more than dictionary freshness measured in seconds.
  if (cached) {
    if (!inFlight.has(key)) {
      inFlight.set(
        key,
        refresh(source).finally(() => inFlight.delete(key)),
      );
    }
    return Promise.resolve(cached.index);
  }

  let pending = inFlight.get(key);
  if (!pending) {
    pending = refresh(source, { failFast }).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }

  return pending;
}
