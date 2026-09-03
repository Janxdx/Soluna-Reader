/* The peek card — SHELF-3D.md §8.
 *
 * A tap still opens the RatingSheet; this is the second, lighter way to
 * ask a book a question without committing to that. A mouse gets it on
 * hover, because a mouse can hover; a finger gets it on a hold, because a
 * finger can't — and either way it's read-only, floating above the shelf
 * rather than reflowing it.
 *
 * Rendered through a portal to `document.body` on purpose. `.shelf-row`
 * carries `contain: layout paint` (see the note at its own definition in
 * global.css) so the row can skip layout for whatever has scrolled off
 * screen — but containment also clips anything positioned inside it, portal
 * or not, to the row's own box. A card meant to float above the row can't
 * be a descendant of it.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { moodColor, moodOf, type RatingRecord } from '../engine/rating';
import type { EditionData } from '../engine/edition';
import type { SpineLook } from '../engine/spine';

const MARGIN = 10;
const GAP = 10;

export interface PeekAnchor {
  id: string;
  rect: DOMRect;
}

interface Props {
  anchor: PeekAnchor;
  rating: RatingRecord;
  look: SpineLook;
  edition?: EditionData;
  publisher?: string;
  dark: boolean;
}

/* The teaser is a full paragraph; the card only has room for the subject
   sentence, not a plot summary a fingertip's width above the fan. Splits
   on the first sentence-ending punctuation followed by whitespace or the
   end of the string, so a title containing a period ("Der Prozess (The
   Trial)...") isn't cut early by it — there's no punctuation there for
   this to match on in the first place. */
function firstSentence(text: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(text.trim());
  return m ? m[0] : text;
}

export function PeekCard({ anchor, rating, look, edition, publisher, dark }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  /* Off-screen and invisible until measured, rather than guessed and
     corrected: a guess would show a real card in the wrong place for a
     frame, which reads as a glitch, where a fade-in one frame later than
     it could have been in principle doesn't. */
  const [style, setStyle] = useState<CSSProperties>({ left: -9999, top: -9999, opacity: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const card = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchor.rect.left + anchor.rect.width / 2 - card.width / 2;
    left = Math.max(MARGIN, Math.min(left, vw - card.width - MARGIN));

    /* Above the book by default, matching how a real card would be laid
       on top of it — below only when there isn't room, for a book on the
       shelf's own top row. */
    const above = anchor.rect.top - GAP - card.height;
    const top = above >= MARGIN ? above : anchor.rect.bottom + GAP;
    const clampedTop = Math.max(MARGIN, Math.min(top, vh - card.height - MARGIN));

    setStyle({ left, top: clampedTop, opacity: 1 });
  }, [anchor]);

  const mood = moodOf(rating.mood);
  const printer = publisher ?? edition?.publisher ?? look.livery?.label;
  const facts = [rating.author || null, edition?.year ? String(edition.year) : null, printer ?? null].filter(
    Boolean
  ) as string[];
  const teaser = edition?.wiki?.extract ? firstSentence(edition.wiki.extract) : null;

  return createPortal(
    <div className="peek-card" ref={ref} style={style} aria-hidden="true">
      <p className="peek-title">{rating.title}</p>
      {facts.length > 0 && <p className="peek-facts">{facts.join(' · ')}</p>}
      <p className="peek-score">
        <i style={{ background: moodColor(mood, dark) }} aria-hidden />
        {rating.overall}/10{mood ? ` · ${mood.label}` : ''}
      </p>
      {teaser && <p className="peek-teaser">{teaser}</p>}
    </div>,
    document.body
  );
}
