import {
  fold, foldTokens, stripFurniture, dehyphenate, buildPassageIndex,
  locatePassage, locusOf, MIN_TOKENS,
} from '../src/engine/passage.ts';
import { countWords } from '../src/engine/tokenize.ts';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) { fails++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
  else console.log(`ok   ${name}`);
};

/* ── folding ───────────────────────────────────────────────────────── */

eq('ligature expands', fold('ﬁrst'), fold('first'));
eq('accents dropped', fold('café'), fold('cafe'));
eq('apostrophe dropped', fold("don't"), fold('dont'));
eq('rn reads as m', fold('learn'), fold('leam'));
eq('l and i collapse', fold('will'), fold('wiii'));
eq('zero for o', fold('b0rn'), fold('born'));
eq('a year is not a word', fold('1984'), '1984');
ok('different words stay different', fold('house') !== fold('mouse'));
eq('punctuation only folds away', fold('—'), '');

/* ── furniture ─────────────────────────────────────────────────────── */

const page = [
  'THE DISPOSSESSED',
  'there was a wall it did not look important',
  'it was built of uncut rocks roughly mortared',
  '114',
].join('\n');
const stripped = stripFurniture(page);
ok('running head removed', !stripped.includes('DISPOSSESSED'));
ok('folio removed', !stripped.includes('114'));
ok('body kept', stripped.includes('uncut rocks'));

eq('dialogue in caps survives mid-page',
  stripFurniture(['one line here', 'two line here', 'NO! NEVER!', 'four line here', 'five line here'].join('\n'))
    .includes('NEVER'), true);

eq('hyphen rejoined', dehyphenate('impor-\ntant'), 'important');
eq('real line break kept', dehyphenate('wall\nthere'), 'wall\nthere');
eq('sharp s rejoined', dehyphenate('schlie-\nßen'), 'schließen');
eq('umlaut rejoined', dehyphenate('Wörter-\nbuch'), 'Wörterbuch');
eq('a capital continuation is a real compound', dehyphenate('Berlin-\nBrandenburg'), 'Berlin-\nBrandenburg');

/* ── index parity with the rest of the app ─────────────────────────── */

const html = '<p>There was a <em>wall</em>.</p><p>It did not look important.</p>';
eq('token count matches countWords', foldTokens(
  html.replace(/<[^>]+>/g, ' ')).length, countWords(html));

/* ── a book to search ──────────────────────────────────────────────── */

/* Deterministic pseudo-prose: real enough to have the statistics that
   matter here (a long tail of rare words carrying most of the signal)
   without shipping a novel into the repo. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const COMMON = 'the of and to a in that he it was for on with as his is at by she her not but they from this had have were all'.split(' ');
const RARE = ('wall stone ambiguous perimeter granite orchard mortar embankment quarry lichen ' +
  'shipyard telescope ansible syndicate corridor threshold anarres urras odonian ' +
  'partition boundary rockface freight scaffold gantry meridian solstice archive ' +
  'harvest silence courtyard doorway lantern verdict cartographer bequest').split(' ');

const prose = (rnd: () => number, n: number): string => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = rnd() < 0.55 ? COMMON[(rnd() * COMMON.length) | 0] : RARE[(rnd() * RARE.length) | 0];
    out.push(w);
    if (i > 0 && i % 14 === 0) out.push('.');
  }
  return out.join(' ');
};

const rnd = mulberry32(42);
const chapters = [0, 1, 2, 3, 4].map((spineIndex) => ({
  spineIndex,
  text: prose(rnd, 3000),
}));

const index = buildPassageIndex(chapters);
ok('index built', index.tokens.length > 14000, `${index.tokens.length} tokens`);
eq('chapter starts', index.spineStarts.length, 5);

/* the passage we will photograph: 45 words from the middle of chapter 3 */
const words = chapters[3].text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
const startInChapter = 900;
const passage = words.slice(startInChapter, startInChapter + 45).join(' ');
const expectedEnd = index.spineStarts[3] + startInChapter + 44;

/* ── OCR corruption ────────────────────────────────────────────────── */

/* What a camera and a recogniser actually do to a page: drop a word, split
   one in half, mistake m for rn and o for 0, and add the page furniture. */
const corrupt = (text: string, seed: number): string => {
  const r = mulberry32(seed);
  const out: string[] = [];
  for (const w of text.split(' ')) {
    const roll = r();
    if (roll < 0.05) continue;                                   // dropped
    if (roll < 0.10) { out.push(w.slice(0, 2), w.slice(2)); continue; }  // split
    if (roll < 0.22) {
      out.push(w.replace(/m/g, 'rn').replace(/o/g, '0').replace(/i/g, 'l'));
      continue;
    }
    out.push(w);
  }
  return out.join(' ');
};

const photo = ['CHAPTER FOUR', corrupt(passage, 7), '212'].join('\n');
const hit = locatePassage(index, photo);

ok('found the passage', hit !== null);
if (hit) {
  ok('landed within a few words of the end',
    Math.abs(hit.tokenIndex - expectedEnd) <= 5,
    `token ${hit.tokenIndex}, expected ~${expectedEnd}`);
  eq('right chapter', hit.locus.spineIndex, 3);
  ok('score is high', hit.score >= 0.75, `score ${hit.score.toFixed(2)}`);
  ok('confident enough to apply', hit.confidence === 'sure', `got ${hit.confidence}`);
}

/* heavier damage still lands, but should be offered for review rather than
   applied silently */
const rough = locatePassage(index, corrupt(corrupt(passage, 7), 99));
ok('survives heavy damage', rough !== null);

/* ── refusals ──────────────────────────────────────────────────────── */

eq('too few words refused', locatePassage(index, passage.split(' ').slice(0, 12).join(' ')), null);
eq('text not in the book refused',
  locatePassage(index, prose(mulberry32(999), 60)), null);
eq('empty input refused', locatePassage(index, ''), null);

/* the gate that matters: the same passage printed twice */
const dup = buildPassageIndex([
  { spineIndex: 0, text: prose(mulberry32(5), 2000) },
  { spineIndex: 1, text: passage },
  { spineIndex: 2, text: prose(mulberry32(6), 2000) },
  { spineIndex: 3, text: passage },
  { spineIndex: 4, text: prose(mulberry32(7), 2000) },
]);
eq('ambiguous passage refused rather than guessed',
  locatePassage(dup, corrupt(passage, 7)), null);

/* ── locus mapping ─────────────────────────────────────────────────── */

const first = locusOf(index, 0);
eq('first token is chapter 0 word 0', [first.spineIndex, first.wordIndex], [0, 0]);
const third = locusOf(index, index.spineStarts[3]);
eq('chapter boundary maps to word 0', [third.spineIndex, third.wordIndex], [3, 0]);
const last = locusOf(index, index.tokens.length - 1);
eq('last token is 100%', last.percent, 1);
ok('percent rises through the book', locusOf(index, 100).percent < locusOf(index, 10000).percent);

/* ── cost ──────────────────────────────────────────────────────────── */

const t0 = Date.now();
for (let i = 0; i < 20; i++) locatePassage(index, photo);
const per = (Date.now() - t0) / 20;
ok('fast enough to feel instant', per < 150, `${per.toFixed(1)}ms per lookup`);
console.log(`     (${per.toFixed(1)}ms per lookup over ${index.tokens.length} tokens, min ${MIN_TOKENS} words)`);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
