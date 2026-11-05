/**
 * SVG badge rendering.
 *
 * The badge is a deterministic 10-slot grid: every slot holds a name that
 * drifts across the canvas, which is why each row needs its own keyframes.
 * Output is pure: the only input is the list of entries, so the same commit
 * always produces the same markup and edge caches stay usable.
 */

import { escapeXml } from './xml.js';

export const BADGE_WIDTH = 850;
export const BADGE_HEIGHT = 200;
export const BADGE_SLOTS = 10;

const PLACEHOLDER_ENTRY = Object.freeze({ name: 'Write-Issues', color: '#555566' });

const PALETTE = Object.freeze([
  '#3f88e6',
  '#00ffff',
  '#ff4500',
  '#ff00ff',
  '#00ff00',
  '#ffb86c',
  '#f1fa8c',
]);

/**
 * Picks a colour from the fallback palette.
 *
 * @param {() => number} random Source of randomness in the `[0, 1)` range.
 * @returns {string} A palette colour.
 */
export function pickFallbackColor(random = Math.random) {
  return PALETTE[Math.floor(random() * PALETTE.length)];
}

/** Monospace advance width per character at the configured font size. */
const CHAR_WIDTH = 10.8;
const TRACK_PADDING = 20;
const MIN_TRACK_WIDTH = 10;

function animationSlot(entry, index, random) {
  const { name, color } = entry;

  const horizontalDuration = (random() * 4 + 4).toFixed(1);
  const verticalDuration = (random() * 3 + 3).toFixed(1);
  const horizontalDelay = -(random() * horizontalDuration).toFixed(1);
  const verticalDelay = -(random() * verticalDuration).toFixed(1);
  const horizontalDirection = random() > 0.5 ? 'alternate' : 'alternate-reverse';
  const verticalDirection = random() > 0.5 ? 'alternate' : 'alternate-reverse';

  const maxX = Math.max(
    MIN_TRACK_WIDTH,
    BADGE_WIDTH - name.length * CHAR_WIDTH - TRACK_PADDING,
  );
  const maxY = Math.max(40, BADGE_HEIGHT - 20);

  const rules = [
    `.t${index}{fill:${color};animation:y${index} ${verticalDuration}s linear ${verticalDelay}s infinite ${verticalDirection};}`,
    `@keyframes x${index}{from{transform:translateX(10px)}to{transform:translateX(${maxX}px)}}`,
    `@keyframes y${index}{from{transform:translateY(40px)}to{transform:translateY(${maxY}px)}}`,
    `.g${index}{animation:x${index} ${horizontalDuration}s linear ${horizontalDelay}s infinite ${horizontalDirection};}`,
  ].join('');

  const element = `<g class="g${index}"><text class="label t${index}">${escapeXml(name)}</text></g>`;

  return { rules, element };
}

/**
 * Renders the badge document.
 *
 * @param {ReadonlyArray<{ name: string, color: string }>} entries Accepted
 *     entries; missing slots are padded with a placeholder.
 * @param {() => number} [random] Source of randomness for animation timings.
 * @returns {string} A standalone SVG document.
 */
export function renderBadge(entries, random = Math.random) {
  const slots = entries.slice(0, BADGE_SLOTS);
  while (slots.length < BADGE_SLOTS) slots.push(PLACEHOLDER_ENTRY);

  const rules = [];
  const elements = [];

  slots.forEach((entry, index) => {
    const slot = animationSlot(entry, index, random);
    rules.push(slot.rules);
    elements.push(slot.element);
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" viewBox="0 0 ${BADGE_WIDTH} ${BADGE_HEIGHT}">`,
    '<rect width="100%" height="100%" fill="none" stroke="#30363d" stroke-width="2"/>',
    '<text x="15" y="25" fill="#8b949e" font-family="monospace" font-size="14" style="text-shadow:1px 1px 2px #000">Heroes from Issues:</text>',
    '<style>',
    'text{font-family:monospace;font-size:18px;font-weight:bold;text-shadow:2px 2px 4px rgba(0,0,0,.9),-1px -1px 3px rgba(0,0,0,.7)}',
    rules.join(''),
    '</style>',
    elements.join(''),
    '</svg>',
  ].join('');
}

/**
 * Renders the error badge shown when the endpoint cannot build a real one.
 *
 * @param {string} message Human-readable failure reason, already sanitised by
 *     the caller.
 * @returns {string} A standalone SVG document.
 */
export function renderErrorBadge(message) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" viewBox="0 0 ${BADGE_WIDTH} ${BADGE_HEIGHT}">`,
    '<rect width="100%" height="100%" fill="none" stroke="#f85149" stroke-width="2"/>',
    `<text x="20" y="40" fill="#f85149" font-family="monospace" font-size="16">${escapeXml(message)}</text>`,
    '</svg>',
  ].join('');
}
