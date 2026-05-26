/**
 * Encoding helpers for embedding untrusted strings in XML-shaped prompt
 * scaffolding. Any time we wrap model-visible content in tags like
 * `<long-running-command>…</…>` or `<memory path="…">…</…>`, the inner
 * content (or attribute) can collide with the surrounding markup. Use these
 * helpers at the boundary so the model always sees well-formed framing.
 */

/**
 * Escape a string for safe inclusion in XML *text content*. Replaces `&`,
 * `<`, `>` so embedded markup or stray closing tags can't terminate the
 * wrapping element. Use {@link xmlAttr} for attribute values.
 */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape a string for safe inclusion as an XML *attribute value*. Assumes
 * the attribute is always wrapped in double quotes by the caller.
 */
export function xmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
