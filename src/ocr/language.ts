/* Which language the recogniser should expect on the page.

   Tesseract is not a general character classifier with an optional
   dictionary bolted on. Its LSTM is trained per language and decodes against
   that language's character set and word shapes, so asking `eng` to read a
   German page is not "slightly worse" — it is a different, wrong model. It
   will not produce ä, ö, ü or ß at all, and it will bend every long compound
   towards something English-shaped. Forty words of that clear neither
   `MIN_SCORE` nor `MIN_MARGIN`, and the reader is told the page was garbled
   when in fact it was read carefully in the wrong tongue.

   The book already knows. Every EPUB carries `dc:language` in its OPF, we
   parse it at import, and it is sitting in `meta.language`. This module is
   the translation from that tag to the traineddata file Tesseract wants.

   Pure: no DOM, no imports, safe to test in node. */

/** What we fall back to when the book doesn't say, or says something we
    have no data file for. English is the honest default for this library
    and is also the one language whose data is likely already cached. */
export const DEFAULT_LANG = 'eng';

/* ISO 639-1 (and the handful of 639-2/B codes that differ from 639-2/T,
   which older EPUBs still use) → the name of the traineddata file.

   Kept to languages set in Latin, Greek or Cyrillic type, because those are
   the ones a page of a novel is actually printed in and each one costs a
   line here but nothing at runtime — only the book's own language is ever
   fetched. */
const CODES: Record<string, string> = {
  // Germanic
  en: 'eng', eng: 'eng',
  de: 'deu', deu: 'deu', ger: 'deu',
  nl: 'nld', nld: 'nld', dut: 'nld',
  af: 'afr', afr: 'afr',
  sv: 'swe', swe: 'swe',
  da: 'dan', dan: 'dan',
  no: 'nor', nor: 'nor', nb: 'nor', nob: 'nor', nn: 'nor', nno: 'nor',
  is: 'isl', isl: 'isl', ice: 'isl',
  yi: 'yid', yid: 'yid',

  // Romance
  fr: 'fra', fra: 'fra', fre: 'fra',
  es: 'spa', spa: 'spa',
  it: 'ita', ita: 'ita',
  pt: 'por', por: 'por',
  ro: 'ron', ron: 'ron', rum: 'ron',
  ca: 'cat', cat: 'cat',
  gl: 'glg', glg: 'glg',
  la: 'lat', lat: 'lat',

  // Slavic and Baltic
  pl: 'pol', pol: 'pol',
  cs: 'ces', ces: 'ces', cze: 'ces',
  sk: 'slk', slk: 'slk', slo: 'slk',
  sl: 'slv', slv: 'slv',
  hr: 'hrv', hrv: 'hrv',
  sr: 'srp', srp: 'srp',
  bs: 'bos', bos: 'bos',
  ru: 'rus', rus: 'rus',
  uk: 'ukr', ukr: 'ukr',
  be: 'bel', bel: 'bel',
  bg: 'bul', bul: 'bul',
  mk: 'mkd', mkd: 'mkd', mac: 'mkd',
  lt: 'lit', lit: 'lit',
  lv: 'lav', lav: 'lav',

  // Everything else that turns up in a Latin-set library
  fi: 'fin', fin: 'fin',
  et: 'est', est: 'est',
  hu: 'hun', hun: 'hun',
  el: 'ell', ell: 'ell', gre: 'ell',
  tr: 'tur', tur: 'tur',
  ga: 'gle', gle: 'gle', iri: 'gle',
  cy: 'cym', cym: 'cym', wel: 'cym',
  eu: 'eus', eus: 'eus', baq: 'eus',
  mt: 'mlt', mlt: 'mlt',
  sq: 'sqi', sqi: 'sqi', alb: 'sqi',
  id: 'ind', ind: 'ind',
  ms: 'msa', msa: 'msa', may: 'msa',
  vi: 'vie', vie: 'vie',
  sw: 'swa', swa: 'swa',
  eo: 'epo', epo: 'epo',
};

/**
 * The traineddata name for a BCP-47 tag out of an EPUB's `dc:language`.
 *
 * Only the primary subtag is consulted: `de-DE`, `de-CH` and `de_AT` are one
 * model, and a book tagged `en-GB` is not going to be helped by us trying to
 * find `eng-GB`. Region, script and variant subtags are dropped on the floor
 * deliberately.
 *
 * Anything unrecognised falls back to English rather than throwing. A wrong
 * guess costs accuracy on one scan; a throw costs the whole feature, and the
 * `dc:language` field is filled in by whoever made the EPUB, which is to say
 * it can contain anything at all.
 */
export function tesseractLang(tag?: string | null): string {
  if (!tag) return DEFAULT_LANG;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (!primary) return DEFAULT_LANG;
  return CODES[primary] ?? DEFAULT_LANG;
}

/** True when we would read this book in something other than English —
    used only to warn that the first scan has a language pack to fetch. */
export function isNonDefault(lang: string): boolean {
  return lang !== DEFAULT_LANG;
}
