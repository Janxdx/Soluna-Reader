/* Breaking the shelf into rows.
 *
 * A wrapping flex container is what the wall used to be, and it cannot fan
 * — nothing knows which row a book lands in until the browser has already
 * laid it out, and a `--ry` fan has to be a property of the row, set before
 * paint. So the rows are broken here instead, in plain arithmetic, and the
 * wall (`SpineWall.tsx`) draws whatever this returns.
 *
 * Framework-free like the rest of `engine/`: spine widths in, rows with
 * positions and angles out, no DOM. That is also what makes it testable —
 * see `tests/shelf.test.mts` — without a browser to lay anything out in.
 */

import type { SpineLook } from './spine';

export interface Placed {
  id: string;
  look: SpineLook;
  /** the spine's own centre, in px from the row's left edge */
  x: number;
  /** the row's own vanishing point, in degrees — see below */
  ry: number;
}

export interface ShelfRow {
  books: Placed[];
  /** the row's actual occupied width — the sum of its spines, not the
      container's. A ragged last row is narrower than the container by
      construction, and the fan below is deliberately measured against
      this rather than that, so a short row fans gently instead of
      splaying every book in it to the full ±30°. */
  width: number;
}

/** How far a spine turns, at the steepest a row ever asks for. Matches the
    reference's own numbers (see SHELF-3D.md §1) closely enough that a row
    of a dozen books reads as one shelf seen from one point, not a dozen
    books each rendered face-on. */
const MAX_RY = 30;

/** The air between two spines, in px. Real books touch, but a row drawn
    with none at all reads as one striped block rather than a line of
    objects — the reference leaves this much, and so does a shelf where a
    few books lean. Counted into a row's width so the fan and the board are
    measured over what the row actually occupies. */
export const SLOT_GAP = 2;

/**
 * Where a book sits across the row decides how far it has turned — the
 * whole trick that makes a fanned shelf read as one photograph rather than
 * a repeated sprite. `t` is the spine's centre remapped to −1…1 across the
 * row, and `ry` grows with `t` raised to a power a little over one: books
 * near the centre stay flatter for longer than a straight ramp would give
 * them, and only the ones nearest either edge reach close to the full turn
 * — which is closer to what a real vanishing point does to a row of
 * objects than a linear sweep is.
 */
function fanAngle(t: number): number {
  const sign = t < 0 ? -1 : 1;
  return MAX_RY * sign * Math.abs(t) ** 1.15;
}

/**
 * Break a shelf's worth of spines into rows that fit `containerWidth`, and
 * fan each row around its own centre.
 *
 * Greedy, left to right: a spine joins the current row if it fits, and
 * starts a new one if it doesn't — except a row is never left empty, so a
 * single spine wider than the container still gets a row of its own rather
 * than vanishing. The last row is whatever is left over, ragged the way a
 * real shelf's last row is, and it is exactly the case the "fan on the
 * row's own width" rule above exists for.
 */
export function breakRows(
  looks: { id: string; look: SpineLook }[],
  containerWidth: number
): ShelfRow[] {
  const width = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : Infinity;

  const rows: { id: string; look: SpineLook }[][] = [];
  let current: { id: string; look: SpineLook }[] = [];
  let currentWidth = 0;

  for (const item of looks) {
    const w = item.look.width;
    const gap = current.length > 0 ? SLOT_GAP : 0;
    if (current.length > 0 && currentWidth + gap + w > width) {
      rows.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push(item);
    currentWidth += (current.length > 1 ? SLOT_GAP : 0) + w;
  }
  if (current.length > 0) rows.push(current);

  return rows.map((row) => {
    const rowWidth =
      row.reduce((sum, item) => sum + item.look.width, 0) + SLOT_GAP * (row.length - 1);
    let x = 0;
    const books: Placed[] = row.map((item) => {
      const centre = x + item.look.width / 2;
      x += item.look.width + SLOT_GAP;
      /* rowWidth is never 0 — a row always holds at least one spine of
         positive width — so this never divides by zero. */
      const t = (2 * centre) / rowWidth - 1;
      return { id: item.id, look: item.look, x: centre, ry: fanAngle(t) };
    });
    return { books, width: rowWidth };
  });
}
