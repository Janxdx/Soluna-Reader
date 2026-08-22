/* What the world knows about this book.
 *
 * Sits under the title in the rating sheet: the cover, the printing (who
 * published it, when, how many pages), and the opening of its Wikipedia
 * article in the language of the edition. None of it is yours and none of
 * it is editable — it is the other half of the page, next to the half
 * that is entirely your opinion.
 *
 * Two rules this card follows and would be wrong not to.
 *
 * It never blocks and never shouts. A lookup that finds nothing renders
 * nothing at all rather than an empty state explaining that nothing was
 * found: you came here to rate a book, and the card is a bonus.
 *
 * The Wikipedia text is attributed and linked, because CC BY-SA requires
 * it. That is not a footnote to add later — quoting the article without
 * naming it is simply not one of the things we are allowed to do with it.
 */

import { useEffect, useState } from 'react';
import { editionCoverBlob } from '../meta/editions';
import { useEditions } from '../store/editions';
import { editionKey, liveryFor } from '../engine/edition';

interface Props {
  title: string;
  author: string;
  /** the edition's own language, from the EPUB where there is one */
  language?: string;
  publisher?: string;
}

export function EditionCard({ title, author, language, publisher }: Props) {
  const byKey = useEditions((s) => s.byKey);
  const ensure = useEditions((s) => s.ensure);

  const key = title.trim() ? editionKey(title, author) : '';
  const row = key ? byKey[key] : undefined;

  /* One lookup, for the book whose sheet is open. Cheap and clearly wanted
     — unlike the shelf-wide fill, which only runs when the realistic shelf
     is switched on. */
  useEffect(() => {
    if (!title.trim()) return;
    void ensure({ title, author, ...(language ? { lang: language } : {}), ...(publisher ? { publisher } : {}) });
  }, [title, author, language, publisher, ensure]);

  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!row) return;
    const blob = editionCoverBlob(row);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setCoverUrl(url);
    /* Revoked on the way out: an object URL pins the whole blob in memory
       until it is released, and a sheet opened once per book across a
       session would otherwise hold every cover it ever showed. */
    return () => {
      URL.revokeObjectURL(url);
      setCoverUrl(null);
    };
  }, [row]);

  if (!row) return null;

  const d = row.data;
  const livery = liveryFor({ publisher: publisher ?? d.publisher, series: d.series });

  /* The printing, as one line. Assembled from whatever came back rather
     than laid out in fixed slots, because most books know two of these
     three and which two varies. */
  const facts = [
    publisher ?? d.publisher,
    d.year ? String(d.year) : null,
    d.pageCount ? `${d.pageCount} pages` : null,
  ].filter(Boolean) as string[];

  /* Nothing at all came back — render nothing rather than a card
     explaining that nothing came back. You came here to rate a book. */
  if (!coverUrl && !facts.length && !d.wiki && !d.pageCount) return null;

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
            : d.palette?.length || d.edgeTexture
              ? 'Drawn on the shelf in its own cover colours'
              : coverUrl
                ? 'No usable colour in the cover — drawn by mood'
                : 'No cover found — drawn by mood'}
        </p>

        {d.wiki && (
          <>
            <p className="edition-extract">{d.wiki.extract}</p>
            {/* Attribution is the licence condition, not decoration — see
                the note at the top. The language is named because the
                summary falls back to English when the reader's language
                has no article, and a German reader given English prose
                should be able to see why. */}
            <p className="edition-source">
              <a href={d.wiki.url} target="_blank" rel="noreferrer noopener">
                Wikipedia ({d.wiki.lang})
              </a>
              <span> · CC BY-SA</span>
            </p>
          </>
        )}
      </div>
    </section>
  );
}
