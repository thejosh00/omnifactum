/**
 * Filenames.
 *
 * A filename is a human-facing label, never an identity. Nothing in the app keys off
 * a path, so a human is free to rename any file at any time and lose nothing.
 *
 * Two macOS details are load-bearing here and are easy to miss. APFS is
 * case-insensitive, so `Fix-Printer.md` and `fix-printer.md` are the same file. And
 * `readdir` hands back decomposed Unicode (NFD) while a JavaScript string literal is
 * composed (NFC), so `"café"` from a title and `"café"` from a directory listing are
 * different strings. Every comparison goes through `foldName` for both reasons.
 */

export const MAX_STEM_LENGTH = 60;

/**
 * Turn a title into a filename stem. Returns an empty string when the title has no
 * usable characters at all; callers fall back to the id.
 */
export function slugify(title: string): string {
  const stem = title
    .normalize('NFC')
    .toLowerCase()
    // Drop apostrophes rather than turning them into separators, so "don't" reads
    // as "dont" and not "don-t".
    .replace(/['‘’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  return stem.slice(0, MAX_STEM_LENGTH).replace(/-+$/g, '');
}

/** The stem to use for a task, falling back to the id for titles with no letters. */
export function stemFor(title: string, id: string): string {
  const stem = slugify(title);
  return stem.length > 0 ? stem : id;
}

/**
 * Normalise a filename stem for comparison: NFC, then lowercase. Use this anywhere
 * two names are checked for collision or equality.
 */
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Pick a stem that does not collide with `taken`, suffixing `-2`, `-3` and so on.
 * `taken` holds stems, in any case or Unicode form.
 */
export function uniqueStem(desired: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const name of taken) used.add(foldName(name));

  if (!used.has(foldName(desired))) return desired;

  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    // Keep the result within the length cap even after suffixing.
    const base = desired.slice(0, MAX_STEM_LENGTH - suffix.length).replace(/-+$/g, '');
    const candidate = `${base}${suffix}`;
    if (!used.has(foldName(candidate))) return candidate;
  }
}

/**
 * Whether `omni` is the one that named this file.
 *
 * On a title edit the file is renamed only if its current stem still matches the slug
 * of the *old* title. If it matches, the app authored that name and may update it. If
 * it does not, a human chose the name deliberately and the app leaves it alone
 * permanently. That one rule gives tidy filenames by default without ever fighting the
 * user over a name they picked.
 */
export function isAppAuthoredStem(stem: string, previousTitle: string, id: string): boolean {
  const expected = stemFor(previousTitle, id);
  const folded = foldName(stem);
  if (folded === foldName(expected)) return true;

  // A collision suffix the app added is still the app's name.
  const suffixed = /^(.*)-\d+$/.exec(folded);
  return suffixed !== null && suffixed[1] === foldName(expected);
}
