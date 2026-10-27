import type { ScreenLine } from "./screen";

/*
  Lines read off another app's window (screen.ts), put back together as paragraphs, each with
  its box on the screen: explain.ts counts them, and tells a pick with none to click right on a
  paragraph. The lesson lays the page out itself (the web app's lib/screen/screenBlocks.ts).

  A line joins the paragraph above it when it sits right under it (a gap under about one
  line), overlaps it sideways and is printed at about the same size. A line indented under a
  short last line starts a new paragraph (a book's paragraphs: the Kindle page has no gap
  between them).
*/

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Block {
  id: string;
  /** "h" for a heading (one line, printed larger), "p" for anything else. */
  kind: "h" | "p";
  text: string;
  rect: Rect;
  lines: ScreenLine[];
}

/** The longest block text the API takes (GuideBlock.text is 4,000). */
const BLOCK_MAX_CHARS = 3900;

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const right = (r: Rect): number => r.x + r.w;
const bottom = (r: Rect): number => r.y + r.h;

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y };
}

/** A line's words joined onto the text so far: a word broken at the line's end is mended. */
function joinLine(text: string, line: string): string {
  if (!text) return line;
  if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(line)) return text.slice(0, -1) + line;
  return `${text} ${line}`;
}

interface Building {
  lines: ScreenLine[];
  rect: Rect;
}

/**
 * Pieces of one printed line, put back together. Vision cuts a line where the gap between
 * words is wide (justified text: the Kindle page read 92 pieces for about 40 lines), so
 * pieces that sit on the same row, side by side with no more than a wide word gap between
 * them, are one line. A column's gutter is wider than that, so two columns stay apart.
 */
export function mergeRows(pieces: ScreenLine[]): ScreenLine[] {
  const sorted = [...pieces].sort((a, b) => a.x - b.x);
  const rows: ScreenLine[] = [];
  for (const piece of sorted) {
    const row = rows.find((r) => {
      const overlap = Math.min(bottom(r), bottom(piece)) - Math.max(r.y, piece.y);
      if (overlap < 0.5 * Math.min(r.h, piece.h)) return false;
      if (Math.max(r.h, piece.h) / Math.min(r.h, piece.h) > 1.5) return false;
      const gap = piece.x - right(r);
      return gap > -0.5 * piece.h && gap < 2 * Math.max(r.h, piece.h);
    });
    if (!row) {
      rows.push({ ...piece });
      continue;
    }
    const box = union(row, piece);
    row.t = `${row.t} ${piece.t}`;
    row.c = Math.min(row.c, piece.c);
    row.x = box.x;
    row.y = box.y;
    row.w = box.w;
    row.h = box.h;
  }
  return rows;
}

export function blocksOf(read: ScreenLine[]): Block[] {
  const lines = mergeRows(read.filter((l) => l.c >= 0.3 && /[\p{L}\p{N}]/u.test(l.t) && l.w > 0 && l.h > 0)).sort(
    (a, b) => a.y - b.y || a.x - b.x,
  );
  const lineHeight = median(lines.map((l) => l.h)) || 12;

  const open: Building[] = [];
  for (const line of lines) {
    let home: Building | undefined;
    // The most recent paragraphs first: the one this line continues is just above it.
    for (let i = open.length - 1; i >= Math.max(0, open.length - 8); i--) {
      const b = open[i];
      const last = b.lines[b.lines.length - 1];
      const gap = line.y - bottom(last);
      const tall = Math.max(last.h, line.h);
      if (gap < -0.5 * tall || gap > 0.9 * tall) continue;
      const overlap = Math.min(right(line), right(b.rect)) - Math.max(line.x, b.rect.x);
      if (overlap < 0.3 * Math.min(line.w, b.rect.w)) continue;
      if (Math.max(line.h, last.h) / Math.min(line.h, last.h) > 1.6) continue;
      // A short line centred over a full one is a title over its paragraph, not part of it.
      if (b.lines.length === 1 && last.w < 0.5 * line.w && Math.abs(last.x - line.x) > line.h) {
        const centred = Math.abs(last.x + last.w / 2 - (line.x + line.w / 2)) < 0.1 * line.w;
        if (centred) continue;
      }
      // Indented under a short line: a new paragraph begins here.
      const indented = line.x - b.rect.x > 0.9 * line.h && line.x - b.rect.x < 8 * line.h;
      const shortBefore = right(last) < right(b.rect) - 2 * lineHeight;
      if (indented && shortBefore) continue;
      home = b;
      break;
    }
    if (home) {
      home.lines.push(line);
      home.rect = union(home.rect, line);
    } else {
      open.push({ lines: [line], rect: { x: line.x, y: line.y, w: line.w, h: line.h } });
    }
  }

  return open
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .map((b, i) => {
      const text = b.lines.reduce((t, l) => joinLine(t, l.t.trim()), "").slice(0, BLOCK_MAX_CHARS);
      const heading = b.lines.length === 1 && b.lines[0].h > 1.3 * lineHeight;
      return { id: `b${i + 1}`, kind: heading ? "h" : "p", text, rect: b.rect, lines: b.lines };
    });
}
