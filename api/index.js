const FALLBACK_COLORS = ['#3f88e6', '#00ffff', '#ff4500', '#ff00ff', '#00ff00', '#ffb86c', '#f1fa8c'];

const MAX_TITLE_LEN = 60;

const ISSUE_RE = /^<\s*HeroeName\s*\|\s*([a-zA-Z\u0400-\u04FF0-9_ -]{1,15})\s*(?:\|\s*(#[0-9a-fA-F]{3,6})\s*)?\s*>$/i;

function escapeXml(str) {
    return String(str).replace(/[<>&"']/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])
    );
}

function safeCssColor(color) {
    return /^#[0-9a-fA-F]{3,6}$/.test(color) ? color : '#888888';
}

function isValidHex(color) {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);
}

function randomColor() {
    return FALLBACK_COLORS[Math.floor(Math.random() * FALLBACK_COLORS.length)];
}

function matchPattern(pattern, str) {
    if (pattern.includes('&&')) {
        const parts = pattern.split('&&').map(p => p.trim()).filter(Boolean);
        return parts.every(p => matchPattern(p, str));
    }

    if (pattern.includes('*') || pattern.includes('+')) {
        const reStr = pattern
            .replace(/[.^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[\\s\\S]*')
            .replace(/\+/g, '[^\\s]+');

        const startsWild = pattern[0] === '*' || pattern[0] === '+';
        const endsWild   = pattern[pattern.length - 1] === '*' || pattern[pattern.length - 1] === '+';

        let re;
        try {
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

async function loadBannedPatterns() {
    const now = Date.now();
    if (_bannedCache && now - _bannedCacheAt < BANNED_CACHE_TTL) {
        return _bannedCache;
    }

    const repoEnv = process.env.BANNED_WORDS_REPO || 'readme-SVG/Banned-words';
    const [owner, repo] = repoEnv.split('/');
    const branch = process.env.BANNED_WORDS_BRANCH || 'main';

    const headers = { 'User-Agent': 'bounce-badge' };
    if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    try {
        const treeRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
            { headers }
        );
        if (!treeRes.ok) throw new Error(`tree fetch failed: ${treeRes.status}`);

        const tree = await treeRes.json();

        const txtFiles = (tree.tree || []).filter(
            f => f.type === 'blob' && f.path.startsWith('Banned-words-list/') && f.path.endsWith('.txt')
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

        _bannedCache   = [...new Set(patterns)];
        _bannedCacheAt = now;
        return _bannedCache;

    } catch (err) {
        console.error('Failed to load banned patterns:', err.message);
        return _bannedCache || [];
    }
}

async function isBanned(name) {
    const patterns = await loadBannedPatterns();
    const input    = name.toLowerCase();
    return patterns.some(p => matchPattern(p, input));
}

export default async function handler(req, res) {
    const username = req.query.user || 'OstinUA';
    const repo     = req.query.repo || 'Image-storage';

    try {
        const headers = { 'User-Agent': 'bounce-badge' };
        if (process.env.GITHUB_TOKEN) {
            headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
        }

        const apiRes = await fetch(
            `https://api.github.com/repos/${username}/${repo}/issues?state=all&per_page=50`,
            { headers }
        );

        if (!apiRes.ok) throw new Error(`GitHub API error: ${apiRes.status}`);

        const issues = await apiRes.json();
        const authors        = [];
        const seenNames      = new Set();
        const authorIssueMap = new Map();

        for (const issue of issues) {
            const raw = (issue.title || '').trim();

            if (raw.length > MAX_TITLE_LEN) continue;

            const m = raw.match(ISSUE_RE);
            if (!m) continue;

            const login = (issue.user?.login || '').toLowerCase();
            const name  = m[1].trim();
            const color = (m[2] && isValidHex(m[2])) ? m[2] : randomColor();

            const count = authorIssueMap.get(login) || 0;
            if (count >= 2) continue;
            authorIssueMap.set(login, count + 1);

            if (seenNames.has(name.toLowerCase())) continue;
            seenNames.add(name.toLowerCase());

            if (await isBanned(name)) continue;

            authors.push({ name, color: safeCssColor(color) });
            if (authors.length >= 7) break;
        }

        while (authors.length < 7) {
            authors.push({ name: 'Write-Issues', color: '#555566' });
        }

        const width  = 850;
        const height = 200;

        let styles = '';
        let elems  = '';

        authors.forEach(({ name, color }, i) => {
            const durX = (Math.random() * 4 + 4).toFixed(1);
            const durY = (Math.random() * 3 + 3).toFixed(1);
            const delX = -(Math.random() * durX).toFixed(1);
            const delY = -(Math.random() * durY).toFixed(1);
            const dirX = Math.random() > 0.5 ? 'alternate' : 'alternate-reverse';
            const dirY = Math.random() > 0.5 ? 'alternate' : 'alternate-reverse';

            const charWidth = 10.8;
            const textWidth = name.length * charWidth;
            const maxX      = Math.max(10, width  - textWidth - 20);
            const maxY      = Math.max(40, height - 20);
            const safeName  = escapeXml(name);

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
