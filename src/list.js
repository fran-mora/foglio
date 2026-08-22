// Tab and ⇧Tab inside a list. Like format.js, this works out the edits and
// hands them back as data, so the awkward cases — the first item of a list,
// a selection spanning two levels, a paragraph that is not a list at all —
// are unit tested without an editor.
//
// Only leading spaces are ever added or removed. Markers are left alone, and
// an ordered list is never renumbered: CommonMark reads the first number as
// the list's start, and rewriting the others would edit lines the user never
// touched.
//
// `doc` is anything with CodeMirror's line accessors — `lineAt(pos)` and
// `line(n)` returning `{from, to, text, number}` — which the editor satisfies
// directly and the tests fake in three lines.

// A list line: leading spaces, a bullet or a number, then at least one space.
// Spaces only, deliberately. Markdown measures a tab as a jump to the next
// four-column stop, so mixing them into an indent this code inserts as spaces
// would move lines it was not asked to touch. A tab-indented list simply does
// not respond, and Tab keeps its usual meaning there.
const LIST_LINE = /^( *)([-*+]|\d{1,9}[.)])( +)/;

export function listLine(text) {
  const m = LIST_LINE.exec(text);
  if (!m) return null;
  return {
    indent: m[1].length,
    marker: m[2],
    // Where the item's own content starts, which is the column a child list
    // has to reach to count as nested rather than as a sibling.
    contentCol: m[0].length,
  };
}

function leadingSpaces(text) {
  return /^ */.exec(text)[0].length;
}

// Every line the selection touches that is a list item. A selection that ends
// exactly at the start of a line has not really reached it, so that line is
// left out — otherwise selecting one item by dragging down a line indents two.
function listLinesIn(doc, from, to) {
  const first = doc.lineAt(from).number;
  let last = doc.lineAt(to).number;
  if (last > first && doc.line(last).from === to) last--;
  const lines = [];
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    if (listLine(line.text)) lines.push(line);
  }
  return lines;
}

// How far the item on `line` has to move right to become a child of the item
// above it. That is the previous *sibling* — the nearest item at the same
// indent — because a list nests under the item before it, never under itself.
function indentDelta(doc, line) {
  const info = listLine(line.text);
  for (let n = line.number - 1; n >= 1; n--) {
    const prev = doc.line(n);
    if (!prev.text.trim()) continue; // a blank line may sit inside a list
    const p = listLine(prev.text);
    if (!p) {
      // Ordinary text at or left of us ends the list; anything further right
      // is a wrapped continuation of a deeper item and can be stepped over.
      if (leadingSpaces(prev.text) <= info.indent) return 0;
      continue;
    }
    if (p.indent === info.indent) return p.contentCol - p.indent;
    // Only a shallower item above us means we are already its first child,
    // and a first child has nothing to nest under.
    if (p.indent < info.indent) return 0;
  }
  return 0; // first item of the first list in the document
}

// The mirror of indentDelta: back out to the level of the nearest item above
// us that is shallower, so ⇧Tab undoes exactly what Tab did.
function outdentDelta(doc, line) {
  const info = listLine(line.text);
  if (info.indent === 0) return 0;
  for (let n = line.number - 1; n >= 1; n--) {
    const prev = doc.line(n);
    if (!prev.text.trim()) continue;
    const p = listLine(prev.text);
    if (!p) {
      if (leadingSpaces(prev.text) <= info.indent) break;
      continue;
    }
    if (p.indent < info.indent) return info.indent - p.indent;
  }
  return info.indent; // indented with nothing above it: take it back to the margin
}

// One delta for the whole selection, taken from its first list line. Shifting
// every line by the same amount keeps the shape of a nested block: computing
// each line's own delta would flatten a parent and its children together.
function shift(doc, from, to, deltaFor, clamp) {
  const targets = listLinesIn(doc, from, to);
  // No list line at all: the caller should let Tab keep its usual meaning.
  if (!targets.length) return null;
  let delta = deltaFor(doc, targets[0]);
  if (clamp) {
    for (const line of targets) delta = Math.min(delta, listLine(line.text).indent);
  }
  return { delta, targets };
}

// Tab. Returns null when there is nothing list-like in the selection, and an
// empty change list when the item cannot go any deeper — the key is still
// swallowed there, so Tab in a list never moves focus out of the editor.
export function indentList(doc, from, to) {
  const s = shift(doc, from, to, indentDelta, false);
  if (!s) return null;
  if (!s.delta) return { changes: [] };
  return {
    changes: s.targets.map((line) => ({
      from: line.from,
      to: line.from,
      insert: " ".repeat(s.delta),
    })),
  };
}

// ⇧Tab.
export function outdentList(doc, from, to) {
  const s = shift(doc, from, to, outdentDelta, true);
  if (!s) return null;
  if (!s.delta) return { changes: [] };
  return {
    changes: s.targets.map((line) => ({
      from: line.from,
      to: line.from + s.delta,
    })),
  };
}
