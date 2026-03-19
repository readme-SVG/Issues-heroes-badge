const FALLBACK_COLORS = ['#3f88e6', '#00ffff', '#ff4500', '#ff00ff', '#00ff00', '#ffb86c', '#f1fa8c'];

const MAX_TITLE_LEN = 60;

const ISSUE_RE = /^<\s*HeroeName\s*\|\s*([a-zA-Z\u0400-\u04FF0-9_ -]{1,20})\s*(?:\|\s*(#[0-9a-fA-F]{3,6})\s*)?\s*>$/i;

/**
 * Escapes XML-sensitive characters in a value converted to string.
 *
 * @param {unknown} str Input value that may contain XML-sensitive characters.
 * @returns {string} The escaped string safe to interpolate into SVG/XML text nodes.
 *
 * @example
 * ```js
 * escapeXml('<hero & "friend">');
 * // '&lt;hero &amp; &quot;friend&quot;&gt;'
 * ```
 */
function escapeXml(str) {
    return String(str).replace(/[<>&"']/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])
    );
}

/**
 * Returns a CSS-safe hex color or a neutral fallback color.
 *
 * @param {string} color Candidate color string.
 * @returns {string} The original color if it matches a hex format, otherwise `#888888`.
 *
 * @example
 * ```js
 * safeCssColor('#ff00ff');
 * // '#ff00ff'
 *
 * safeCssColor('red');
 * // '#888888'
 * ```
 */
function safeCssColor(color) {
    return /^#[0-9a-fA-F]{3,6}$/.test(color) ? color : '#888888';
}

/**
 * Validates whether a string is a 3- or 6-digit hex color value.
 *
 * @param {string} color Color candidate to validate.
 * @returns {boolean} `true` when `color` is `#RGB` or `#RRGGBB`; otherwise `false`.
 *
 * @example
 * ```js
 * isValidHex('#abc');
 * // true
 *
 * isValidHex('#12abz9');
 * // false
 * ```
 */
function isValidHex(color) {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);
}

/**
 * Picks a random fallback color from the predefined palette.
 *
 * @returns {string} A hex color string selected from `FALLBACK_COLORS`.
 *
 * @example
 * ```js
 * randomColor();
 * // '#3f88e6' (example output)
 * ```
 */
function randomColor() {
    return FALLBACK_COLORS[Math.floor(Math.random() * FALLBACK_COLORS.length)];
}

/**
 * Matches a string against a custom lightweight pattern language.
 *
 * Supported operators:
 * - `&&` requires all sub-patterns to match.
 * - `*` matches any sequence (including spaces).
 * - `+` matches one non-space token.
 *
 * @param {string} pattern Pattern expression to evaluate.
 * @param {string} str Candidate string to test against the pattern.
 * @returns {boolean} `true` if the candidate matches the provided pattern; otherwise `false`.
 *
 * @example
 * ```js
 * matchPattern('hero*', 'hero-name');
 * // true
 *
 * matchPattern('alpha&&beta', 'alpha beta');
 * // true
 * ```
 */
function matchPattern(pattern, str) {
    // Support simple AND composition so each token can stay readable.
    if (pattern.includes('&&')) {
        const parts = pattern.split('&&').map(p => p.trim()).filter(Boolean);
        return parts.every(p => matchPattern(p, str));
    }
    if (pattern.includes('*') || pattern.includes('+')) {
        // Escape regex control chars first, then expand our custom wildcards.
        const reStr = pattern
            .replace(/[.^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[\\s\\S]*')
            .replace(/\+/g, '[^\\s]+');
        const startsWild = pattern[0] === '*' || pattern[0] === '+';
        const endsWild = pattern[pattern.length - 1] === '*' || pattern[pattern.length - 1] === '+';
        let re;
        try {
            // Keep full-string matching by default, but allow substring matching
            // when a wildcard is explicitly placed at an edge.
            re = (startsWild || endsWild)
                ? new RegExp(reStr, 'i')
                : new RegExp('^' + reStr + '$', 'i');
        } catch {
            return false;
        }
        return re.test(str);
    }
    return str === pattern;
}

let _bannedCache = null;
let _bannedCacheAt = 0;
const BANNED_CACHE_TTL = 60_000;

/**
 * Loads banned-word patterns from a remote GitHub repository with TTL caching.
 *
 * The function fetches all `.txt` files under `Hard-Banned-words-list/`,
 * normalizes entries to lowercase, removes duplicates, and keeps a short
 * in-memory cache to reduce repeated network requests.
 *
 * @async
 * @returns {Promise<string[]>} A deduplicated list of normalized banned patterns.
 * @throws {Error} Intentionally throws when tree retrieval fails with a non-OK status,
 *   but catches internally and returns cached/empty data as fallback.
 *
 * @example
 * ```js
 * const patterns = await loadBannedPatterns();
 * // ['badword', 'foo*', 'term&&other']
 * ```
 */
async function loadBannedPatterns() {
    const now = Date.now();
    // Short in-memory cache to avoid repeated GitHub calls on hot paths.
    if (_bannedCache && now - _bannedCacheAt < BANNED_CACHE_TTL) return _bannedCache;

    const repoEnv = process.env.BANNED_WORDS_REPO || 'readme-SVG/Banned-words';
    const [owner, repo] = repoEnv.split('/');
    const branch = process.env.BANNED_WORDS_BRANCH || 'main';

    const headers = { 'User-Agent': 'bounce-badge' };
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
        const treeRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
            { headers }
        );
        if (!treeRes.ok) throw new Error(`tree fetch failed: ${treeRes.status}`);

        const tree = await treeRes.json();
        const txtFiles = (tree.tree || []).filter(
            f => f.type === 'blob' && f.path.startsWith('Hard-Banned-words-list/') && f.path.endsWith('.txt')
        );

        const contents = await Promise.all(
            txtFiles.map(f =>
                fetch(
                    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${f.path}`,
                    { headers }
                ).then(r => r.ok ? r.text() : '')
            )
        );

        const patterns = [];
        for (const text of contents) {
            text.split('\n')
                .map(l => l.trim().toLowerCase())
                .filter(Boolean)
                .forEach(p => patterns.push(p));
        }

        _bannedCache = [...new Set(patterns)];
        _bannedCacheAt = now;
        return _bannedCache;

    } catch (err) {
        console.error('Failed to load banned patterns:', err.message);
        return _bannedCache || [];
    }
}

/**
 * Checks whether a display name matches any banned pattern.
 *
 * @async
 * @param {string} name Candidate display name to evaluate.
 * @returns {Promise<boolean>} `true` if any banned pattern matches the lowercased name.
 *
 * @example
 * ```js
 * const blocked = await isBanned('Example User');
 * // false
 * ```
 */
async function isBanned(name) {
    const patterns = await loadBannedPatterns();
    return patterns.some(p => matchPattern(p, name.toLowerCase()));
}

/**
 * Handles HTTP requests and returns an animated SVG of accepted issue authors.
 *
 * The handler queries repository issues, validates titles against a strict
 * template, enforces label and content constraints, filters banned names,
 * and generates a stable 10-entry animated board.
 *
 * @async
 * @param {{query: {user?: string, repo?: string}}} req Incoming request object.
 * @param {{setHeader: Function, status: Function}} res Outgoing response object.
 * @returns {Promise<void>} Resolves after sending either an SVG badge or an error SVG.
 *
 * @example
 * ```js
 * // GET /api?user=octocat&repo=Hello-World
 * // -> 200 image/svg+xml response with animated names
 * ```
 */
export default async function handler(req, res) {
    const username = req.query.user || 'readme-SVG';
    const repo = req.query.repo || 'Issues-heroes-badge';

    try {
        const headers = { 'User-Agent': 'bounce-badge' };
        const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const apiRes = await fetch(
            `https://api.github.com/repos/${username}/${repo}/issues?state=all&per_page=100`,
            { headers }
        );

        if (!apiRes.ok) throw new Error(`GitHub API error: ${apiRes.status}`);

        const issues = await apiRes.json();
        const authors = [];
        const seenNames = new Set();
        const authorIssueMap = new Map();

        for (const issue of issues) {
            const raw = (issue.title || '').trim();

            if (raw.length > MAX_TITLE_LEN) continue;

            const m = raw.match(ISSUE_RE);
            if (!m) continue;

            const hasValid = issue.labels?.some(l => l.name === 'Valid');
            if (!hasValid) continue;

            const login = (issue.user?.login || '').toLowerCase();
            const name = m[1].trim();
            const color = (m[2] && isValidHex(m[2])) ? m[2] : randomColor();

            const count = authorIssueMap.get(login) || 0;
            // Cap each author to two accepted entries to keep the board diverse.
            if (count >= 2) continue;
            authorIssueMap.set(login, count + 1);

            if (seenNames.has(name.toLowerCase())) continue;
            seenNames.add(name.toLowerCase());

            if (await isBanned(name)) continue;

            authors.push({ name, color: safeCssColor(color) });
            if (authors.length >= 10) break;
        }

        while (authors.length < 10) {
            // Keep output shape stable so the SVG layout stays predictable.
            authors.push({ name: 'Write-Issues', color: '#555566' });
        }

        const width = 850;
        const height = 200;

        let styles = '';
        let elems = '';

        authors.forEach(({ name, color }, i) => {
            const durX = (Math.random() * 4 + 4).toFixed(1);
            const durY = (Math.random() * 3 + 3).toFixed(1);
            const delX = -(Math.random() * durX).toFixed(1);
            const delY = -(Math.random() * durY).toFixed(1);
            const dirX = Math.random() > 0.5 ? 'alternate' : 'alternate-reverse';
            const dirY = Math.random() > 0.5 ? 'alternate' : 'alternate-reverse';

            const charWidth = 10.8;
            const textWidth = name.length * charWidth;
            const maxX = Math.max(10, width - textWidth - 20);
            const maxY = Math.max(40, height - 20);
            const safeName = escapeXml(name);

            styles += `
.gX${i}{animation:mX${i} ${durX}s linear ${delX}s infinite ${dirX};}
.tY${i}{fill:${color};font-family:monospace;font-size:18px;font-weight:bold;
        text-shadow:2px 2px 4px rgba(0,0,0,.9),-1px -1px 3px rgba(0,0,0,.7);
        animation:mY${i} ${durY}s linear ${delY}s infinite ${dirY};}
@keyframes mX${i}{0%{transform:translateX(10px)}100%{transform:translateX(${maxX}px)}}
@keyframes mY${i}{0%{transform:translateY(40px)}100%{transform:translateY(${maxY}px)}}
`;
            elems += `<g class="gX${i}"><text class="tY${i}">${safeName}</text></g>\n`;
        });

        const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
<rect width="100%" height="100%" fill="transparent" stroke="#30363d" stroke-width="2"/>
<text x="15" y="25" fill="#8b949e" font-family="monospace" font-size="14" style="text-shadow:1px 1px 2px #000;">Heroes from Issues:</text>
<style>${styles}</style>
${elems}</svg>`;

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-cache, s-maxage=60, stale-while-revalidate');
        res.status(200).send(svg.trim());

    } catch (err) {
        const errorSvg = `<svg width="850" height="200" xmlns="http://www.w3.org/2000/svg">
<rect width="100%" height="100%" fill="transparent" stroke="#ff0000" stroke-width="2"/>
<text x="20" y="40" fill="#ff0000" font-family="monospace" font-size="16">${escapeXml(err.message)}</text>
</svg>`;
        res.setHeader('Content-Type', 'image/svg+xml');
        res.status(500).send(errorSvg.trim());
    }
}
