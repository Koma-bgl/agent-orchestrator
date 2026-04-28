const MARKER_RE = /<!--\s*ao-scope\s*:\s*([^>]*?)\s*-->/i;

/**
 * Parse a `<!-- ao-scope: globA, globB -->` marker out of free-form text.
 * Returns the list of trimmed, non-empty globs, or null if no marker / empty marker.
 */
export function parseScopeMarker(body: string | null | undefined): string[] | null {
  if (!body) return null;
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  const globs = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return globs.length > 0 ? globs : null;
}
