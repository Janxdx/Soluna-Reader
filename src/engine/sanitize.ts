/* Chapter sanitiser.

   Publisher CSS is deliberately discarded. Every book is then set in the same
   considered typography, which is both a design decision and what makes
   column pagination and word-level pacing reliable. Semantic structure is
   kept; presentation is ours. */

import type { EpubZip } from './epub/zip';
import { mimeFor, resolvePath } from './epub/zip';

const ALLOWED = new Set([
  'P', 'DIV', 'SPAN', 'BR', 'HR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'EM', 'I', 'STRONG', 'B', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK',
  'BLOCKQUOTE', 'CITE', 'Q',
  'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  'FIGURE', 'FIGCAPTION', 'IMG', 'A',
  'CODE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'ASIDE',
]);

const DROP_ENTIRELY = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'AUDIO', 'VIDEO']);

export interface Chapter {
  html: string;
  /** object URLs created for images — revoke when the chapter unmounts */
  objectUrls: string[];
}

export function sanitizeChapter(zip: EpubZip, chapterPath: string): Chapter {
  const raw = zip.text(chapterPath);
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const body = doc.body ?? doc.createElement('body');
  const objectUrls: string[] = [];

  /* Anchors survive, under a different name.

     A table of contents points at sub-sections with `#some-id`, and every one
     of those ids used to be destroyed here by the blanket attribute strip a
     few lines down — so the reader could not jump to a sub-section because
     there was nothing left in the document to jump to.

     They come back as `data-anchor` rather than as `id`, because a chapter's
     ids are the publisher's and the page's are ours: an EPUB containing
     `id="reader"` or `id="app"` would otherwise start answering queries meant
     for the application shell, and two elements sharing an id is a class of
     bug that shows up somewhere else entirely. `data-anchor` is inert — no
     CSS, no fragment navigation, no `getElementById` — and it is what
     `wordAtAnchor` looks for. */
  const anchorOf = (el: Element, tag: string): string | null =>
    el.getAttribute('id') ?? (tag === 'A' ? el.getAttribute('name') : null);

  const cleanElement = (child: Element): void => {
    const tag = child.tagName.toUpperCase();

    if (DROP_ENTIRELY.has(tag)) {
      child.remove();
      return;
    }

    // SVG-wrapped cover images are common — pull the href out and keep the image
    if (tag === 'SVG') {
      const img = child.querySelector('image');
      const href = img?.getAttribute('href') ?? img?.getAttribute('xlink:href') ?? null;
      if (href) {
        const el = doc.createElement('img');
        el.setAttribute('src', href);
        child.replaceWith(el);
        resolveImage(el);
      } else {
        child.remove();
      }
      return;
    }

    const anchor = anchorOf(child, tag);

    if (!ALLOWED.has(tag)) {
      /* Keep the text, drop the wrapper — but not the place it marked. An
         anchor on a tag we don't allow (`<nav id="ch3">`, a custom element)
         leaves an empty marker behind, which costs one span and is the
         difference between a contents entry that works and one that lands
         at the top of the chapter. */
      const kids = Array.from(child.childNodes);
      if (anchor) {
        const marker = doc.createElement('span');
        marker.setAttribute('data-anchor', anchor);
        child.replaceWith(marker, ...kids);
      } else {
        child.replaceWith(...kids);
      }
      /* and clean what we just promoted: it was never visited, because the
         caller snapshotted this node's children before the swap */
      for (const kid of kids) {
        if (kid.nodeType === 1) cleanElement(kid as Element);
      }
      return;
    }

    // strip every attribute, then re-add the few that carry meaning
    const src = child.getAttribute('src');
    const href = child.getAttribute('href');
    const alt = child.getAttribute('alt');
    const colspan = child.getAttribute('colspan');
    for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);

    if (anchor) child.setAttribute('data-anchor', anchor);

    if (tag === 'IMG' && src) {
      child.setAttribute('src', src);
      if (alt) child.setAttribute('alt', alt);
      resolveImage(child as HTMLImageElement);
    }
    if (tag === 'A' && href) {
      // internal links become inert; external links open in a new tab
      if (/^[a-z]+:/i.test(href) && !href.startsWith('file:')) {
        child.setAttribute('href', href);
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noreferrer noopener');
      }
    }
    if ((tag === 'TD' || tag === 'TH') && colspan) child.setAttribute('colspan', colspan);

    clean(child);
  };

  const clean = (node: Element): void => {
    for (const child of Array.from(node.children)) cleanElement(child);
  };

  const resolveImage = (el: HTMLImageElement): void => {
    const src = el.getAttribute('src');
    if (!src) return;
    if (/^(data|https?):/i.test(src)) return;
    const path = resolvePath(chapterPath, src);
    const blob = zip.blob(path, mimeFor(path));
    if (!blob) {
      el.remove();
      return;
    }
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    el.setAttribute('src', url);
  };

  clean(body);

  /* Collapse empty paragraphs left behind by unwrapping — but never one
     that is an anchor, or contains one. An anchor with no text is the normal
     shape of a sub-section marker (`<a id="part-two"></a>` before a heading,
     or the marker this sanitiser leaves where it removed a wrapper), and
     sweeping those away as empty is what made a contents entry point at
     nothing. */
  for (const p of Array.from(body.querySelectorAll('p, div, span'))) {
    if (p.hasAttribute('data-anchor') || p.querySelector('[data-anchor]')) continue;
    if (!p.textContent?.trim() && !p.querySelector('img')) p.remove();
  }

  return { html: body.innerHTML, objectUrls };
}
