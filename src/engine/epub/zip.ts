import { unzip, type Unzipped } from 'fflate';

/** An opened EPUB container: a flat map of zip path → bytes. */
export class EpubZip {
  readonly files: Unzipped;

  private constructor(files: Unzipped) {
    this.files = files;
  }

  static async open(data: ArrayBuffer): Promise<EpubZip> {
    const bytes = new Uint8Array(data);
    const files = await new Promise<Unzipped>((resolve, reject) => {
      unzip(bytes, (err, out) => (err ? reject(err) : resolve(out)));
    });
    return new EpubZip(files);
  }

  has(path: string): boolean {
    return this.get(path) !== undefined;
  }

  get(path: string): Uint8Array | undefined {
    const p = normalize(path);
    if (this.files[p]) return this.files[p];
    // Some producers write paths with different casing or a leading slash.
    const hit = Object.keys(this.files).find((k) => k.toLowerCase() === p.toLowerCase());
    return hit ? this.files[hit] : undefined;
  }

  text(path: string): string {
    const bytes = this.get(path);
    if (!bytes) throw new Error(`Missing file in EPUB: ${path}`);
    return new TextDecoder('utf-8').decode(bytes);
  }

  blob(path: string, mime = 'application/octet-stream'): Blob | undefined {
    const bytes = this.get(path);
    if (!bytes) return undefined;
    // copy into a fresh buffer so the blob doesn't retain the whole zip view
    return new Blob([bytes.slice()], { type: mime });
  }
}

/** Resolve `href` against the directory of `base` (both zip-relative). */
/**
 * The anchor an href points at, without the '#'. Empty when there is none.
 *
 * `resolvePath` throws the fragment away, and has to: it answers "which file
 * in the zip", and a zip has no entry called `chapter.xhtml#part-two`. But
 * the fragment is the whole of what distinguishes one sub-section of a
 * chapter from the next, so it is kept here instead of being lost.
 */
export function fragmentOf(href: string): string {
  const at = href.indexOf('#');
  if (at < 0) return '';
  const raw = href.slice(at + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    /* a percent sign that isn't an escape — rare, and the raw text is a
       better guess at the id than nothing at all */
    return raw;
  }
}

export function resolvePath(base: string, href: string): string {
  if (/^[a-z]+:/i.test(href)) return href; // absolute URL, leave alone
  const clean = href.split('#')[0];
  if (clean.startsWith('/')) return normalize(clean.slice(1));
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  return normalize(dir ? `${dir}/${clean}` : clean);
}

export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of decodeURI(path).replace(/^\//, '').split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    avif: 'image/avif',
  };
  return map[ext] ?? 'application/octet-stream';
}
