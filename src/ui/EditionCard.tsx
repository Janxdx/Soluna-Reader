/* What the world knows about this book.
 *
 * Sits under the title in the rating sheet: the cover — the EPUB's own,
 * read straight off the device, where there is one — and the printing
 * (who published it, when, how many pages). None of it is yours and none
 * of it is editable — it is the other half of the page, next to the half
 * that is entirely your opinion.
 *
 * It never blocks and never shouts. A lookup that finds nothing renders
 * nothing at all rather than an empty state explaining that nothing was
 * found: you came here to rate a book, and the card is a bonus.
 */

import { useEffect, useState } from 'react';
import { coverToBlob, db } from '../db';
import { editionCoverBlob } from '../meta/editions';
import { useEditions } from '../store/editions';
import { editionKey, liveryFor } from '../engine/edition';

interface Props {
  title: string;
  author: string;
  /** the edition's own language, from the EPUB where there is one */
  language?: string;
  publisher?: string;
  /** the library book this rating resolves to, if any — the source of
      the cover shown here; see the effect below */
  bookId?: string;
}

export function EditionCard({ title, author, language, publisher, bookId }: Props) {
  const byKey = useEditions((s) => s.byKey);
  const ensure = useEditions((s) => s.ensure);

  const key = title.trim() ? editionKey(title, author) : '';
  const row = key ? byKey[key] : undefined;

  /* One lookup, for the book whose sheet is open. Cheap and clearly wanted
     — unlike the shelf-wide fill, which only runs when the realistic shelf
     is switched on. Catalogue facts only now — publisher, page count,
     year — never a cover; see meta/editions.ts. */
  useEffect(() => {
    if (!title.trim()) return;
    void ensure({ title, author, ...(language ? { lang: language } : {}), ...(publisher ? { publisher } : {}) });
  }, [title, author, language, publisher, ensure]);

  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  /* The EPUB's own cover first — already on the device, and the standard
     image now. A catalogue's stored cover only stands in for a row an
     older version of the app already fetched and cached; a fresh lookup
     never has one to fall back to. */
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;

    void (async () => {
      const own = bookId ? await db.covers.get(bookId) : undefined;
      const blob = own ? coverToBlob(own) : row ? editionCoverBlob(row) : null;
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setCoverUrl(url);
    })();

    /* Revoked on the way out: an object URL pins the whole blob in memory
       until it is released, and a sheet opened once per book across a
       session would otherwise hold every cover it ever showed. */
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setCoverUrl(null);
    };
  }, [bookId, row]);

  const d = row?.data;
  const livery = liveryFor({ publisher: publisher ?? d?.publisher, series: d?.series });

  /* The printing, as one line. Assembled from whatever came back rather
     than laid out in fixed slots, because most books know two of these
     three and which two varies. */
  const facts = [
    publisher ?? d?.publisher,
    d?.year ? String(d.year) : null,
    d?.pageCount ? `${d.pageCount} pages` : null,
  ].filter(Boolean) as string[];

  /* Nothing at all came back — render nothing rather than a card
     explaining that nothing came back. You came here to rate a book. */
  if (!coverUrl && !facts.length) return null;

  return (
    <section className="edition-card">
      {coverUrl && (
        <img className="edition-cover" src={coverUrl} alt={`Cover of ${title}`} loading="lazy" />
      )}

      <div className="edition-body">
        {facts.length > 0 && <p className="edition-facts">{facts.join(' · ')}</p>}

        {/* What the shelf is going to do with this, in one line. Worth
            saying: a spine drawn in the mood colour looks identical
            whether no cover was found, the cover held no usable colour, or
            the lookup never ran — and those are three different problems.
            It is also the honest answer to "why is this one grey". */}
        <p className="edition-livery">
          {livery
            ? `Drawn on the shelf as ${livery.label}`
            : d?.palette?.length || d?.edgeTexture
              ? 'Drawn on the shelf in its own cover colours'
              : coverUrl
                ? 'No usable colour in the cover — drawn by mood'
                : 'No cover found — drawn by mood'}
        </p>
      </div>
    </section>
  );
}
