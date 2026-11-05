/** Characters that are unsafe inside XML text and attribute values. */
const ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
});

const UNSAFE_RE = /[&<>"']/g;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Escapes a value for inclusion in XML text or attribute values.
 *
 * XML 1.0 forbids most C0 control characters outright — escaping them is not an
 * option, so they are removed. That matters here because display names arrive
 * from issue titles.
 *
 * @param {unknown} value Any value; it is coerced to a string first.
 * @returns {string} XML-safe text.
 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(CONTROL_CHARS_RE, '')
    .replace(UNSAFE_RE, (character) => ESCAPES[character]);
}
