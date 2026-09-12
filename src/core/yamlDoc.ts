/**
 * The only module in the codebase that imports `yaml`.
 *
 * Three behaviours of the library drive this design, each confirmed by probing it
 * rather than assumed:
 *
 * 1. `parseDocument` never throws. Invalid YAML shows up as `doc.errors`, and a
 *    document with errors *cannot* be stringified. So a damaged file is detectable,
 *    and the right response is to report it and never rewrite it.
 *
 * 2. Stringifying is not byte-identical even with no mutation. `[a, b]` comes back as
 *    `[ a, b ]`, and two spaces before a trailing comment collapse to one. So an
 *    unmodified document is written back as its *original text*, and the library is
 *    only asked to serialise when a field actually changed. That is what makes an
 *    untouched file provably byte-stable.
 *
 * 3. `doc.set(key, array)` turns a flow sequence into a block one. Tags are written
 *    as an explicit flow sequence so `tags: [home, errand]` stays on one line.
 *
 * The coercion guard matters too. YAML 1.2 still reads `2026` as a number and `true`
 * as a boolean, so a tag named `2026` would arrive as a number and be written back
 * unquoted. Every scalar read goes through `scalarText`, which prefers the node's
 * original source text whenever the parsed value is not a string.
 */
import {Document, parseDocument, isScalar, isSeq, Scalar, YAMLSeq} from 'yaml';

export interface TagRead {
  values: string[];
  /** Tags whose YAML value was not a string, e.g. `2026` or `true`. */
  coerced: string[];
  /** Entries that were not scalars at all, reported but not kept. */
  dropped: string[];
}

function scalarText(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined;
  const scalar = node as Scalar & {source?: string};

  // A genuine string wins, so a quoted "on-hold" yields on-hold and not "on-hold".
  if (typeof scalar.value === 'string') return scalar.value;

  // Anything else was coerced by the YAML core schema. Fall back to what was written.
  if (typeof scalar.source === 'string' && scalar.source.length > 0) return scalar.source;

  // An implicit null, such as the empty slot left by a trailing comma.
  return undefined;
}

export class FrontmatterDoc {
  private constructor(
    private readonly doc: Document,
    private readonly original: string,
    readonly errors: string[],
  ) {}

  private dirty = false;

  static parse(text: string): FrontmatterDoc {
    const doc = parseDocument(text, {keepSourceTokens: true});
    const errors = doc.errors.map(e => e.message);
    return new FrontmatterDoc(doc, text, errors);
  }

  /**
   * An empty document, for a file that arrived with no frontmatter at all — which is
   * exactly what an agent produces when it drops a bare markdown note into `inbox/`.
   */
  static empty(): FrontmatterDoc {
    const created = new FrontmatterDoc(new Document({}), '', []);
    created.dirty = true;
    return created;
  }

  /** False when the frontmatter did not parse. Never write a document that is not ok. */
  get ok(): boolean {
    return this.errors.length === 0;
  }

  get changed(): boolean {
    return this.dirty;
  }

  has(key: string): boolean {
    return this.doc.has(key);
  }

  /** Every key present, in document order, so unknown keys can be reported. */
  keys(): string[] {
    const contents = this.doc.contents;
    if (contents === null || !('items' in contents)) return [];
    const out: string[] = [];
    for (const item of contents.items as Array<{key?: unknown}>) {
      const key = scalarText(item.key);
      if (key !== undefined) out.push(key);
    }
    return out;
  }

  getString(key: string): string | undefined {
    const value = scalarText(this.doc.get(key, true));
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Read a list of tags, tolerating both `[a, b]` and a block sequence, and tolerating
   * a bare string as a one-element list.
   */
  getTags(key: string): TagRead {
    const node = this.doc.get(key, true);
    const result: TagRead = {values: [], coerced: [], dropped: []};
    if (node === undefined || node === null) return result;

    if (isScalar(node)) {
      const single = scalarText(node);
      if (single !== undefined && single.trim().length > 0) result.values.push(single.trim());
      return result;
    }

    if (!isSeq(node)) {
      result.dropped.push(`${key} is not a list`);
      return result;
    }

    for (const item of node.items) {
      if (!isScalar(item)) {
        result.dropped.push('a non-scalar list entry');
        continue;
      }
      const text = scalarText(item);
      if (text === undefined || text.trim().length === 0) continue; // trailing comma, etc.
      if (typeof (item as Scalar).value !== 'string') result.coerced.push(text.trim());
      result.values.push(text.trim());
    }
    return result;
  }

  /** Set a scalar field, or delete it when the value is undefined or empty. */
  set(key: string, value: string | undefined): void {
    const current = this.getString(key);
    if (value === undefined || value.length === 0) {
      if (this.doc.has(key)) {
        this.doc.delete(key);
        this.dirty = true;
      }
      return;
    }
    if (current === value) return;
    this.doc.set(key, value);
    this.dirty = true;
  }

  /**
   * Set a list field as a flow sequence, so it stays on one line as `[a, b]`.
   * Deletes the key when the list is empty, keeping a typical file to four lines.
   */
  setTags(key: string, values: string[]): void {
    const current = this.getTags(key).values;
    if (values.length === 0) {
      if (this.doc.has(key)) {
        this.doc.delete(key);
        this.dirty = true;
      }
      return;
    }
    if (current.length === values.length && current.every((v, i) => v === values[i])) return;

    const seq = new YAMLSeq<Scalar>();
    seq.flow = true;
    for (const value of values) {
      // createNode lets the stringifier decide on quoting, so a tag named `2026` or
      // `true` is written quoted and reads back as a string.
      seq.add(this.doc.createNode(value) as Scalar);
    }
    this.doc.set(key, seq);
    this.dirty = true;
  }

  /**
   * The YAML text to write. An unchanged document returns its original bytes rather
   * than being re-serialised, because serialising normalises whitespace the author
   * may have chosen on purpose.
   */
  toText(): string {
    if (!this.dirty) return this.original;
    if (!this.ok) {
      throw new Error(`refusing to serialise frontmatter with errors: ${this.errors.join('; ')}`);
    }
    // `flowCollectionPadding: false` keeps tags as `[home, errand]` rather than
    // `[ home, errand ]`, which is the format the contract document promises.
    // `lineWidth: 0` stops long titles being folded onto a second line.
    return this.doc.toString({flowCollectionPadding: false, lineWidth: 0}).replace(/\n$/, '');
  }
}
