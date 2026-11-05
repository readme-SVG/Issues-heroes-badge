/**
 * Standalone issue-title validator.
 *
 * The page is hosted on GitHub Pages, so it has no backend of its own and talks
 * to GitHub directly. Two constraints shape the code below:
 *
 *   - unauthenticated GitHub API calls are limited to 60 per hour per IP, so the
 *     dictionary tree is fetched once per session and cached, not per keystroke;
 *   - a failed lookup must never be reported as "valid", because that would tell
 *     a contributor their name is acceptable when nobody actually checked.
 *
 * The workflow in `.github/workflows/validate-issue.yml` stays authoritative; this
 * page is a preview of what the bot will do.
 */

const MAX_TITLE_LENGTH = 60;
const MAX_NAME_LENGTH = 40;

const GLOBAL_SOURCE = { owner: 'readme-SVG', repo: 'Banned-words', branch: 'main' };
const LOCAL_SOURCE = { owner: 'readme-SVG', repo: 'Issues-heroes-badge', branch: 'main' };

const GLOBAL_DIRECTORY = 'Banned-words-list/';
const LOCAL_DIRECTORY = 'banned-words/';

const REQUEST_TIMEOUT_MS = 8_000;

const TITLE_RE = new RegExp(
  "^<\\s*HeroeName\\s*\\|\\s*([a-zA-Z\\u0400-\\u04FF0-9_ .!,?:;'-]{1,40})\\s*" +
    '(?:\\|\\s*(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\\s*)?>\\s*$',
  'i',
);

const STAR = 1;
const PLUS = 2;

const WHITESPACE = new Set(
  ' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
);

/**
 * Matches a compiled rule against a value using dynamic programming.
 *
 * A RegExp built from `*`-expanded rules backtracks, so a hostile dictionary entry
 * can freeze the tab. The table below is O(rule × input) unconditionally.
 */
function matchTokens(tokens, chars) {
  const length = chars.length;
  let next = new Uint8Array(length + 1);
  let current = new Uint8Array(length + 1);
  next[length] = 1;

  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    current.fill(0);
    const token = tokens[i];

    if (token === STAR) {
      current[length] = next[length];
      for (let j = length - 1; j >= 0; j -= 1) current[j] = next[j] | current[j + 1];
    } else if (token === PLUS) {
      for (let j = length - 1; j >= 0; j -= 1) {
        current[j] = WHITESPACE.has(chars[j]) ? 0 : next[j + 1] | current[j + 1];
      }
    } else {
      for (let j = length - 1; j >= 0; j -= 1) current[j] = chars[j] === token ? next[j + 1] : 0;
    }

    const swap = next;
    next = current;
    current = swap;
  }

  return next[0] === 1;
}

function tokenize(rule) {
  return Array.from(rule, (character) => {
    if (character === '*') return STAR;
    if (character === '+') return PLUS;
    return character;
  });
}

function compileRule(rule) {
  const tokens = tokenize(rule.replace(/\*{2,}/gu, '*'));
  const head = tokens[0] === STAR;
  const tail = tokens.at(-1) === STAR;
  const body = tokens.slice(head ? 1 : 0, tail ? -1 : undefined);

  // Wildcards on the edges only: the rule is a literal with slack, so a native
  // string test is enough and the table is never allocated.
  if (body.length > 0 && body.every((token) => typeof token === 'string')) {
    const literal = body.join('');
    if (head && tail) return (value) => value.includes(literal);
    if (head) return (value) => value.endsWith(literal);
    if (tail) return (value) => value.startsWith(literal);
    return (value) => value === literal;
  }

  return (value) => matchTokens(tokens, Array.from(value));
}

/**
 * Compiles a dictionary file into a matcher.
 *
 * @param {string} text Raw dictionary contents.
 * @returns {{ rules: string[], matches: (value: string) => boolean }} Compiled
 *     matcher plus the normalised rule list it was built from.
 */
function compileDictionary(text) {
  const rules = [];
  const literals = new Set();
  const matchers = [];

  for (const line of text.split('\n')) {
    const rule = line.trim().toLowerCase();
    if (!rule) continue;

    rules.push(rule);

    if (!/[*+]/.test(rule) && !rule.includes('&&')) {
      literals.add(rule);
      continue;
    }

    const parts = rule.split('&&').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    const compiled = parts.map(compileRule);
    matchers.push((value) => compiled.every((matcher) => matcher(value)));
  }

  const atomMatchers = new Map();

  return {
    rules,
    matches(value) {
      if (literals.has(value)) return true;
      return matchers.some((matcher) => matcher(value));
    },
    matchesRule(rule, value) {
      if (!atomMatchers.has(rule)) {
        const parts = rule.split('&&').map((part) => part.trim()).filter(Boolean);
        atomMatchers.set(rule, parts.map(compileRule));
      }
      return atomMatchers.get(rule).every((matcher) => matcher(value));
    },
  };
}

function treeUrl({ owner, repo, branch }) {
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
}

function rawUrl({ owner, repo, branch }, path) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { Accept: 'text/plain' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function listDictionaryFiles(source, directory) {
  const response = await fetch(treeUrl(source), {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const tree = await response.json();
  if (tree.truncated) throw new Error('repository listing is truncated');

  return (tree.tree ?? [])
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        typeof entry.path === 'string' &&
        entry.path.startsWith(directory) &&
        entry.path.endsWith('.txt'),
    )
    .map((entry) => entry.path)
    .sort();
}

/**
 * Loads every dictionary of a repository once per session.
 *
 * Results are memoised in a module-level promise, so repeat validations cost
 * nothing and a double click cannot fire two identical download storms.
 */
function createDictionaryLoader() {
  const pending = new Map();

  return function load(source, directory) {
    const key = `${source.owner}/${source.repo}|${directory}`;
    if (pending.has(key)) return pending.get(key);

    const request = (async () => {
      const files = await listDictionaryFiles(source, directory);
      const documents = await Promise.all(
        files.map((path) =>
          fetchText(rawUrl(source, path)).catch(() => ''),
        ),
      );

      const byFile = new Map();
      files.forEach((path, index) => {
        const dictionary = compileDictionary(documents[index]);
        if (dictionary.rules.length > 0) byFile.set(path, dictionary);
      });

      if (byFile.size === 0) throw new Error('no dictionaries could be loaded');
      return byFile;
    })();

    // A failed load is not cached: the next attempt should be able to succeed.
    request.catch(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}

const loadDictionaries = createDictionaryLoader();

function findMatch(dictionaries, value) {
  for (const [path, dictionary] of dictionaries) {
    // Report the rule the contributor can look up in the file, which is more
    // useful than a bare "blocked" verdict.
    for (const rule of dictionary.rules) {
      if (dictionary.matchesRule(rule, value)) return { path, rule };
    }
  }

  return null;
}

/**
 * Runs the full validation cascade.
 *
 * @param {string} title Issue title as typed by the contributor.
 * @returns {Promise<{ state: 'invalid' | 'suspicious' | 'valid' | 'unknown',
 *     lines: string[] }>} Result state and human-readable explanation.
 */
export async function validateTitle(title) {
  const trimmed = title.trim();
  if (!trimmed) return { state: 'invalid', lines: ['Enter an issue title first.'] };

  if (trimmed.length > MAX_TITLE_LENGTH) {
    return {
      state: 'invalid',
      lines: [
        `Title is ${trimmed.length} characters long; the limit is ${MAX_TITLE_LENGTH}.`,
      ],
    };
  }

  const match = TITLE_RE.exec(trimmed);
  if (!match) {
    return {
      state: 'invalid',
      lines: [
        'Expected `<HeroeName|Username>` or `<HeroeName|Username|#RRGGBB>` with no extra text.',
      ],
    };
  }

  const name = match[1].trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return { state: 'invalid', lines: ['Username must be 1 to 40 characters long.'] };
  }

  const normalized = name.toLowerCase();

  let globalDictionaries;
  try {
    globalDictionaries = await loadDictionaries(GLOBAL_SOURCE, GLOBAL_DIRECTORY);
  } catch (error) {
    return {
      state: 'unknown',
      lines: [
        'The title is well formed, but the global dictionaries could not be read,',
        `so banned words were not checked (${error.message}).`,
        'The workflow will run the full check when the issue is created.',
      ],
    };
  }

  const globalMatch = findMatch(globalDictionaries, normalized);
  if (globalMatch) {
    return {
      state: 'invalid',
      lines: [
        'Username contains a globally banned word.',
        `File: ${globalMatch.path}`,
        `Rule: ${globalMatch.rule}`,
      ],
    };
  }

  let localDictionaries;
  try {
    localDictionaries = await loadDictionaries(LOCAL_SOURCE, LOCAL_DIRECTORY);
  } catch (error) {
    return {
      state: 'unknown',
      lines: [
        'The title is well formed and passes the global dictionaries,',
        `but the local dictionaries could not be read (${error.message}).`,
      ],
    };
  }

  const localMatch = findMatch(localDictionaries, normalized);
  if (localMatch) {
    return {
      state: 'suspicious',
      lines: [
        'The title is valid, but the username matches a local dictionary entry.',
        'This is logged for manual review and does not block the submission.',
        `File: ${localMatch.path}`,
        `Rule: ${localMatch.rule}`,
      ],
    };
  }

  return { state: 'valid', lines: ['The title is valid and no dictionary entry matches.'] };
}
