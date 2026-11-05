/**
 * Moderation pattern engine.
 *
 * Dictionaries are plain text files with one rule per line. A rule may use
 * three constructs:
 *
 *   *        any run of characters, including whitespace
 *   +        one or more non-whitespace characters
 *   &&       every sub-rule must match the same value
 *
 * Rules without wildcards are exact matches and live in a Set, which is the
 * common case in the shipped dictionaries and keeps lookups O(1).
 *
 * Wildcard rules are matched with a dynamic-programming matcher rather than a
 * RegExp. Handing `*`-expanded patterns to the regex engine makes the cost grow
 * with the number of backtracking paths, so a single hostile dictionary entry
 * (`*a*a*a*a*b`) can pin a CPU core for minutes. The DP matcher is O(rule ×
 * input) in every case, needs no input length limit, and is the reason this
 * module can run on a hot request path.
 *
 * Values passed to `matches()` are normalised (trimmed, lowercased) by the index
 * itself; callers never need to pre-process user input.
 */

/** Length cap for a single rule — longer lines are corrupt data, not filters. */
const MAX_RULE_LENGTH = 200;

const STAR = 1;
const PLUS = 2;

/** Code points that `\s` would match, used by the `+` operator. */
const WHITESPACE = new Set(' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff');

function tokenize(rule) {
  const tokens = [];

  for (const character of rule) {
    if (character === '*') tokens.push(STAR);
    else if (character === '+') tokens.push(PLUS);
    else tokens.push(character);
  }

  return tokens;
}

/**
 * Full-match evaluation of a token list against a value.
 *
 * `rows` are the classic two-row DP state: row `i` records whether
 * `tokens[i..]` matches `chars[j..]`. Memory is O(input), time is O(rule × input)
 * with no recursion and no backtracking.
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
      for (let j = length - 1; j >= 0; j -= 1) {
        current[j] = next[j] | current[j + 1];
      }
    } else if (token === PLUS) {
      for (let j = length - 1; j >= 0; j -= 1) {
        current[j] = WHITESPACE.has(chars[j]) ? 0 : next[j + 1] | current[j + 1];
      }
    } else {
      for (let j = length - 1; j >= 0; j -= 1) {
        current[j] = chars[j] === token ? next[j + 1] : 0;
      }
    }

    const swap = next;
    next = current;
    current = swap;
  }

  return next[0] === 1;
}

/**
 * Longest run of literal characters in a token list.
 *
 * Used as a cheap pre-filter: a native `startsWith`/`endsWith`/`includes` check
 * rejects the vast majority of candidates before the DP matcher runs.
 */
function longestLiteralRun(tokens) {
  let best = { start: -1, length: 0, text: '' };
  let start = -1;
  let text = '';

  tokens.forEach((token, index) => {
    if (typeof token === 'string') {
      if (start === -1) start = index;
      text += token;
      return;
    }

    if (text.length > best.length) best = { start, length: text.length, text };
    start = -1;
    text = '';
  });

  if (text.length > best.length) best = { start, length: text.length, text };
  return best;
}

function createPrefilter(tokens) {
  const run = longestLiteralRun(tokens);
  if (run.length === 0) return () => true;

  if (run.start === 0) {
    return (value) => value.startsWith(run.text);
  }
  if (run.start + run.length === tokens.length) {
    return (value) => value.endsWith(run.text);
  }
  return (value) => value.includes(run.text);
}

function compileWildcardRule(rule) {
  if (rule.length > MAX_RULE_LENGTH) return null;

  // `**` and `***` behave like a single `*`; collapsing them keeps the DP table
  // small and the intent obvious.
  const tokens = tokenize(rule.replace(/\*{2,}/gu, '*'));

  // A rule whose wildcards sit only at the edges is a literal with slack, so a
  // native string test replaces the whole DP pass. That covers the bulk of the
  // shipped dictionaries (`*suffix`, `prefix*`, `*fragment*`).
  const head = tokens[0] === STAR;
  const tail = tokens.at(-1) === STAR;
  const body = tokens.slice(head ? 1 : 0, tail ? -1 : undefined);

  if (body.length > 0 && body.every((token) => typeof token === 'string')) {
    const literal = body.join('');
    if (head && tail) return (value) => value.includes(literal);
    if (head) return (value) => value.endsWith(literal);
    if (tail) return (value) => value.startsWith(literal);
    return (value) => value === literal;
  }

  const prefilter = createPrefilter(tokens);

  return (value) => prefilter(value) && matchTokens(tokens, Array.from(value));
}

function compileSingleRule(rule) {
  if (!/[*+]/u.test(rule)) return (value) => value === rule;
  return compileWildcardRule(rule);
}

function compileRule(rule) {
  const parts = rule.split('&&').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const compiled = parts.map(compileSingleRule);
  if (compiled.some((matcher) => matcher === null)) return null;

  return compiled.length === 1
    ? compiled[0]
    : (value) => compiled.every((matcher) => matcher(value));
}

/**
 * Builds an immutable matcher over a list of dictionary lines.
 *
 * @param {Iterable<string>} rules Raw dictionary lines; blanks and duplicates
 *     are ignored.
 * @returns {{ size: number, matches: (value: string) => boolean }} An index whose
 *     `matches()` reports whether a value violates any rule.
 */
export function createPatternIndex(rules) {
  const literals = new Set();
  const matchers = [];

  for (const rawRule of rules) {
    if (typeof rawRule !== 'string') continue;

    const rule = rawRule.trim().toLowerCase();
    if (!rule) continue;

    if (!/[*+]/.test(rule) && !rule.includes('&&')) {
      literals.add(rule);
      continue;
    }

    const matcher = compileRule(rule);
    if (matcher) matchers.push(matcher);
  }

  return {
    size: literals.size + matchers.length,

    matches(value) {
      const candidate = String(value ?? '').trim().toLowerCase();
      if (!candidate) return false;
      if (literals.has(candidate)) return true;
      return matchers.some((matcher) => matcher(candidate));
    },
  };
}

/**
 * Splits a raw dictionary file into unique, normalised rules.
 *
 * @param {string} text Contents of a dictionary file.
 * @returns {string[]} Lowercased rules in file order, without blanks.
 */
export function parseDictionary(text) {
  if (typeof text !== 'string') return [];

  const rules = [];
  const seen = new Set();

  for (const line of text.split('\n')) {
    const rule = line.trim().toLowerCase();
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    rules.push(rule);
  }

  return rules;
}
