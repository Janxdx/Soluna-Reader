import { tesseractLang, isNonDefault, DEFAULT_LANG } from '../src/ocr/language.ts';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};

/* ── the case this exists for ──────────────────────────────────────── */

eq('german', tesseractLang('de'), 'deu');
eq('german with a region', tesseractLang('de-DE'), 'deu');
eq('german, austrian', tesseractLang('de-AT'), 'deu');
eq('german with an underscore', tesseractLang('de_CH'), 'deu');
eq('german, three letter', tesseractLang('deu'), 'deu');
eq('german, the bibliographic code older epubs use', tesseractLang('ger'), 'deu');

/* ── the default, and the ways a book declines to say ──────────────── */

eq('english', tesseractLang('en'), 'eng');
eq('english with a region', tesseractLang('en-GB'), 'eng');
eq('missing', tesseractLang(undefined), DEFAULT_LANG);
eq('null', tesseractLang(null), DEFAULT_LANG);
eq('empty', tesseractLang(''), DEFAULT_LANG);
eq('whitespace', tesseractLang('   '), DEFAULT_LANG);
eq('a language we have no data for', tesseractLang('qya'), DEFAULT_LANG);
eq('a publisher writing prose in the field', tesseractLang('English'), DEFAULT_LANG);

/* `English` above is the point of the fallback: it starts with `en`, but the
   primary subtag is the whole string and it is not a code, so it falls
   through rather than being cleverly salvaged. A wrong-but-plausible guess
   is worse than the default, because the default is at least predictable. */

/* ── a spread of the rest ──────────────────────────────────────────── */

eq('french', tesseractLang('fr'), 'fra');
eq('french, bibliographic', tesseractLang('fre'), 'fra');
eq('dutch', tesseractLang('nl'), 'nld');
eq('spanish', tesseractLang('es-419'), 'spa');
eq('portuguese, brazil', tesseractLang('pt-BR'), 'por');
eq('norwegian bokmal folds into norwegian', tesseractLang('nb'), 'nor');
eq('norwegian nynorsk folds into norwegian', tesseractLang('nn'), 'nor');
eq('czech, bibliographic', tesseractLang('cze'), 'ces');
eq('greek', tesseractLang('el'), 'ell');
eq('russian', tesseractLang('ru'), 'rus');
eq('latin', tesseractLang('la'), 'lat');

/* ── case ──────────────────────────────────────────────────────────── */

eq('shouty', tesseractLang('DE-DE'), 'deu');
eq('mixed', tesseractLang('De'), 'deu');

/* ── the flag the sheet words its spinner from ─────────────────────── */

eq('english needs no extra download', isNonDefault('eng'), false);
eq('german does', isNonDefault('deu'), true);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
