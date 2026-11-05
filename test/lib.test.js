import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BADGE_SLOTS, pickFallbackColor, renderBadge, renderErrorBadge } from '../lib/badge-svg.js';
import { selectBadgeEntries } from '../lib/entries.js';
import { MAX_NAME_LENGTH, normalizeHexColor, parseIssueTitle } from '../lib/issue-title.js';
import { createPatternIndex, parseDictionary } from '../lib/patterns.js';
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
