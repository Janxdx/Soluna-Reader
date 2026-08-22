/* Editions: identity, matching, liveries and how big a book is.
 *
 * This is the layer that decides whether a shelf shows the right cover, and
 * it is the layer no build or typecheck can have an opinion about — a
 * matcher that confidently returns the wrong book typechecks perfectly.
 */

import {
  DEFAULT_HEIGHT_MM, MATCH_FLOOR, editionKey, editionSlug, liveryFor,
  normalizeAuthor, normalizeTitle, pickCandidate, realMetrics, scoreCandidate,
  spineDirection, thicknessMm,
} from '../src/engine/edition.ts';
import { groundFrom, inkOn, luma, shade, spineLook } from '../src/engine/spine.ts';
import { isPaperOrInk } from '../src/meta/palette.ts';
import type { RatingRecord } from '../src/engine/rating.ts';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};
const ok = (name: string, cond: boolean) => eq(name, cond, true);

/* ── identity ───────────────────────────────────────────────────────
   The key has to survive every way the same book gets typed in, because a
   rating carries the strings a person typed and the library carries the
   ones an EPUB declared, and they are rarely the same. */

eq('umlauts fold away', normalizeTitle('Die Verwandlung'), 'verwandlung');
eq('leading article dropped', normalizeTitle('Der Prozess'), 'prozess');
eq('a subtitle is not part of the title', normalizeTitle('Solaris: Roman'), 'solaris');
eq('an em-dash subtitle goes too', normalizeTitle('Stoner — A Novel'), 'stoner');
ok(
  'accents do not split a book in two',
  normalizeTitle('Á la recherche') === normalizeTitle('A la recherche')
);
ok(
  'a title that is only an article keeps it',
  normalizeTitle('Die').length > 0
);

eq('author word order does not matter',
  normalizeAuthor('Le Guin, Ursula K.'), normalizeAuthor('Ursula K. Le Guin'));
eq('a middle initial is not identity',
  normalizeAuthor('Ursula Le Guin'), normalizeAuthor('Ursula K. Le Guin'));

ok(
  'the same book from two shelves is one key',
  editionKey('Der Prozeß', 'Franz Kafka') === editionKey('Der Prozess', 'Kafka, Franz')
);
ok(
  'two different books are not',
  editionKey('Das Schloss', 'Franz Kafka') !== editionKey('Der Prozess', 'Franz Kafka')
);

/* The slug becomes an R2 object name and a URL segment, and the Worker
   rejects anything that is not lowercase alphanumerics and dashes. A title
   full of punctuation is the case that would have shipped broken. */
const slugOf = (t: string, a: string) => editionSlug(editionKey(t, a));
ok('a slug is path-safe', /^[a-z0-9-]{1,80}$/.test(slugOf('Der Prozess', 'Franz Kafka')));
ok('punctuation cannot escape the slug',
  /^[a-z0-9-]{1,80}$/.test(slugOf('¿Quién? / ../etc', 'A. B.')));
ok('an absurd title still fits the length limit',
  /^[a-z0-9-]{1,80}$/.test(slugOf('x'.repeat(400), 'y'.repeat(400))));
ok('a slug is stable', slugOf('Der Prozess', 'Franz Kafka') === slugOf('Der Prozeß', 'Kafka, Franz'));
ok('two books do not share a slug',
  slugOf('Das Schloss', 'Franz Kafka') !== slugOf('Der Prozess', 'Franz Kafka'));

/* Long titles by the same author are the collision the hash exists for:
   the readable prefix is truncated, so without it these would be one book. */
ok(
  'a truncated prefix does not collide two books',
  slugOf('The Fellowship of the Ring Being the First Part of the Lord of the Rings', 'Tolkien') !==
    slugOf('The Fellowship of the Ring Being the Second Part of the Lord of the Rings', 'Tolkien')
);

/* ── matching ───────────────────────────────────────────────────────
   The app picks silently, so what matters is not that the right book
   scores well — it is that the wrong one scores badly enough to be
   refused. No cover is a neutral outcome; a wrong cover is a bug. */

const want = { title: 'Der Prozess', author: 'Franz Kafka', language: 'de' };

ok('an exact match scores high',
  scoreCandidate(want, { title: 'Der Prozess', author: 'Franz Kafka' }) > 0.85);
ok('a subtitle does not hurt',
  scoreCandidate(want, { title: 'Der Prozess: Roman', author: 'Franz Kafka' }) >= MATCH_FLOOR);
ok('a missing author still passes on a strong title',
  scoreCandidate(want, { title: 'Der Prozess', author: '' }) >= MATCH_FLOOR);

ok('a study guide about the book is refused',
  scoreCandidate(want, { title: 'Lektürehilfen Franz Kafka Der Prozess', author: 'Wilhelm Große' }) < MATCH_FLOOR);
ok('a different book by the same author is refused',
  scoreCandidate(want, { title: 'Das Schloss', author: 'Franz Kafka' }) < MATCH_FLOOR);
ok('a different author with the same title scores below an exact match',
  scoreCandidate(want, { title: 'Der Prozess', author: 'Peter Weiss' }) <
    scoreCandidate(want, { title: 'Der Prozess', author: 'Franz Kafka' }));

eq('nothing convincing means nothing shown',
  pickCandidate(want, [{ title: 'Kochen mit Kafka', author: 'Wer Auch Immer' }]), null);
eq('the best of several is the one returned',
  pickCandidate(want, [
    { title: 'Der Prozess (Analyse)', author: 'Ein Anderer' },
    { title: 'Der Prozess', author: 'Franz Kafka', hasCover: true },
  ])?.item.author,
  'Franz Kafka');
eq('an empty list is not a match', pickCandidate(want, []), null);

/* ── liveries ─────────────────────────────────────────────────────── */

eq('Reclam is recognised', liveryFor({ publisher: 'Reclam, Ditzingen' })?.key, 'reclam');
eq('the series beats the house it belongs to',
  liveryFor({ publisher: 'Suhrkamp', series: 'edition suhrkamp' })?.key, 'edition-suhrkamp');
eq('Suhrkamp on its own is Suhrkamp',
  liveryFor({ publisher: 'Suhrkamp Verlag' })?.key, 'suhrkamp');
eq('Penguin Classics is not plain Penguin',
  liveryFor({ publisher: 'Penguin Classics' })?.key, 'penguin-classics');
eq('plain Penguin is the tri-band',
  liveryFor({ publisher: 'Penguin Books' })?.pattern, 'triband');
eq('an unknown publisher has no livery', liveryFor({ publisher: 'Kleinstverlag Müller' }), null);
eq('no publisher at all is not an error', liveryFor({}), null);

/* ── how a spine reads ─────────────────────────────────────────────
   German spines read downwards, English ones upwards. Getting this
   backwards is the kind of thing that looks wrong without anybody being
   able to say why. */

eq('German reads down', spineDirection('de'), 'down');
eq('a regional tag is still German', spineDirection('de-DE'), 'down');
eq('English reads up', spineDirection('en'), 'up');
eq('American English reads up too', spineDirection('en-US'), 'up');
eq('Dutch reads up', spineDirection('nl'), 'up');
eq('French reads down', spineDirection('fr'), 'down');
eq('an unknown language falls back to down', spineDirection(undefined), 'down');

/* ── how big a book is ─────────────────────────────────────────────── */

ok('a novella is thinner than a doorstop', thicknessMm(120) < thicknessMm(900));
ok('a 320-page novel is about 20 mm', Math.abs(thicknessMm(320) - 20) < 3);
ok('thickness falls back to the word count', thicknessMm(undefined, 90_000) > thicknessMm(undefined, 20_000));
ok('an unknown length is not zero', thicknessMm() > 0);
ok('an omnibus does not become a wall', thicknessMm(4000) <= 70);

const reclam = realMetrics({ heightMm: 148, pageCount: 96 });
const novel = realMetrics({ heightMm: DEFAULT_HEIGHT_MM, pageCount: 320 });
ok('a Reclam stands shorter than a novel', parseFloat(reclam.height) < parseFloat(novel.height));
ok('and thinner', reclam.width < novel.width);
ok('nothing grows taller than its shelf', parseFloat(realMetrics({ heightMm: 900 }).height) <= 100);

/* ── colour ─────────────────────────────────────────────────────────── */

ok('white is light', luma('#ffffff') > 0.95);
ok('black is dark', luma('#000000') < 0.05);
ok('ink goes dark on a pale ground', inkOn('#F2C900').includes('12%'));
ok('ink goes light on a dark ground', inkOn('#1D2A3A').includes('96%'));
ok('shading up lightens', luma(shade('#804020', 0.4)) > luma('#804020'));
ok('shading down darkens', luma(shade('#804020', -0.4)) < luma('#804020'));
eq('a colour we cannot parse is passed through', shade('rebeccapurple', 0.2), 'rebeccapurple');

/* The ground is not simply the commonest colour: covers are mostly their
   background, and a near-white spine reads as a gap on the shelf. */
eq('a washed-out first colour loses to a bound-looking second',
  groundFrom(['#f4f1ea', '#8a3324', '#221c14']), '#8a3324');
eq('a strong first colour keeps its place',
  groundFrom(['#8a3324', '#f4f1ea', '#221c14']), '#8a3324');
eq('no palette means no ground', groundFrom(undefined), null);
eq('an empty palette means no ground', groundFrom([]), null);

/* ── which pixels are the cover ─────────────────────────────────────
   The palette drops paper and ink before it counts anything. The test has
   to be on the *lowest* channel: white is every channel high, while a
   saturated red has one channel just as high as white's. Testing the
   highest threw away exactly the vivid covers the feature exists for, and
   silently — an empty palette is indistinguishable from a failed lookup,
   so the spine came out mood-grey as though nothing had been found. */

ok('white is paper', isPaperOrInk(255, 255, 255));
ok('near-white is paper', isPaperOrInk(250, 248, 245));
ok('cream is paper', isPaperOrInk(246, 244, 243));
ok('black is ink', isPaperOrInk(8, 8, 10));

ok('a vivid red is not paper', !isPaperOrInk(250, 40, 40));
ok('a vivid yellow is not paper', !isPaperOrInk(242, 201, 0));
ok('Reclam yellow survives', !isPaperOrInk(0xf2, 0xc9, 0x00));
ok('Penguin orange survives', !isPaperOrInk(0xe8, 0x72, 0x1c));
ok('a deep blue is not ink', !isPaperOrInk(29, 42, 58));
ok('a mid grey is neither', !isPaperOrInk(128, 128, 128));

/* ── the two shelves ────────────────────────────────────────────────── */

const rating: RatingRecord = {
  id: 'r1',
  title: 'Der Prozess',
  author: 'Franz Kafka',
  overall: 9,
  axes: {},
  mood: 'indigo',
  words: 80_000,
  ratedAt: 0,
  updatedAt: 0,
};

const dataLook = spineLook({ rating, mode: 'data', dark: false });
ok('the data shelf is not claiming to be real', !dataLook.real);
ok('the data shelf still draws without an edition', dataLook.width > 0);

/* A high score stands taller than a low one — the whole premise of the
   data shelf, and the thing the realistic one gives up. */
const low = spineLook({ rating: { ...rating, overall: 2 }, mode: 'data', dark: false });
ok('score is height in the data shelf', parseFloat(dataLook.height) > parseFloat(low.height));

const shelfLook = spineLook({
  rating,
  mode: 'shelf',
  dark: false,
  edition: { key: 'k', publisher: 'Reclam', pageCount: 96, palette: ['#8a3324'] },
  language: 'de',
});
ok('the realistic shelf says so', shelfLook.real);
eq('a Reclam is drawn in Reclam yellow',
  shelfLook.background.toLowerCase().includes('#f2c900'), true);
eq('and carries its imprint', shelfLook.imprint, 'Reclam');
eq('and reads downwards', shelfLook.direction, 'down');
ok('and stands shorter than a novel',
  parseFloat(shelfLook.height) < parseFloat(
    spineLook({
      rating,
      mode: 'shelf',
      dark: false,
      edition: { key: 'k', pageCount: 320 },
    }).height
  ));

/* Asking for the realistic shelf when nothing is known must not produce a
   blank: it falls back to exactly what the data shelf would have drawn. */
const unknown = spineLook({ rating, mode: 'shelf', dark: false });
eq('an unknown book falls back to the mood', unknown.background, dataLook.background);
ok('and is honest about not being real', !unknown.real);

/* A lookup that found nothing still writes a row, so that the app stops
   asking. The shelf must treat that row as "unknown" and not as "a book
   with no publisher" — otherwise every book the catalogues missed comes
   out the same default height in the same colour. */
const foundNothing = spineLook({
  rating, mode: 'shelf', dark: false,
  edition: { key: 'k' },
});
eq('an empty edition row is still unknown', foundNothing.background, dataLook.background);
ok('and does not claim to be real', !foundNothing.real);
eq('and keeps the score as height', foundNothing.height, dataLook.height);

/* A cover but no page count, and a page count but no cover, are both the
   common case — a shelf where those fall back to the old wall would be a
   mess of two styles. */
const colourOnly = spineLook({
  rating, mode: 'shelf', dark: false,
  edition: { key: 'k', palette: ['#8a3324'] },
});
ok('a cover with no page count is still drawn for real', colourOnly.real);
ok('and uses the cover colour', colourOnly.background.includes('#8a3324'));

console.log(fails ? `\n${fails} failing` : '\nall passing');
if (fails) process.exit(1);
