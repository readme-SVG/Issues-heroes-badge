import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { BADGE_SLOTS, pickFallbackColor, renderBadge, renderErrorBadge } from '../lib/badge-svg.js';
import { selectBadgeEntries } from '../lib/entries.js';
import { describeToken, fetchGitHubJson, fetchRawFile, resolveToken } from '../lib/github.js';
import { MAX_NAME_LENGTH, normalizeHexColor, parseIssueTitle } from '../lib/issue-title.js';
import { createPatternIndex, parseDictionary } from '../lib/patterns.js';
import { DEFAULT_OWNER, DEFAULT_REPO, readIdentifier, readTarget } from '../lib/query.js';
import { escapeXml } from '../lib/xml.js';

describe('parseIssueTitle', () => {
  const parse = parseIssueTitle;

  test('accepts a name with and without a colour', () => {
    assert.deepEqual(parse('<HeroeName|OstinUA>'), { name: 'OstinUA', color: null });
    assert.deepEqual(parse('<HeroeName|OstinUA|#F5F5F5>'), {
      name: 'OstinUA',
      color: '#f5f5f5',
    });
    assert.deepEqual(parse('<HeroeName|Ольга|#abc>'), { name: 'Ольга', color: '#abc' });
  });

  test('tolerates whitespace around the pipe separators', () => {
    assert.deepEqual(parse('< HeroeName | OstinUA | #abc >'), {
      name: 'OstinUA',
      color: '#abc',
    });
  });

  test('rejects text outside the template, short colours and empty names', () => {
    assert.equal(parse('<HeroeName|Omg_Cool)>'), null);
    assert.equal(parse('prefix <HeroeName|OstinUA>'), null);
    assert.equal(parse('<HeroeName|OstinUA|#abcde>'), null);
    assert.equal(parse('<HeroeName|>'), null);
    assert.equal(parse(`<HeroeName|${'x'.repeat(MAX_NAME_LENGTH + 1)}>`), null);
    assert.equal(parse(null), null);
  });
});

describe('normalizeHexColor', () => {
  test('lowercases valid colours and rejects the rest', () => {
    assert.equal(normalizeHexColor('#ABCDEF'), '#abcdef');
    assert.equal(normalizeHexColor('#aBc'), '#abc');
    assert.equal(normalizeHexColor('#abcd'), null);
    assert.equal(normalizeHexColor('red'), null);
    assert.equal(normalizeHexColor(undefined), null);
  });
});

describe('pattern engine', () => {
  const index = createPatternIndex([
    'abuse',
    'bad*',
    '*suffix',
    'one+two',
    'alpha && beta',
    '  ',
    'Abuse',
  ]);

  test('resolves exact rules through the literal set', () => {
    assert.equal(index.matches('abuse'), true);
    assert.equal(index.matches('  ABUSE '), true);
    assert.equal(index.matches('abused'), false);
  });

  test('supports leading, trailing and token wildcards', () => {
    assert.equal(index.matches('badword'), true);
    assert.equal(index.matches('bad'), true);
    assert.equal(index.matches('not bad'), false);
    assert.equal(index.matches('the-suffix'), true);
    assert.equal(index.matches('one-two'), true);
    assert.equal(index.matches('one two'), false);
  });

  test('requires every part of an AND composition', () => {
    assert.equal(index.matches('alpha'), false);
    // Sub-rules are evaluated independently against the whole value, which is the
    // semantics the dictionaries were written against.
    assert.equal(createPatternIndex(['alpha && *beta']).matches('alpha beta'), false);
    assert.equal(createPatternIndex(['*alpha* && *beta*']).matches('alpha beta'), true);
  });

  test('stays linear on adversarial input', () => {
    const hostile = createPatternIndex(['*a*a*a*a*b', '*a*a*']);
    const started = performance.now();

    // The two-wildcard rule matches and short-circuits the hostile one, so both
    // paths have to be exercised separately.
    assert.equal(hostile.matches('a'.repeat(20_000)), true);
    assert.equal(createPatternIndex(['*a*a*a*a*b']).matches('a'.repeat(20_000)), false);
    assert.ok(performance.now() - started < 500);
  });
});

describe('parseDictionary', () => {
  test('trims, lowercases, drops blanks and duplicates', () => {
    assert.deepEqual(parseDictionary(' Bad\nbad\n\n  \nother \n'), ['bad', 'other']);
  });
});

describe('selectBadgeEntries', () => {
  const issue = (title, overrides = {}) => ({
    title,
    labels: [{ name: 'Valid' }],
    user: { login: 'author' },
    ...overrides,
  });

  test('skips pull requests, unlabelled issues and invalid titles', () => {
    const entries = selectBadgeEntries(
      [
        issue('<HeroeName|skip_pr>', { pull_request: {} }),
        issue('<HeroeName|skip_label>', { labels: [] }),
        issue('<HeroeName|bad@name>'),
        issue('<HeroeName|keep>'),
      ],
      { isBanned: () => false, random: () => 0 },
    );

    assert.deepEqual(entries, [{ name: 'keep', color: '#3f88e6' }]);
  });

  test('caps entries per author and hides duplicate names', () => {
    const entries = selectBadgeEntries(
      [
        issue('<HeroeName|first>'),
        issue('<HeroeName|second>'),
        issue('<HeroeName|third>'),
        issue('<HeroeName|FIRST>', { user: { login: 'other' } }),
      ],
      { isBanned: () => false, random: () => 0 },
    );

    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['first', 'second'],
    );
  });

  test('drops banned names without consuming the author quota', () => {
    const entries = selectBadgeEntries(
      [
        issue('<HeroeName|blocked>'),
        issue('<HeroeName|fine>'),
      ],
      { isBanned: (name) => name === 'blocked', random: () => 0 },
    );

    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['fine'],
    );
  });
});

describe('renderBadge', () => {
  test('always emits a full grid and escapes markup', () => {
    const svg = renderBadge([{ name: '<script>', color: '#abc' }], () => 0.5);

    assert.match(svg, /^<svg /);
    assert.equal(svg.match(/<g class=/g).length, BADGE_SLOTS);
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.ok(!svg.includes('<script>'));
  });

  test('renders a safe error badge', () => {
    assert.ok(renderErrorBadge('a & b').includes('a &amp; b'));
  });
});

describe('escapeXml', () => {
  test('escapes entities and strips control characters', () => {
    assert.equal(escapeXml(`<&>"'\u0000`), '&lt;&amp;&gt;&quot;&apos;');
    assert.equal(escapeXml(undefined), '');
  });
});

describe('pickFallbackColor', () => {
  test('maps randomness onto the palette', () => {
    assert.equal(pickFallbackColor(() => 0), '#3f88e6');
    assert.equal(pickFallbackColor(() => 0.999), '#f1fa8c');
  });
});

/** Token variables the credential tests own for their duration. */
const TOKEN_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'];
const SAVED_TOKEN_ENV = Object.fromEntries(
  TOKEN_ENV_VARS.map((name) => [name, process.env[name]]),
);

function restoreTokenEnv() {
  for (const name of TOKEN_ENV_VARS) {
    const saved = SAVED_TOKEN_ENV[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** Minimal stand-in for the parts of `Response` the GitHub client reads. */
function stubResponse({ status = 200, body = {}, headers = {}, text = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  };
}

describe('readTarget', () => {
  test('falls back to the shipped repository', () => {
    assert.deepEqual(readTarget(undefined), { owner: DEFAULT_OWNER, repo: DEFAULT_REPO });
    assert.deepEqual(readTarget({}), { owner: DEFAULT_OWNER, repo: DEFAULT_REPO });
  });

  test('accepts identifiers and trims them', () => {
    assert.deepEqual(readTarget({ user: ' octocat ', repo: 'Hello-World' }), {
      owner: 'octocat',
      repo: 'Hello-World',
    });
    assert.equal(readIdentifier('a.b_c-d', 'fallback'), 'a.b_c-d');
  });

  test('rejects repeated, empty and path-shaped values', () => {
    // `?user=a&user=b` is parsed into an array by the platform.
    assert.equal(readIdentifier(['a', 'b'], 'fallback'), 'fallback');
    assert.equal(readIdentifier('   ', 'fallback'), 'fallback');
    assert.equal(readIdentifier('../etc/passwd', 'fallback'), 'fallback');
    assert.equal(readIdentifier('a/b', 'fallback'), 'fallback');
    assert.equal(readIdentifier('x'.repeat(101), 'fallback'), 'fallback');
    assert.equal(readIdentifier(42, 'fallback'), 'fallback');
  });
});

describe('credential resolution', () => {
  afterEach(restoreTokenEnv);

  test('prefers GH_TOKEN and repairs pasted whitespace and quotes', () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = '  ghp_pasted_from_a_terminal\n';
    assert.equal(resolveToken(), 'ghp_pasted_from_a_terminal');
    assert.deepEqual(describeToken(), { configured: true, source: 'GITHUB_TOKEN' });

    process.env.GH_TOKEN = '"ghp_quoted_in_a_dotenv"';
    assert.equal(resolveToken(), 'ghp_quoted_in_a_dotenv');
    assert.deepEqual(describeToken(), { configured: true, source: 'GH_TOKEN' });
  });

  test('reports an absent credential instead of sending an empty one', () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "  ''  ";
    assert.equal(resolveToken(), null);
    assert.deepEqual(describeToken(), { configured: false, source: null });
  });
});

describe('github client', () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  let warnings;

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    restoreTokenEnv();
  });

  function captureWarnings() {
    warnings = [];
    console.warn = (message) => warnings.push(String(message));
  }

  test('repeats the request anonymously once the token is rejected', async () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_expired';
    captureWarnings();

    const authorizations = [];
    globalThis.fetch = async (url, init) => {
      authorizations.push(init.headers.Authorization ?? null);
      return authorizations.length === 1
        ? stubResponse({ status: 401 })
        : stubResponse({ body: [{ number: 1 }] });
    };

    assert.deepEqual(await fetchGitHubJson('/repos/readme-SVG/Issues-heroes-badge/issues'), [
      { number: 1 },
    ]);
    assert.deepEqual(authorizations, ['Bearer ghp_expired', null]);
    assert.match(warnings.join('\n'), /retrying anonymously/);
  });

  test('propagates a missing repository without a second attempt', async () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_valid';
    captureWarnings();

    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return stubResponse({ status: 404 });
    };

    await assert.rejects(
      () => fetchGitHubJson('/repos/nobody/nothing/issues'),
      (error) => {
        assert.equal(error.name, 'GitHubRequestError');
        assert.equal(error.status, 404);
        return true;
      },
    );
    assert.equal(attempts, 1);
    assert.deepEqual(warnings, []);
  });

  test('names an exhausted quota in the logs', async () => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    captureWarnings();

    globalThis.fetch = async () =>
      stubResponse({ status: 403, headers: { 'x-ratelimit-remaining': '0' } });

    await assert.rejects(() => fetchGitHubJson('/rate_limit'));
    assert.match(warnings.join('\n'), /anonymous rate limit exhausted/);
  });

  test('keeps the credential on the API host', async () => {
    process.env.GITHUB_TOKEN = 'ghp_secret';

    let seen = null;
    globalThis.fetch = async (url, init) => {
      seen = { url, headers: init.headers };
      return stubResponse({ text: 'one rule per line\n' });
    };

    const contents = await fetchRawFile('readme-SVG', 'Banned-words', 'main', 'Banned-words-list/en.txt');

    assert.equal(contents, 'one rule per line\n');
    assert.equal(seen.url, 'https://raw.githubusercontent.com/readme-SVG/Banned-words/main/Banned-words-list/en.txt');
    assert.equal(seen.headers.Authorization, undefined);
  });
});
