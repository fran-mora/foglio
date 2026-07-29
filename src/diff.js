// Line diff between what is on disk and what is about to be written, so the
// "Foglio does not reformat your file" claim is something you can watch rather
// than take on trust.
//
// Plain longest-common-subsequence over lines. Documents here are one file a
// person is editing, so the quadratic table is fine, but it is capped anyway
// to keep a pathological file from freezing the window.

const MAX_LINES = 4000;

// Longest common subsequence lengths, as a rolling two-row table.
function lcsTable(a, b) {
  const rows = [];
  let prev = new Uint32Array(b.length + 1);
  rows.push(prev);
  for (let i = 0; i < a.length; i++) {
    const cur = new Uint32Array(b.length + 1);
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(cur[j], prev[j + 1]);
    }
    rows.push(cur);
    prev = cur;
  }
  return rows;
}

// Returns [{ type: "same" | "add" | "remove", line, text }].
// `line` is the 1-based line number in whichever side the row belongs to.
export function diffLines(before, after) {
  const a = String(before).split("\n");
  const b = String(after).split("\n");

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [{ type: "truncated", line: 0, text: `file too large to diff (${Math.max(a.length, b.length)} lines)` }];
  }

  const table = lcsTable(a, b);
  const out = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push({ type: "same", line: i, text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      out.push({ type: "add", line: j, text: b[j - 1] });
      j--;
    } else {
      out.push({ type: "remove", line: i, text: a[i - 1] });
      i--;
    }
  }
  return out.reverse();
}

// Just the changed rows, with a little surrounding context, which is what a
// person actually wants to look at before pressing save.
export function changedHunks(before, after, context = 1) {
  const rows = diffLines(before, after);
  if (rows.length === 1 && rows[0].type === "truncated") return rows;

  const keep = new Set();
  rows.forEach((r, idx) => {
    if (r.type === "same") return;
    for (let k = idx - context; k <= idx + context; k++) {
      if (k >= 0 && k < rows.length) keep.add(k);
    }
  });
  return rows.filter((_, idx) => keep.has(idx));
}

export function diffStats(before, after) {
  const rows = diffLines(before, after);
  if (rows.length === 1 && rows[0].type === "truncated") {
    return { added: 0, removed: 0, truncated: true };
  }
  return {
    added: rows.filter((r) => r.type === "add").length,
    removed: rows.filter((r) => r.type === "remove").length,
    truncated: false,
  };
}

// Whitespace-only differences are the ones an editor introduces without being
// asked, so they are worth calling out separately from edits you made.
export function isWhitespaceOnlyChange(before, after) {
  if (before === after) return false;
  return before.replace(/[ \t]+/g, "") === after.replace(/[ \t]+/g, "");
}
