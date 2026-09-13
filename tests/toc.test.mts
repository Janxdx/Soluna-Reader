import { fragmentOf, resolvePath } from '../src/engine/epub/zip.ts';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};

/* ── which file, and which place inside it ─────────────────────────────

   A contents entry is two answers in one string, and they go to different
   places: the path picks the spine document, the fragment picks the
   sub-section within it. `resolvePath` deliberately drops the second — a zip
   has no entry called `ch3.xhtml#part-two` — which is why the fragment has
   to be taken separately rather than recovered from the resolved path. */

eq('a plain chapter has no anchor', fragmentOf('ch3.xhtml'), '');
eq('and the path is resolved against the contents document',
  resolvePath('OEBPS/nav.xhtml', 'ch3.xhtml'), 'OEBPS/ch3.xhtml');

eq('a sub-section carries one', fragmentOf('ch3.xhtml#part-two'), 'part-two');
eq('which the path does not', resolvePath('OEBPS/nav.xhtml', 'ch3.xhtml#part-two'), 'OEBPS/ch3.xhtml');

eq('two sub-sections of one chapter differ only there',
  [fragmentOf('ch3.xhtml#s1'), fragmentOf('ch3.xhtml#s2')], ['s1', 's2']);
eq('and resolve to the same file',
  resolvePath('OEBPS/nav.xhtml', 'ch3.xhtml#s1') === resolvePath('OEBPS/nav.xhtml', 'ch3.xhtml#s2'),
  true);

eq('an anchor in the contents document itself', fragmentOf('#top'), 'top');
eq('percent escapes come back as the id they name', fragmentOf('a.xhtml#teil%20zwei'), 'teil zwei');
eq('a stray percent is not an error', fragmentOf('a.xhtml#100%'), '100%');
eq('a hash with nothing after it is no anchor', fragmentOf('a.xhtml#'), '');
eq('only the first hash starts the anchor', fragmentOf('a.xhtml#a#b'), 'a#b');

/* relative paths, since the contents document is rarely beside the chapters */
eq('up a directory', resolvePath('OEBPS/nav/toc.xhtml', '../text/ch1.xhtml#x'), 'OEBPS/text/ch1.xhtml');
eq('absolute from the zip root', resolvePath('OEBPS/nav.xhtml', '/text/ch1.xhtml#x'), 'text/ch1.xhtml');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
