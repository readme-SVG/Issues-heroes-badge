import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { collectHealth, formatSource, summarizeRateLimit } from '../lib/health.js';

const TARGET = { owner: 'readme-SVG', repo: 'Issues-heroes-badge' };

const ISSUES_PATH =
  '/repos/readme-SVG/Issues-heroes-badge/issues?state=all&sort=created&direction=desc&per_page=100';

const AUTHENTICATED_QUOTA = {
  resources: { core: { limit: 5_000, remaining: 4_990, reset: 1_800_000_000, used: 10 } },
};

const ISSUES = [
  {
    title: '<HeroeName|OstinUA|#F5F5F5>',
    labels: [{ name: 'Valid' }],
    user: { login: 'OstinUA' },
  },
  // Right shape, missing label: the workflow has not admitted it yet.
  { title: '<HeroeName|WaitingForReview>', labels: [], user: { login: 'someone' } },
  // Right label, wrong shape: a regular maintenance issue.
  { title: 'refactor: harden the badge pipeline', labels: [{ name: 'Valid' }], user: { login: 'OstinUA' } },
];

/** Records the requested paths so a test can assert what the probe cost. */
function fakeGitHub({ rateLimit = AUTHENTICATED_QUOTA, issues = ISSUES, failure = null } = {}) {
  const paths = [];

  return {
    paths,
    fetchJson: async (path) => {
      paths.push(path);
      if (failure) throw new Error(failure);
      return path === '/rate_limit' ? rateLimit : issues;
    },
  };
}

function loadedPatterns(size) {
  return async () => ({ size, matches: () => false });
}

describe('summarizeRateLimit', () => {
  test('recognises an authenticated quota', () => {
    assert.deepEqual(summarizeRateLimit(AUTHENTICATED_QUOTA), {
      limit: 5_000,
      remaining: 4_990,
      resetAt: new Date(1_800_000_000_000).toISOString(),
      authenticated: true,
    });
  });

  test('reports the anonymous quota and survives partial payloads', () => {
    const anonymous = summarizeRateLimit({ resources: { core: { limit: 60, remaining: 59 } } });
    assert.equal(anonymous.authenticated, false);
    assert.equal(anonymous.resetAt, null);

    assert.equal(summarizeRateLimit({}), null);
    assert.equal(summarizeRateLimit({ resources: {} }), null);
    assert.equal(summarizeRateLimit(undefined), null);
  });
});

describe('formatSource', () => {
  test('reads like a git reference', () => {
    assert.equal(
      formatSource({ owner: 'readme-SVG', name: 'Banned-words', branch: 'main' }),
      'readme-SVG/Banned-words@main',
    );
  });
});

describe('collectHealth', () => {
  const savedTokens = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(savedTokens)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('reports a healthy deployment', async () => {
    const github = fakeGitHub();

    const report = await collectHealth(TARGET, {
      fetchJson: github.fetchJson,
      loadPatterns: loadedPatterns(1_234),
    });

    assert.equal(report.ok, true);
    assert.equal(report.degraded, false);
    assert.equal(report.errors, undefined);
    assert.equal(report.github.ok, true);
    assert.equal(report.github.rateLimit.authenticated, true);
    assert.equal(report.dictionaries.patterns, 1_234);
    assert.deepEqual(report.issues, { ok: true, fetched: 3, accepted: 1, slots: 10 });
    assert.deepEqual(report.target, TARGET);
    // Two upstream calls: the free quota probe and the same listing the badge uses.
    assert.deepEqual(github.paths, ['/rate_limit', ISSUES_PATH]);
  });

  test('flags moderation that silently degraded', async () => {
    const report = await collectHealth(TARGET, {
      fetchJson: fakeGitHub().fetchJson,
      loadPatterns: loadedPatterns(0),
    });

    // The badge still renders, so the deployment is up — but unmoderated.
    assert.equal(report.ok, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.errors, ['dictionaries: no moderation patterns loaded']);
  });

  test('isolates a GitHub outage from the rest of the report', async () => {
    const report = await collectHealth(TARGET, {
      fetchJson: fakeGitHub({ failure: 'GitHub request failed' }).fetchJson,
      loadPatterns: loadedPatterns(5),
    });

    assert.equal(report.ok, false);
    assert.equal(report.github.ok, false);
    assert.equal(report.issues.ok, false);
    assert.equal(report.dictionaries.ok, true);
    assert.deepEqual(report.errors, [
      'github: GitHub request failed',
      'issues: GitHub request failed',
    ]);
  });

  test('distinguishes an unreadable repository from an unreachable API', async () => {
    const github = fakeGitHub();

    const report = await collectHealth(TARGET, {
      fetchJson: async (path) => {
        if (path === '/rate_limit') return github.fetchJson(path);
        throw new Error('GitHub responded with HTTP 404');
      },
      loadPatterns: loadedPatterns(5),
    });

    assert.equal(report.ok, false);
    assert.equal(report.github.ok, true);
    assert.equal(report.issues.ok, false);
    assert.deepEqual(report.errors, ['issues: GitHub responded with HTTP 404']);
  });

  test('reports an unexpected payload instead of trusting it', async () => {
    const report = await collectHealth(TARGET, {
      fetchJson: async (path) =>
        path === '/rate_limit' ? AUTHENTICATED_QUOTA : { message: 'Bad credentials' },
      loadPatterns: loadedPatterns(5),
    });

    assert.equal(report.issues.ok, false);
    assert.deepEqual(report.errors, ['issues: unexpected issues payload']);
  });

  test('describes the credential without ever echoing it', async () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_super_secret_value';

    const report = await collectHealth(TARGET, {
      fetchJson: fakeGitHub().fetchJson,
      loadPatterns: loadedPatterns(5),
    });

    assert.deepEqual(report.github.token, { configured: true, source: 'GITHUB_TOKEN' });
    assert.equal(JSON.stringify(report).includes('ghp_super_secret_value'), false);
  });
});
