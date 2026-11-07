/**
 * Local stand-in for the Vercel runtime.
 *
 * `npx vercel dev` needs a Vercel account and a linked project, which is a lot to
 * ask of someone who only wants to see the badge. This script serves the same
 * routes as `vercel.json` — the two functions, their aliases and the static
 * validator page — with nothing but the standard library:
 *
 *   npm run dev            # http://localhost:3000
 *   PORT=8080 npm run dev
 *
 * The request and response objects mimic the subset of the Vercel contract the
 * handlers use (`req.query`, `res.status()`, `res.send()`, `res.json()`), so a
 * handler that works here works on the deployment.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import badgeHandler from '../api/index.js';
import healthHandler from '../api/health.js';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3_000);

/** Same table as `vercel.json`; keep the two in sync. */
const FUNCTION_ROUTES = new Map([
  ['/api', badgeHandler],
  ['/badge', badgeHandler],
  ['/api/health', healthHandler],
  ['/health', healthHandler],
]);

const STATIC_ROUTES = new Map([
  ['/', 'docs/index.html'],
  ['/validator.css', 'docs/validator.css'],
  ['/validator.js', 'docs/validator.js'],
]);

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

/**
 * Parses a query string the way the Vercel runtime does: a repeated key becomes
 * an array, which is exactly the shape the handlers must defend against.
 *
 * @param {URLSearchParams} searchParams Parsed query string.
 * @returns {Record<string, string | string[]>} Query object.
 */
function parseQuery(searchParams) {
  const query = {};

  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }

  return query;
}

/** Adds the response helpers the handlers expect from the platform. */
function decorateResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.send = (body) => res.end(body);

  res.json = (body) => {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(body));
  };

  return res;
}

/**
 * Resolves a URL path to a file inside the project, or `null`.
 *
 * Dotfiles are excluded on purpose: `.git`, `.env` and friends must never be
 * served just because they happen to sit in the project directory.
 *
 * @param {string} pathname Decoded URL path.
 * @returns {string | null} Absolute file path.
 */
function resolveStaticFile(pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (relative === '' || relative.split(sep).some((segment) => segment.startsWith('.'))) {
    return null;
  }

  const absolute = join(PROJECT_ROOT, relative);
  return absolute.startsWith(PROJECT_ROOT + sep) ? absolute : null;
}

/**
 * Serves a static file, applying the same rewrites `vercel.json` declares.
 *
 * @param {string} pathname Normalised URL path.
 * @param {import('node:http').ServerResponse} res Decorated response.
 * @returns {Promise<boolean>} Whether something was written.
 */
async function serveStatic(pathname, res) {
  const candidates = [STATIC_ROUTES.get(pathname), pathname].filter(Boolean);

  for (const candidate of candidates) {
    const file = resolveStaticFile(candidate);
    if (!file) continue;

    try {
      const body = await readFile(file);
      res.setHeader('Content-Type', CONTENT_TYPES.get(extname(file)) ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(body);
      return true;
    } catch {
      // A candidate that does not exist simply falls through to the next one.
    }
  }

  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  // Decorated once, so every branch below — including the failure branch — can
  // use the helpers the platform provides.
  const response = decorateResponse(res);

  try {
    const handler = FUNCTION_ROUTES.get(pathname);
    if (handler) {
      const request = {
        method: req.method,
        headers: req.headers,
        query: parseQuery(url.searchParams),
      };
      await handler(request, response);
      return;
    }

    if (await serveStatic(pathname, response)) return;

    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.status(404).send(`No route for ${pathname}\n\nTry /api, /api/health or /\n`);
  } catch (error) {
    // A crash here mirrors what Vercel reports as FUNCTION_INVOCATION_FAILED.
    console.error(`Request ${req.method} ${pathname} failed:`, error);
    if (!response.headersSent) response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.status(500).send('Internal Server Error\n');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Issues-heroes-badge dev server on http://localhost:${PORT}`);
  console.log(`  badge   http://localhost:${PORT}/api?user=readme-SVG&repo=Issues-heroes-badge`);
  console.log(`  health  http://localhost:${PORT}/api/health`);
  console.log(`  page    http://localhost:${PORT}/`);
});
