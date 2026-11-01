// What else the page draws (the Mac's main.swift "What else the page draws"): a read a lesson teaches
// from also says where the page's paper is and what else is drawn on it besides the words read, so
// the lesson can write on a page in another app as it does on the web's own reader (the founder,
// 2026-10-28: "the part where we write on the PDF documents"): the paper (a PDF page inside Edge's
// grey viewer), and a coarse grid of where else it is drawn on (a figure, a drawn box, a hand's
// working), the words' own boxes left out. The lines drawn across it are Rules.cs's. All of it from
// the picture already taken. Numbers go back, never a pixel; the picture is dropped with the rest
// once read, and none of it is logged.
//
// Every test is by the distance from the paper's own grey, the commonest one inside the lines read
// (between their letters): a dark page (a night theme) has a dark paper, and light marks on it count
// as dark ones do on a white page. The Mac's numbers, in points; here the picture is in physical
// pixels, so each is scaled by the window's scale.
using System;
using System.Collections.Generic;

namespace Tutornote.Screen
{
    /** Where else the page is drawn on: Cols x Rows cells of Cell pixels from (X, Y) on the screen, row
     *  by row, a bit each (cell i = r * Cols + c is set when Bits[i >> 3] has bit i & 7). */
    public sealed class InkGrid
    {
        public int X, Y, Cell, Cols, Rows;
        public byte[] Bits;

        public bool Inked(int col, int row)
        {
            if (col < 0 || col >= Cols || row < 0 || row >= Rows) return false;
            int i = row * Cols + col;
            return (Bits[i >> 3] & (1 << (i & 7))) != 0;
        }
    }

    /** A box in pixels of the picture, or of the screen. */
    public struct Span
    {
        public int From, To;
        public Span(int from, int to) { From = from; To = to; }
        public int Count { get { return To - From; } }
    }

    /** What an accurate read says of its page besides the words, in screen pixels: the paper (HasPaper
     *  false when it fills the window or cannot be told), and the ink grid over the paper (over the
     *  window with no paper). */
    public sealed class PageGeometry
    {
        public bool HasPaper;
        public int PaperX, PaperY, PaperW, PaperH;
        public InkGrid Ink;
    }

    public static class Geometry
    {
        /** The paper's grey is the commonest (within four shades) inside the lines read only when it is
         *  at least this share of them: else the words sit on no one ground (a photograph), and nothing
         *  of the page is sent. */
        const double PAPER_PEAK = 0.3;
        /** A grey this near the paper's (0 to 255) is the paper, when telling it from the viewer around it. */
        const int PAPER_NEAR = 12;
        /** A line sits on the paper when this share of its box is the paper. */
        const double PAPER_SITS = 0.5;
        /** A column or a row with fewer of its pixels paper than this is past the paper's edge. */
        const double PAPER_EDGE_SHARE = 0.08;
        /** A grey this far from the paper's is drawn on (a tinted panel or a pale highlight is not). */
        const int MARK_FAR = 48;
        /** The words' boxes, this much bigger (points), are left out of the ink. */
        const double WORD_PAD = 2;
        /** The ink grid's cells are INK_CELL points square, INK_CELLS_MOST at most each way; a cell with
         *  more than INK_SHARE of its pixels marked is drawn on (the web's own INK_SHARE). */
        public const int INK_CELL = 8;
        public const int INK_CELLS_MOST = 400;
        const double INK_SHARE = 0.02;
        /** A window's rounded corners (points), which a picture of it may leave dark: they are paper. */
        const double CORNER = 8;

        /** Whether a text has a letter or a digit: the words the page keeps. */
        public static bool HasLetterOrDigit(string text)
        {
            if (text == null) return false;
            foreach (char c in text) if (char.IsLetterOrDigit(c)) return true;
            return false;
        }

        static List<Span> TrueRuns(bool[] flags)
        {
            var runs = new List<Span>();
            int start = -1;
            for (int i = 0; i < flags.Length; i++)
            {
                if (flags[i] && start < 0) start = i;
                if (!flags[i] && start >= 0) { runs.Add(new Span(start, i)); start = -1; }
            }
            if (start >= 0) runs.Add(new Span(start, flags.Length));
            return runs;
        }

        static int Overlap(Span a, Span b) { return Math.Max(0, Math.Min(a.To, b.To) - Math.Max(a.From, b.From)); }

        sealed class Box { public Span X, Y; }

        /** A box in screen pixels as the pixels of a picture whose top left is (left, top), clipped to it. */
        static Box PixelsOf(double x, double y, double w, double h, int left, int top, int width, int height)
        {
            int x0 = Math.Min(Math.Max((int)Math.Floor(x - left), 0), width);
            int x1 = Math.Min(Math.Max((int)Math.Ceiling(x + w - left), x0), width);
            int y0 = Math.Min(Math.Max((int)Math.Floor(y - top), 0), height);
            int y1 = Math.Min(Math.Max((int)Math.Ceiling(y + h - top), y0), height);
            return new Box { X = new Span(x0, x1), Y = new Span(y0, y1) };
        }

        /** Of `runs`, the one with most of the sitting lines in it, if any has some. */
        static bool Heaviest(List<Span> runs, Func<Span, long> weight, out Span best)
        {
            best = new Span();
            long most = 0;
            bool found = false;
            foreach (Span run in runs)
            {
                long w = weight(run);
                if (w > most) { most = w; best = run; found = true; }
            }
            return found;
        }

        /**
         * The page in `pic`, a picture of a window whose top left is at (left, top) on the screen, at
         * `scale` (pixels a point), with `lines` read from it (in screen pixels): its paper and its ink,
         * or null when its paper's grey cannot be told.
         */
        public static PageGeometry Of(Picture pic, int left, int top, double scale, List<OcrLine> lines)
        {
            if (pic == null || pic.W <= 0 || pic.H <= 0 || pic.Bgra == null || pic.Bgra.Length < pic.W * pic.H * 4) return null;
            if (!(scale > 0) || double.IsInfinity(scale)) scale = 1;
            int width = pic.W, height = pic.H;
            byte[] grey = Capture.Grey(pic).G;

            // The paper's grey: the commonest inside the lines the page keeps.
            var kept = new List<OcrLine>();
            if (lines != null) foreach (OcrLine l in lines) if (HasLetterOrDigit(l.T)) kept.Add(l);
            var counts = new long[256];
            foreach (OcrLine l in kept)
            {
                Box b = PixelsOf(l.X, l.Y, l.W, l.H, left, top, width, height);
                for (int y = b.Y.From; y < b.Y.To; y++) for (int x = b.X.From; x < b.X.To; x++) counts[grey[y * width + x]]++;
            }
            long total = 0;
            foreach (long c in counts) total += c;
            if (total == 0) return null;
            int peak = 0;
            long peakCount = -1;
            for (int v = 0; v < 256; v++)
            {
                long around = 0;
                for (int k = Math.Max(0, v - 4); k <= Math.Min(255, v + 4); k++) around += counts[k];
                if (around > peakCount) { peak = v; peakCount = around; }
            }
            if (peakCount < PAPER_PEAK * total) return null;
            long weighted = 0;
            for (int v = Math.Max(0, peak - 4); v <= Math.Min(255, peak + 4); v++) weighted += v * counts[v];
            int paperGrey = (int)Math.Round((double)weighted / Math.Max(peakCount, 1));
            byte paperByte = (byte)paperGrey;
            Func<byte, bool> isPaper = v => Math.Abs(v - paperGrey) <= PAPER_NEAR;
            Func<byte, bool> isMarked = v => Math.Abs(v - paperGrey) > MARK_FAR;

            // (a window's rounded corners: paper, not marks in the corners of a page that fills it)
            int corner = (int)Math.Round(CORNER * scale);
            for (int dy = 0; dy < corner && dy < height; dy++)
                for (int dx = 0; dx < corner && dx < width; dx++)
                {
                    int ox = corner - dx, oy = corner - dy;
                    if (ox * ox + oy * oy <= corner * corner) continue;
                    grey[dy * width + dx] = paperByte;
                    grey[dy * width + (width - 1 - dx)] = paperByte;
                    grey[(height - 1 - dy) * width + dx] = paperByte;
                    grey[(height - 1 - dy) * width + (width - 1 - dx)] = paperByte;
                }

            // The paper: the columns that are paper over the rows of the lines sitting on it, then the
            // rows that are paper over those columns, each the run with most of those lines in it (a
            // page beside or under the next, in a viewer that shows two); then the columns again over
            // the paper's own rows, and its rows over those, until it holds (three goes at most). Over
            // the rows from a viewer's bars to the page's last line, a bar as light as the paper (a
            // browser's white tab strip over its dark PDF viewer) can make a column of the dark viewer
            // beside the page count as paper; over the page's own rows it does not. Told only when one
            // of its edges is inside the window: a page that fills it shows none of them.
            var sitting = new List<Box>();
            foreach (OcrLine l in kept)
            {
                Box b = PixelsOf(l.X, l.Y, l.W, l.H, left, top, width, height);
                if (b.X.Count * b.Y.Count <= 0) continue;
                long on = 0;
                for (int y = b.Y.From; y < b.Y.To; y++) for (int x = b.X.From; x < b.X.To; x++) if (isPaper(grey[y * width + x])) on++;
                if (on >= PAPER_SITS * b.X.Count * b.Y.Count) sitting.Add(b);
            }
            bool told = false;
            Span paperX = new Span(), paperY = new Span();
            if (sitting.Count > 0)
            {
                int bandTop = int.MaxValue, bandBottom = int.MinValue;
                foreach (Box b in sitting) { bandTop = Math.Min(bandTop, b.Y.From); bandBottom = Math.Max(bandBottom, b.Y.To); }
                if (bandBottom > bandTop)
                {
                    var band = new Span(bandTop, bandBottom);
                    for (int go = 0; go < 3; go++)
                    {
                        var colPaper = new int[width];
                        for (int y = band.From; y < band.To; y++) for (int x = 0; x < width; x++) if (isPaper(grey[y * width + x])) colPaper[x]++;
                        var colFlags = new bool[width];
                        for (int x = 0; x < width; x++) colFlags[x] = colPaper[x] >= PAPER_EDGE_SHARE * band.Count;
                        Span overBand = band;
                        Span across;
                        if (!Heaviest(TrueRuns(colFlags), run => { long w = 0; foreach (Box b in sitting) w += (long)Overlap(b.X, run) * Overlap(b.Y, overBand); return w; }, out across)) break;
                        var rowPaper = new int[height];
                        for (int y = 0; y < height; y++) for (int x = across.From; x < across.To; x++) if (isPaper(grey[y * width + x])) rowPaper[y]++;
                        var rowFlags = new bool[height];
                        for (int y = 0; y < height; y++) rowFlags[y] = rowPaper[y] >= PAPER_EDGE_SHARE * across.Count;
                        Span overAcross = across;
                        Span down;
                        if (!Heaviest(TrueRuns(rowFlags), run => { long w = 0; foreach (Box b in sitting) w += (long)Overlap(b.Y, run) * Overlap(b.X, overAcross); return w; }, out down)) break;
                        bool held = told && paperX.From == across.From && paperX.To == across.To && paperY.From == down.From && paperY.To == down.To;
                        told = true;
                        paperX = across;
                        paperY = down;
                        if (held || (down.From == band.From && down.To == band.To)) break;
                        band = down;
                    }
                    if (told && paperX.From == 0 && paperX.To == width && paperY.From == 0 && paperY.To == height) told = false;
                }
            }

            // The words left out (as paper), each box WORD_PAD bigger. A word with no letter or digit
            // is not one the page keeps: a blank's underscores ("____") stay.
            double pad = WORD_PAD * scale;
            foreach (OcrLine l in kept)
            {
                if (l.Words.Count == 0)
                {
                    Blank(grey, width, PixelsOf(l.X - pad, l.Y - pad, l.W + 2 * pad, l.H + 2 * pad, left, top, width, height), paperByte);
                    continue;
                }
                foreach (OcrWord w in l.Words)
                    if (HasLetterOrDigit(w.T))
                        Blank(grey, width, PixelsOf(w.X - pad, w.Y - pad, w.W + 2 * pad, w.H + 2 * pad, left, top, width, height), paperByte);
            }
            Span regionX = told ? paperX : new Span(0, width), regionY = told ? paperY : new Span(0, height);

            // The ink: a cell is drawn on when enough of its pixels are marked (the words are paper now).
            int cell = Math.Max(1, (int)Math.Round(INK_CELL * scale));
            int cols = Math.Min(INK_CELLS_MOST, (regionX.Count + cell - 1) / cell);
            int rows = Math.Min(INK_CELLS_MOST, (regionY.Count + cell - 1) / cell);
            var marked = new int[cols * rows];
            int lastY = Math.Min(regionY.To, regionY.From + rows * cell), lastX = Math.Min(regionX.To, regionX.From + cols * cell);
            for (int y = regionY.From; y < lastY; y++)
            {
                int r = (y - regionY.From) / cell;
                for (int x = regionX.From; x < lastX; x++)
                    if (isMarked(grey[y * width + x])) marked[r * cols + (x - regionX.From) / cell]++;
            }
            var bits = new byte[(cols * rows + 7) / 8];
            for (int r = 0; r < rows; r++)
            {
                int tall = Math.Min(cell, regionY.Count - r * cell);
                for (int c = 0; c < cols; c++)
                {
                    int wide = Math.Min(cell, regionX.Count - c * cell);
                    int i = r * cols + c;
                    if (marked[i] > INK_SHARE * tall * wide) bits[i >> 3] |= (byte)(1 << (i & 7));
                }
            }
            return new PageGeometry
            {
                HasPaper = told,
                PaperX = left + regionX.From, PaperY = top + regionY.From, PaperW = regionX.Count, PaperH = regionY.Count,
                Ink = new InkGrid { X = left + regionX.From, Y = top + regionY.From, Cell = cell, Cols = cols, Rows = rows, Bits = bits },
            };
        }

        static void Blank(byte[] grey, int width, Box b, byte paper)
        {
            for (int y = b.Y.From; y < b.Y.To; y++) for (int x = b.X.From; x < b.X.To; x++) grey[y * width + x] = paper;
        }

        /** A rule's thin rect as a read sends it: from its ends and its middle, Rule.H rows tall. */
        public static Dictionary<string, object> RuleBox(Rule r)
        {
            double h = Math.Max(1, r.H);
            return new Dictionary<string, object> { { "x", J.R(r.X0) }, { "y", J.R(r.Y - (h - 1) / 2) }, { "w", J.R(r.X1 - r.X0) }, { "h", J.R(h) } };
        }

        /** Whether a rule (screen pixels) lies on a paper told: a page's rule, not the app's own around it. */
        public static bool OnPaper(Rule r, PageGeometry g)
        {
            if (g == null || !g.HasPaper) return true;
            return r.Y >= g.PaperY && r.Y < g.PaperY + g.PaperH && r.X0 < g.PaperX + g.PaperW && r.X1 > g.PaperX;
        }

        /** A page's geometry as the read sends it ("paper" only when told). */
        public static void Fields(PageGeometry g, Dictionary<string, object> answer)
        {
            if (g.HasPaper)
                answer["paper"] = new Dictionary<string, object> { { "x", g.PaperX }, { "y", g.PaperY }, { "w", g.PaperW }, { "h", g.PaperH } };
            answer["ink"] = new Dictionary<string, object>
            {
                { "x", g.Ink.X }, { "y", g.Ink.Y }, { "cell", g.Ink.Cell }, { "cols", g.Ink.Cols }, { "rows", g.Ink.Rows },
                { "bits", Convert.ToBase64String(g.Ink.Bits) },
            };
        }
    }
}
