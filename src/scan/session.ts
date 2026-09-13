/* One scan, from the book in the library to a position in it.

   The engine can search a book and the OCR module can read a page; this is
   the part that knows where the book is kept. It opens the EPUB, gets an
   index (built once, cached, evictable), answers `locate`, and can fetch the
   surrounding sentence when a match needs a human to look at it.

   Nothing here holds the photograph, and nothing here writes the recognised
   text anywhere. The only durable output of a scan is a position. */

import { db, trimPassageCache, type PassageIndexRecord } from '../db';
import { EpubZip } from '../engine/epub/zip';
import {
  buildPassageIndex,
  locatePassage,
  plainText,
  type Chapter,
  type PassageIndex,
  type PassageMatch,
} from '../engine/passage';
import {
  excerptAt,
  isCurrentPacked,
  packIndex,
  packedSize,
  unpackIndex,
} from '../engine/passageStore';
import { DEFAULT_LANG, tesseractLang } from '../ocr/language';
import type { SpineEntry } from '../engine/types';

/** Raised when the book cannot be searched, with a sentence worth showing. */
export class ScanUnavailable extends Error {}

export interface Scan {
  bookId: string;
  index: PassageIndex;
  /** true when this scan had to build the index rather than find it cached */
  built: boolean;
}

async function readZip(bookId: string): Promise<EpubZip> {
  const file = await db.files.get(bookId);
  if (!file) {
    throw new ScanUnavailable(
      'The EPUB for this book is not on this device, so there is nothing to match the page against. Download it first.'
    );
  }
  return EpubZip.open(file.data);
}

function chaptersOf(zip: EpubZip, spine: SpineEntry[]): Chapter[] {
  const chapters: Chapter[] = [];
  for (let i = 0; i < spine.length; i++) {
    try {
      chapters.push({ spineIndex: i, text: plainText(zip.text(spine[i].href)) });
    } catch {
      // a chapter the zip cannot produce contributes no words, exactly as it
      // does to the word counts taken at import — the two stay in step
      chapters.push({ spineIndex: i, text: '' });
    }
  }
  return chapters;
}

/**
 * Get a searchable index for a book, building it if this is the first scan.
 *
 * Building costs about a second of arithmetic on a full-length novel and the
 * caller is expected to have said so on screen before calling. Every later
 * scan of the same book reads the cache instead, which is the entire reason
 * the cache exists.
 */
export async function openScan(bookId: string, spine: SpineEntry[]): Promise<Scan> {
  const cached = await db.passages.get(bookId);
  if (cached && isCurrentPacked(cached.packed)) {
    // touch it, so the eviction policy can tell a used book from a stale one
    void db.passages.update(bookId, { usedAt: Date.now() });
    return { bookId, index: unpackIndex(cached.packed), built: false };
  }

  const zip = await readZip(bookId);
  const index = buildPassageIndex(chaptersOf(zip, spine));
  if (!index.tokens.length) {
    throw new ScanUnavailable('This book has no text to search.');
  }

  const packed = packIndex(index);
  const row: PassageIndexRecord = {
    bookId,
    packed,
    size: packedSize(packed),
    builtAt: Date.now(),
    usedAt: Date.now(),
  };

  /* Caching is an optimisation, and an optimisation that can fail the
     operation it was meant to speed up is a bad trade. A full disk here
     costs a rebuild next time and nothing else. */
  try {
    await db.passages.put(row);
    await trimPassageCache();
  } catch {
    /* ignore */
  }

  return { bookId, index, built: true };
}

/** Where this page came from, or null if the book cannot say confidently. */
export function locate(scan: Scan, text: string): PassageMatch | null {
  return locatePassage(scan.index, text);
}

/**
 * The book's own words around a match, for the reader to recognise.
 *
 * Re-opens the EPUB rather than holding it: this is only ever called for a
 * match the app is unsure about, and keeping a decompressed book in memory
 * for the whole life of a sheet to save a step that happens rarely is the
 * wrong way round.
 */
export async function excerptFor(
  bookId: string,
  spine: SpineEntry[],
  match: PassageMatch
): Promise<{ text: string; markAt: number } | null> {
  const entry = spine[match.locus.spineIndex];
  if (!entry) return null;
  try {
    const zip = await readZip(bookId);
    return excerptAt(plainText(zip.text(entry.href)), match.locus.wordIndex);
  } catch {
    return null;
  }
}

/**
 * Which language to read this book's pages in.
 *
 * Lives here rather than in the OCR module because this is the layer that
 * knows where a book is kept, and `meta.language` — the EPUB's own
 * `dc:language`, parsed at import — is the only trustworthy answer available.
 * Guessing from the recognised text is circular: you would need to have read
 * the page correctly first.
 *
 * Never throws. A book that has gone missing between the sheet opening and
 * this call is not a reason to refuse the scan; English is a fine assumption
 * to fail back to, and the reader can still paste the text by hand.
 */
export async function scanLanguage(bookId: string): Promise<string> {
  try {
    const book = await db.books.get(bookId);
    return tesseractLang(book?.meta.language);
  } catch {
    return DEFAULT_LANG;
  }
}

/** Drop a book's cached index — used when its EPUB is replaced. */
export async function forgetIndex(bookId: string): Promise<void> {
  await db.passages.delete(bookId);
}
