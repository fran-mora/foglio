// The emphasis shortcuts: ⌘B and friends. These work out which edits to make
// and hand them back as plain data, so the awkward cases — a selection that
// ends in a space, a word that is already bold, a bare caret — are unit tested
// without a DOM or an editor.
//
// Only the markers are ever inserted or removed. Nothing here rewrites a line,
// so a document keeps every byte the shortcuts did not deliberately touch.
//
// `doc` is anything with `length` and `slice(from, to)`: a plain string in the
// tests, a thin window over CodeMirror's Text in the editor, which keeps ⌘B in
// a large file from copying the whole document to add two stars.

// What counts as a word when a shortcut is pressed with nothing selected.
// Letters and digits of any script, so it behaves the same in Greek as in
// English. \p{…} needs the /u flag; WebKit has had both since Safari 11, well
// below the macOS 11 floor.
const WORD = /[\p{L}\p{N}_]/u;

function isSpace(doc, pos) {
  return /\s/.test(doc.slice(pos, pos + 1));
}

// Length of the unbroken run of `ch` ending at `pos` / starting at `pos`.
function runBefore(doc, pos, ch) {
  let n = 0;
  while (pos - n > 0 && doc.slice(pos - n - 1, pos - n) === ch) n++;
  return n;
}

function runAfter(doc, pos, ch) {
  let n = 0;
  while (pos + n < doc.length && doc.slice(pos + n, pos + n + 1) === ch) n++;
  return n;
}

// Given a delimiter run of `run` on each side, is `marker` already one of the
// things wrapped around the text? A run of stars is shared between two
// constructs — `***x***` is bold *and* italic — so italic asks for an odd run
// and takes `***x***` back to `**x**` instead of adding a fourth star, while
// bold only needs two of them to be there.
function isWrapped(run, marker) {
  if (marker === "*" || marker === "_") return run % 2 === 1;
  return run >= marker.length;
}

function wordAt(doc, pos) {
  let from = pos;
  let to = pos;
  while (from > 0 && WORD.test(doc.slice(from - 1, from))) from--;
  while (to < doc.length && WORD.test(doc.slice(to, to + 1))) to++;
  return from === to ? null : { from, to };
}

// Trims a selection down to the text worth wrapping, and steps inside markers
// the selection already carries so that both ways of selecting `**bold**` —
// with the stars and without them — end up at the same place.
function narrow(doc, from, to, marker) {
  // A double-click usually takes the trailing space with it, and `**bold **`
  // renders as literal stars: emphasis may not close against whitespace. Keep
  // the spaces outside the markers.
  while (from < to && isSpace(doc, from)) from++;
  while (to > from && isSpace(doc, to - 1)) to--;

  const len = marker.length;
  if (
    len > 0 &&
    to - from >= 2 * len &&
    doc.slice(from, from + len) === marker &&
    doc.slice(to - len, to) === marker
  ) {
    return { from: from + len, to: to - len };
  }
  return { from, to };
}

// Adds `marker` around the selection, or takes it away if it is already there.
// Returns the changes to apply and where the selection should land, which is
// always the same text it started on — so ⌘B ⌘I stacks, and a second ⌘B is an
// undo of the first.
export function toggleWrap(doc, from, to, marker) {
  const len = marker.length;
  const ch = marker[0];
  ({ from, to } = narrow(doc, from, to, marker));

  if (from === to) {
    // Nothing selected: take the word the caret is sitting in. With no word
    // to take — at the end of a line, or in open space — open an empty pair
    // and leave the caret between the markers, ready to type into.
    const word = wordAt(doc, from);
    if (!word) {
      return {
        changes: [{ from, to, insert: marker + marker }],
        anchor: from + len,
        head: from + len,
      };
    }
    ({ from, to } = word);
  }

  const run = Math.min(runBefore(doc, from, ch), runAfter(doc, to, ch));
  if (isWrapped(run, marker)) {
    return {
      changes: [
        { from: from - len, to: from },
        { from: to, to: to + len },
      ],
      anchor: from - len,
      head: to - len,
    };
  }

  return {
    changes: [
      { from, to: from, insert: marker },
      { from: to, to, insert: marker },
    ],
    anchor: from + len,
    head: to + len,
  };
}

// A link with no spaces in the target, which is the shape this can undo again.
const LINK = /^\[([^\]]*)\]\(([^()\s]*)\)$/;
const URLISH = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

// ⌘K. Wraps the selection as a link and puts the caret wherever the typing has
// to go next: in the target for ordinary text, in the label when the selection
// was itself a URL. On a selection that is already a link, unwraps it.
export function toggleLink(doc, from, to) {
  ({ from, to } = narrow(doc, from, to, ""));
  const selected = doc.slice(from, to);

  const link = LINK.exec(selected);
  if (link) {
    return {
      changes: [{ from, to, insert: link[1] }],
      anchor: from,
      head: from + link[1].length,
    };
  }

  if (URLISH.test(selected)) {
    const insert = `[](${selected})`;
    return {
      changes: [{ from, to, insert }],
      anchor: from + 1,
      head: from + 1,
    };
  }

  const insert = `[${selected}]()`;
  // Caret in the label when there is nothing to label yet, otherwise between
  // the parens where the URL belongs.
  const caret = selected ? from + selected.length + 3 : from + 1;
  return { changes: [{ from, to, insert }], anchor: caret, head: caret };
}
