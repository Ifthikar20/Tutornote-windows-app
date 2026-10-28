// The lines a page draws for an answer, found in an accurate read's picture before it is dropped,
// for the tutor on screen to write an exercise's answer and its working on (the founder,
// 2026-10-27: "on the page where there is dash or line asking for a answer. some places asking for
// a answer can look like a long line breaker tab too. so be careful when reading the DOM").
//
// The web app's own rule for a page's canvas (tutornote-web src/lib/write/writePlace.ts rulesIn):
// per row of pixels the longest dark run `minRun` long or more; rows in a row that have one joined
// into a band; the band kept when it is at most `thick` rows thick, as {x0, x1, y}: the run's ends
// and the band's middle. Printed words never make one (their letters break every row), and a
// filled box or a figure is thicker than a line. With the window's scale as TeachMode.tsx
// canvasRules takes a canvas's: minRun in points times the scale, thick max(3, 2.5 x the scale).
// Followed run by run here, for what a window shows around its page (In).
//
// A dotted or dashed line (his "dash or line": dots, dashes, "......", "_ _ _", "- - -") has no run
// that long, and Windows' text reader drops dots and spaced dashes, so on a screen the picture is
// all there is (on a canvas the web finds such a line in the PDF's words: answerLinesIn). Here its
// pieces, with gaps of at most 4 x `thick` between them, are one line when they are at most `thick`
// rows thick with nothing at all over them or under them for 2 x `thick` rows, all along: three
// pieces or more, `minRun` long, a quarter of it ink or more (Dotted). A row of words is never one:
// its letters stand over and under every gap, and an i's dot or an accent has its letter close by.
//
// On a dark page (dark mode: a window whose ground, Diff.Ground, is under half) its lines are
// light: the same is looked for in light as well (Of). So that a dark page's own ground, seen
// between its light letters, is no line, a line here also stands on a ground unlike it: the rows
// just over and under it are at most half ink along it (Apart). A line on a page always is.
//
// Here, unlike a canvas, a run that is a word's own underline or strike is left out (a link's
// underline on a web page is no answer line): one along an OCR line's words, between the line's
// top and 1.6 times its height under it (words with no tall or long letters are boxed as short as
// their x-height, and their underline sits a little under that box). Words that are themselves a
// line ("______", a dot leader the reader read) are not words here: a line set in them is the page's.
//
// One pass over the picture's bytes; nothing of the picture is kept or logged.
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Tutornote.Screen
{
    /** An answer line: from x0 to x1 (x1 the first pixel past it), its middle at y. */
    public sealed class Rule { public double X0, X1, Y; }

    public static class Rules
    {
        /** The shortest line looked for, in points: shorter than the web asks of a line under an
         *  exercise (4 times its size, or 8% of the page), so the page can be stricter, and longer
         *  than any letter's stroke at a reading size. */
        public const double MIN_RUN_PT = 36;
        /** The most lines a read sends (the longest kept): a ruled grid is not a worksheet's lines. */
        public const int MOST = 200;
        /** writePlace.ts rulesIn's dark: luma (0.299, 0.587, 0.114) under 160, here in thousandths. */
        const int DARK_BELOW = 160000;
        /** The same the other way round, for a dark page's light lines: luma over 255 - 160. */
        const int LIGHT_ABOVE = 95000;
        /** A window whose ground (Diff.Ground, 0 black to 1 white) is under this is a dark page. */
        public const double DARK_GROUND = 0.5;
        /** A dotted or dashed line: three pieces or more, and at least this much of its length ink
         *  (a typed dot leader's dots, past their soft edges, are a quarter to a half of it; a
         *  sparse row of specks is not a line). */
        const int DOTTED_PIECES = 3, DOTTED_INK_PERCENT = 25;
        /** How far under an OCR line's top a word's own underline can sit, in the line's heights. */
        const double UNDER_WORDS = 1.6;

        /** The marks a page sets an answer's line with in its words (writePlace.ts LINE_MARKS). */
        static readonly Regex LineMarks = new Regex("_{3,}|\\.{4,}|\u2026{2,}|[-\u2010\u2011\u2012\u2013\u2014\u2015]{4,}");

        /** The window's scale (1 at 96 dpi) as the shortest run and the thickest band, in pixels. */
        public static int MinRunAt(double scale) { return Math.Max(1, (int)Math.Floor(MIN_RUN_PT * scale + 0.5)); }
        public static int ThickAt(double scale) { return Math.Max(3, (int)Math.Floor(2.5 * scale + 0.5)); }

        /** A band being followed down: its ends so far, its first and last rows, the run its row above
         *  had (what this row's runs are matched with) and the runs it has in this row. */
        sealed class Band { public int X0, X1, Top, Last, AboveX0, AboveX1, HereX0, HereX1; public bool Gone; }

        /** Whether the pixel at byte `i` of a picture is ink: dark, or on a dark page (`light`) light. */
        static bool Ink(byte[] px, int i, bool light)
        {
            int luma = 299 * px[i + 2] + 587 * px[i + 1] + 114 * px[i];
            return light ? luma > LIGHT_ABOVE : luma < DARK_BELOW;
        }

        /**
         * writePlace.ts rulesIn on a picture (top-down BGRA), in its own pixels, top to bottom; with
         * `light`, a dark page's light lines. Four things differ from a canvas's, all for what a
         * window shows around its page and in it:
         *  - every long run of a row is followed down, not only its longest, and a band is the runs of
         *    rows in a row that lie over one another: a row also crosses the app's own dark parts
         *    (Chrome's grey around a PDF, a dark sidebar), which make tall bands of their own, so a
         *    page's line beside them is still a line;
         *  - a window's picture is opaque: GDI leaves its alpha byte 0, so the alpha a canvas is tested
         *    by is not looked at;
         *  - a band is a line only on a ground unlike it (Apart), for a dark page's ground;
         *  - dotted and dashed lines are found too (Dotted), where a solid line is not already.
         */
        public static List<Rule> In(Picture p, int minRun, int thick, bool light = false)
        {
            var out_ = new List<Rule>();
            if (p == null || p.W <= 0 || p.H <= 0 || p.Bgra == null || p.Bgra.Length < p.W * p.H * 4 || minRun <= 0) return out_;
            int w = p.W, h = p.H, gap = 4 * Math.Max(1, thick);
            byte[] px = p.Bgra;
            var open = new List<Band>();
            var next = new List<Band>();
            var dotted = new List<Rule>();
            // (the row above's ink and this row's, column by column, for Dotted)
            bool[] above = new bool[w], here = new bool[w];
            for (int y = 0; y <= h; y++)
            {
                next.Clear();
                if (y < h)
                {
                    // (c0 to c1: this row's pieces of ink so far with gaps of `gap` or less between them)
                    int at = -1, c0 = -1, c1 = -1, i = y * w * 4;
                    for (int x = 0; x <= w; x++, i += 4)
                    {
                        bool on = x < w && Ink(px, i, light);
                        if (x < w) here[x] = on;
                        if (on) { if (at < 0) at = x; continue; }
                        if (at < 0) continue;
                        if (x - at >= minRun) Follow(open, next, at, x, y);
                        if (c0 >= 0 && at - c1 > gap)
                        {
                            if (c1 - c0 >= minRun) Dotted(px, w, h, y, c0, c1, above, here, light, minRun, thick, dotted);
                            c0 = -1;
                        }
                        if (c0 < 0) c0 = at;
                        c1 = x;
                        at = -1;
                    }
                    if (c0 >= 0 && c1 - c0 >= minRun) Dotted(px, w, h, y, c0, c1, above, here, light, minRun, thick, dotted);
                }
                // (a band no run of this row lies under is over: a line when it is thin enough, on a
                // ground unlike it)
                foreach (Band b in open)
                    if (!b.Gone && b.Last == y - 1 && b.Last - b.Top + 1 <= thick
                        && Apart(px, w, h, b.Top - 1, b.X0, b.X1, light) && Apart(px, w, h, b.Last + 1, b.X0, b.X1, light))
                        out_.Add(new Rule { X0 = b.X0, X1 = b.X1, Y = (b.Top + b.Last) / 2.0 });
                open.Clear();
                foreach (Band b in next) { b.AboveX0 = b.HereX0; b.AboveX1 = b.HereX1; open.Add(b); }
                bool[] was = above; above = here; here = was;
            }
            // (a dotted line where a solid one already is, an underscore leader's own, is that one)
            int solid = out_.Count;
            foreach (Rule d in dotted)
            {
                bool same = false;
                for (int k = 0; k < solid && !same; k++)
                {
                    Rule s = out_[k];
                    same = Math.Abs(s.Y - d.Y) <= thick && Math.Min(s.X1, d.X1) - Math.Max(s.X0, d.X0) > (d.X1 - d.X0) / 2;
                }
                if (!same) out_.Add(d);
            }
            out_.Sort(delegate (Rule a, Rule b) { return a.Y != b.Y ? a.Y.CompareTo(b.Y) : a.X0.CompareTo(b.X0); });
            return out_;
        }

        /** Whether row `y` (none, outside the picture) is at most half ink from x0 to x1: the ground
         *  a line stands on, not more of what it is drawn in (a dark page's ground between its letters). */
        static bool Apart(byte[] px, int w, int h, int y, int x0, int x1, bool light)
        {
            if (y < 0 || y >= h || x1 <= x0) return true;
            int ink = 0;
            for (int x = x0, i = (y * w + x0) * 4; x < x1; x++, i += 4) if (Ink(px, i, light)) ink++;
            return 2 * ink <= x1 - x0;
        }

        /** A run of row `y` (x0 to x1): the band whose run above it lies over goes on with it (bands it
         *  lies under together become one), or it starts a band. */
        static void Follow(List<Band> open, List<Band> next, int x0, int x1, int y)
        {
            Band joined = null;
            foreach (Band b in open)
            {
                if (b.Gone || b.AboveX1 <= x0 || b.AboveX0 >= x1) continue;
                if (joined == null) { joined = b; continue; }
                // (one more band above it: taken into the first, with its run above, so a later run
                // of this row under that one goes on with the band too, and is no piece of its own)
                joined.Top = Math.Min(joined.Top, b.Top);
                joined.X0 = Math.Min(joined.X0, b.X0);
                joined.X1 = Math.Max(joined.X1, b.X1);
                joined.AboveX0 = Math.Min(joined.AboveX0, b.AboveX0);
                joined.AboveX1 = Math.Max(joined.AboveX1, b.AboveX1);
                if (b.Last == y)
                {
                    if (joined.Last == y) { joined.HereX0 = Math.Min(joined.HereX0, b.HereX0); joined.HereX1 = Math.Max(joined.HereX1, b.HereX1); }
                    else { joined.HereX0 = b.HereX0; joined.HereX1 = b.HereX1; joined.Last = y; }
                }
                b.Gone = true;
                next.Remove(b);
            }
            if (joined == null) joined = new Band { Top = y, Last = y, X0 = x0, X1 = x1, HereX0 = x0, HereX1 = x1 };
            else if (joined.Last == y) { joined.HereX0 = Math.Min(joined.HereX0, x0); joined.HereX1 = Math.Max(joined.HereX1, x1); }
            else { joined.HereX0 = x0; joined.HereX1 = x1; joined.Last = y; }
            joined.X0 = Math.Min(joined.X0, x0);
            joined.X1 = Math.Max(joined.X1, x1);
            if (!next.Contains(joined)) next.Add(joined);
        }

        /**
         * Row `y`'s pieces of ink from c0 to c1 (gaps of 4 x `thick` or less between them) as dotted or
         * dashed lines whose top row is this one: each stretch of them with no ink over it in the row
         * above (`above`; a word before a leader stands over its own letters, and is left out), the
         * rest in Stretch.
         */
        static void Dotted(byte[] px, int w, int h, int y, int c0, int c1, bool[] above, bool[] here, bool light, int minRun, int thick, List<Rule> found)
        {
            int s0 = -1, s1 = -1;
            for (int x = c0; x <= c1; x++)
            {
                if (x < c1 && !above[x])
                {
                    if (here[x]) { if (s0 < 0) s0 = x; s1 = x + 1; }
                    continue;
                }
                if (s0 >= 0 && s1 - s0 >= minRun) Stretch(px, w, h, y, s0, s1, light, minRun, thick, found);
                s0 = -1;
            }
        }

        /**
         * A stretch of row `y` (s0 to s1, ink at both ends, none over it) as dotted or dashed lines, or
         * not: its columns whose ink from this row down ends within `thick` rows, with nothing over it
         * or under it for 2 x `thick` rows (an i's dot, an accent or a colon's has its letter a row or
         * two away; a letter's edge has the rest of it), side by side; each run of them a line when
         * it is `minRun` long or more, three pieces or more, and a quarter of it ink or more.
         */
        static void Stretch(byte[] px, int w, int h, int y, int s0, int s1, bool light, int minRun, int thick, List<Rule> found)
        {
            int margin = 2 * thick, x0 = -1, last = -1, bottom = y, ink = 0, pieces = 0;
            for (int x = s0; x <= s1; x++)
            {
                int under = x < s1 ? Alone(px, w, h, x, y, light, thick, margin) : -1;
                if (under < 0)
                {
                    int length = last + 1 - x0;
                    if (x0 >= 0 && length >= minRun && pieces >= DOTTED_PIECES && ink * 100 >= DOTTED_INK_PERCENT * length)
                        found.Add(new Rule { X0 = x0, X1 = last + 1, Y = (y + bottom - 1) / 2.0 });
                    x0 = -1;
                    continue;
                }
                // (a column with no ink is a gap in the line, if the line goes on past it)
                if (under == y) continue;
                if (x0 < 0) { x0 = x; ink = 0; pieces = 0; bottom = y; }
                if (last != x - 1 || x0 == x) pieces++;
                ink++;
                last = x;
                bottom = Math.Max(bottom, under);
            }
        }

        /**
         * Column `x` from row `y` down: the row its ink there ends on (y when it has none) when that is
         * `thick` rows or less and the `margin` rows over it and under it have none, or -1. (Row y - 1
         * is known to have none.)
         */
        static int Alone(byte[] px, int w, int h, int x, int y, bool light, int thick, int margin)
        {
            for (int r = Math.Max(0, y - margin); r < y - 1; r++) if (Ink(px, (r * w + x) * 4, light)) return -1;
            int under = y;
            for (int r = y; r < h && r < under + margin; r++)
            {
                if (!Ink(px, (r * w + x) * 4, light)) continue;
                if (r - y + 1 > thick) return -1;
                under = r + 1;
            }
            return under;
        }

        /** Whether a line (screen pixels) is a word's own underline or strike in one of the read's lines. */
        public static bool UnderWords(Rule r, List<OcrLine> lines)
        {
            if (lines == null) return false;
            foreach (OcrLine l in lines)
            {
                if (!(l.H > 0) || r.Y < l.Y || r.Y > l.Y + l.H * UNDER_WORDS) continue;
                // (the line's words, its own answer lines aside: the span a word's underline can take)
                double s0 = double.MaxValue, s1 = double.MinValue;
                foreach (OcrWord word in l.Words)
                {
                    if (word.T != null && LineMarks.IsMatch(word.T)) continue;
                    s0 = Math.Min(s0, word.X);
                    s1 = Math.Max(s1, word.X + word.W);
                }
                if (l.Words.Count == 0) { s0 = l.X; s1 = l.X + l.W; }
                if (s1 <= s0) continue;
                // (an underline runs a little past its words' ink, never a long way)
                double slack = Math.Max(2, 0.5 * l.H);
                if (r.X0 >= s0 - slack && r.X1 <= s1 + slack) return true;
            }
            return false;
        }

        /**
         * The answer lines of a window's picture whose top left is at `left`, `top` on the screen, in
         * screen pixels, for a window at `scale` whose ground (Diff.Ground) is `ground`: on a dark page
         * its light lines as well as its dark ones; none of them a word's own underline or strike in
         * `lines` (the read's, in screen pixels); the MOST longest, top to bottom.
         */
        public static List<Rule> Of(Picture pic, int left, int top, double scale, List<OcrLine> lines, double ground = 1)
        {
            var found = new List<Rule>();
            if (pic == null) return found;
            if (!(scale > 0) || double.IsInfinity(scale)) scale = 1;
            int minRun = MinRunAt(scale), thick = ThickAt(scale);
            List<Rule> all = In(pic, minRun, thick);
            if (ground < DARK_GROUND) all.AddRange(In(pic, minRun, thick, true));
            foreach (Rule r in all)
            {
                var on = new Rule { X0 = left + r.X0, X1 = left + r.X1, Y = top + r.Y };
                if (!UnderWords(on, lines)) found.Add(on);
            }
            if (found.Count > MOST)
            {
                found.Sort(delegate (Rule a, Rule b) { return (b.X1 - b.X0).CompareTo(a.X1 - a.X0); });
                found.RemoveRange(MOST, found.Count - MOST);
            }
            found.Sort(delegate (Rule a, Rule b) { return a.Y != b.Y ? a.Y.CompareTo(b.Y) : a.X0.CompareTo(b.X0); });
            return found;
        }
    }
}
