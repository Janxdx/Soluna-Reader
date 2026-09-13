import type { BookMeta, ManifestItem, ParsedBook, SpineEntry, TocEntry } from '../types';
import { EpubZip, fragmentOf, mimeFor, resolvePath } from './zip';
import { countWords } from '../tokenize';

const XML = 'application/xml';

function xml(source: string): Document {
  const doc = new DOMParser().parseFromString(source, XML);
  if (doc.querySelector('parsererror')) {
    // Some EPUBs ship slightly malformed XHTML; HTML parsing is more forgiving.
    return new DOMParser().parseFromString(source, 'text/html');
  }
  return doc;
}

/** local-name lookup, namespace-agnostic (EPUB XML namespacing is inconsistent) */
function tags(root: ParentNode, name: string): Element[] {
  return Array.from(root.querySelectorAll('*')).filter(
    (el) => el.localName.toLowerCase() === name.toLowerCase()
  );
}

function firstText(root: ParentNode, name: string): string {
  const el = tags(root, name)[0];
  return el?.textContent?.trim() ?? '';
}

async function findOpfPath(zip: EpubZip): Promise<string> {
  if (zip.has('META-INF/container.xml')) {
    const doc = xml(zip.text('META-INF/container.xml'));
    const full = tags(doc, 'rootfile')[0]?.getAttribute('full-path');
    if (full) return full.replace(/^\//, '');
  }
  const guess = Object.keys(zip.files).find((k) => k.toLowerCase().endsWith('.opf'));
  if (!guess) throw new Error('Not a valid EPUB: no package document found.');
  return guess;
}

function readMeta(pkg: Document): BookMeta {
  const metaEl = tags(pkg, 'metadata')[0] ?? pkg;
  const creators = tags(metaEl, 'creator')
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean);
  return {
    title: firstText(metaEl, 'title') || 'Untitled',
    author: creators.join(', ') || 'Unknown author',
    publisher: firstText(metaEl, 'publisher') || undefined,
    language: firstText(metaEl, 'language') || undefined,
    description: (firstText(metaEl, 'description') || undefined)?.replace(/<[^>]+>/g, ''),
    published: firstText(metaEl, 'date') || undefined,
    identifier: firstText(metaEl, 'identifier') || undefined,
    subjects: tags(metaEl, 'subject')
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean),
  };
}

function readManifest(pkg: Document, opfPath: string): Record<string, ManifestItem> {
  const out: Record<string, ManifestItem> = {};
  const manifestEl = tags(pkg, 'manifest')[0];
  if (!manifestEl) return out;
  for (const el of tags(manifestEl, 'item')) {
    const id = el.getAttribute('id');
    const href = el.getAttribute('href');
    if (!id || !href) continue;
    out[id] = {
      id,
      href: resolvePath(opfPath, href),
      type: el.getAttribute('media-type') ?? '',
      properties: el.getAttribute('properties') ?? '',
    };
  }
  return out;
}

function findCoverPath(
  pkg: Document,
  manifest: Record<string, ManifestItem>
): string | undefined {
  const byProperty = Object.values(manifest).find((i) =>
    i.properties.split(/\s+/).includes('cover-image')
  );
  if (byProperty) return byProperty.href;

  const metaCover = tags(pkg, 'meta').find(
    (el) => el.getAttribute('name')?.toLowerCase() === 'cover'
  );
  const id = metaCover?.getAttribute('content');
  if (id && manifest[id]) return manifest[id].href;

  const guess = Object.values(manifest).find(
    (i) => i.type.startsWith('image/') && /cover/i.test(i.href)
  );
  return guess?.href;
}

/** EPUB 3 navigation document */
function readNav(zip: EpubZip, navPath: string, spine: SpineEntry[]): TocEntry[] {
  const doc = xml(zip.text(navPath));
  const navs = tags(doc, 'nav');
  const tocNav =
    navs.find((n) => (n.getAttribute('epub:type') ?? n.getAttribute('type')) === 'toc') ??
    navs[0];
  if (!tocNav) return [];

  const out: TocEntry[] = [];
  const walk = (list: Element, depth: number) => {
    for (const li of Array.from(list.children).filter((c) => c.localName === 'li')) {
      const a = li.querySelector(':scope > a, :scope > span');
      const href = a?.getAttribute('href');
      const label = a?.textContent?.trim() ?? '';
      if (label) {
        const full = href ? resolvePath(navPath, href) : '';
        out.push({
          label,
          href: full,
          fragment: href ? fragmentOf(href) : '',
          spineIndex: spineIndexOf(spine, full),
          depth,
        });
      }
      const sub = Array.from(li.children).find((c) => c.localName === 'ol');
      if (sub) walk(sub, depth + 1);
    }
  };
  const rootList = Array.from(tocNav.children).find((c) => c.localName === 'ol');
  if (rootList) walk(rootList, 0);
  return out;
}

/** EPUB 2 NCX */
function readNcx(zip: EpubZip, ncxPath: string, spine: SpineEntry[]): TocEntry[] {
  const doc = xml(zip.text(ncxPath));
  const out: TocEntry[] = [];
  const walk = (parent: ParentNode, depth: number) => {
    for (const p of Array.from(parent.children).filter(
      (c) => c.localName === 'navPoint'
    )) {
      const label = firstText(p, 'text');
      const href = tags(p, 'content')[0]?.getAttribute('src') ?? '';
      const full = href ? resolvePath(ncxPath, href) : '';
      if (label) {
        out.push({
          label,
          href: full,
          fragment: href ? fragmentOf(href) : '',
          spineIndex: spineIndexOf(spine, full),
          depth,
        });
      }
      walk(p, depth + 1);
    }
  };
  const navMap = tags(doc, 'navMap')[0];
  if (navMap) walk(navMap, 0);
  return out;
}

function spineIndexOf(spine: SpineEntry[], href: string): number {
  const clean = href.split('#')[0];
  return spine.findIndex((s) => s.href === clean);
}

/** Parse an EPUB into everything the app needs to render and track it. */
export async function parseEpub(data: ArrayBuffer): Promise<{
  zip: EpubZip;
  book: ParsedBook;
}> {
  const zip = await EpubZip.open(data);
  const opfPath = await findOpfPath(zip);
  const pkg = xml(zip.text(opfPath));

  const meta = readMeta(pkg);
  const manifest = readManifest(pkg, opfPath);

  const spineEl = tags(pkg, 'spine')[0];
  const spine: SpineEntry[] = [];
  if (spineEl) {
    for (const el of tags(spineEl, 'itemref')) {
      const idref = el.getAttribute('idref');
      const item = idref ? manifest[idref] : undefined;
      if (!item) continue;
      if (!/xhtml|html|xml/.test(item.type) && !/\.x?html?$/i.test(item.href)) continue;
      spine.push({
        idref: item.id,
        href: item.href,
        linear: el.getAttribute('linear') !== 'no',
        words: 0,
      });
    }
  }
  if (spine.length === 0) throw new Error('This EPUB has no readable chapters.');

  // Count words per chapter up front: powers accurate progress, time estimates
  // and stats without having to open every chapter first.
  let totalWords = 0;
  for (const entry of spine) {
    try {
      entry.words = countWords(zip.text(entry.href));
    } catch {
      entry.words = 0;
    }
    totalWords += entry.words;
  }

  // Table of contents: prefer the EPUB 3 nav document, fall back to NCX.
  let toc: TocEntry[] = [];
  const navItem = Object.values(manifest).find((i) =>
    i.properties.split(/\s+/).includes('nav')
  );
  try {
    if (navItem && zip.has(navItem.href)) toc = readNav(zip, navItem.href, spine);
  } catch {
    toc = [];
  }
  if (toc.length === 0) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncx =
      (ncxId ? manifest[ncxId] : undefined) ??
      Object.values(manifest).find((i) => i.type.includes('ncx'));
    try {
      if (ncx && zip.has(ncx.href)) toc = readNcx(zip, ncx.href, spine);
    } catch {
      toc = [];
    }
  }
  if (toc.length === 0) {
    toc = spine.map((s, i) => ({
      label: `Chapter ${i + 1}`,
      href: s.href,
      spineIndex: i,
      fragment: '',
      depth: 0,
    }));
  }

  const coverPath = findCoverPath(pkg, manifest);
  const coverBlob = coverPath ? zip.blob(coverPath, mimeFor(coverPath)) : undefined;

  return {
    zip,
    book: { meta, spine, toc, manifest, coverPath, coverBlob, totalWords },
  };
}
