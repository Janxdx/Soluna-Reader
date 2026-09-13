/* Word tokenisation.

   Every word in a rendered chapter is wrapped in its own <span class="w">.
   That single decision powers three things at once: the pacer can highlight a
   word by index, pagination can ask which page a word landed on, and word
   counts for statistics are exact rather than estimated. */

export const HAS_CONTENT = /[\p{L}\p{N}]/u;

/** Readable text from chapter markup. Anything that counts or indexes words
    has to strip the markup the same way, or the indices stop agreeing with
    the spans on the page — so there is exactly one place that does it. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');
}

/** Count words in a raw HTML/XHTML string (used at import time). */
export function countWords(html: string): number {
  const text = plainText(html);
  let n = 0;
  for (const token of text.split(/\s+/)) if (HAS_CONTENT.test(token)) n++;
  return n;
}

/** Words that should not be wrapped (their layout is fragile). */
const SKIP = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'SVG']);

/**
 * Wrap every word inside `root` in `<span class="w" data-i="n">`.
 * Returns the ordered list of word strings — index n in this array
 * corresponds to `[data-i="n"]` in the DOM.
 */
export function tokenizeInto(root: HTMLElement): string[] {
  const words: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    targets.push(current as Text);
    current = walker.nextNode();
  }

  for (const node of targets) {
    const parts = (node.nodeValue ?? '').split(/(\s+)/);
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part === '') continue;
      if (!HAS_CONTENT.test(part)) {
        frag.appendChild(document.createTextNode(part));
        continue;
      }
      const span = document.createElement('span');
      span.className = 'w';
      span.dataset.i = String(words.length);
      span.textContent = part;
      words.push(part);
      frag.appendChild(span);
    }
    node.parentNode?.replaceChild(frag, node);
  }

  return words;
}

/**
 * The word a contents entry's anchor points at, or null if it isn't there.
 *
 * A chapter's sub-sections all live in one file and are told apart only by
 * the `#fragment` their contents entry carries; `sanitizeChapter` preserves
 * those as `data-anchor`. What the reader needs from one is a word index,
 * because a word index is the only kind of position it can navigate to —
 * pagination, the pacer and the saved place are all expressed in them.
 *
 * The answer is the first word *at or after* the anchor rather than inside
 * it, because an anchor is as often an empty `<a id="…"/>` sitting in front
 * of a heading as it is a `<section>` wrapped around one. `compareDocument-
 * Position` treats both the same: a span inside the target and a span after
 * it both come back as FOLLOWING, and the spans are walked in document
 * order, so the first hit is the nearest one either way.
 */
export function wordAtAnchor(root: HTMLElement, anchor: string): number | null {
  if (!anchor) return null;

  /* Compared rather than selected: an id is allowed to contain characters
     that would need escaping in a selector, and getting that escaping subtly
     wrong fails as "no such section" rather than as an error anyone sees. */
  let target: Element | null = null;
  for (const el of root.querySelectorAll('[data-anchor]')) {
    if (el.getAttribute('data-anchor') === anchor) {
      target = el;
      break;
    }
  }
  if (!target) return null;

  for (const span of root.querySelectorAll<HTMLElement>('.w')) {
    if (target.compareDocumentPosition(span) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const i = Number(span.dataset.i);
      return Number.isFinite(i) ? i : null;
    }
  }
  /* an anchor after the last word — the end of the chapter is where it goes */
  return null;
}
