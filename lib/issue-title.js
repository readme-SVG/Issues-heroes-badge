/**
 * The issue title contract.
 *
 * Every entry on the badge is created by opening an issue whose title is the
 * only payload the project accepts:
 *
 *   <HeroeName|display_name>
 *   <HeroeName|display_name|#RRGGBB>
 *
 * The same grammar is enforced by the validator workflow and by the static
 * validator page, so changes here must be mirrored there.
 */

export const MAX_TITLE_LENGTH = 60;
export const MAX_NAME_LENGTH = 40;

const ALLOWED_NAME_CHARS = "a-zA-Z\\u0400-\\u04FF0-9_ .!,?:;'-";

export const ISSUE_TITLE_RE = new RegExp(
  `^<\\s*HeroeName\\s*\\|\\s*([${ALLOWED_NAME_CHARS}]{1,${MAX_NAME_LENGTH}})\\s*` +
    `(?:\\|\\s*(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\\s*)?>\\s*$`,
  'i',
);

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Validates and normalises a hex colour.
 *
 * @param {unknown} value Candidate colour such as `#abc` or `#A1B2C3`.
 * @returns {string | null} The lowercase colour, or `null` when invalid.
 */
export function normalizeHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * Parses an issue title into its display name and optional colour.
 *
 * @param {unknown} title Raw issue title.
 * @returns {{ name: string, color: string | null } | null} Parsed entry, or
 *     `null` when the title does not satisfy the contract.
 */
export function parseIssueTitle(title) {
  if (typeof title !== 'string') return null;

  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) return null;

  const match = ISSUE_TITLE_RE.exec(trimmed);
  if (!match) return null;

  const name = match[1].trim();
  if (!name) return null;

  return { name, color: normalizeHexColor(match[2]) };
}
