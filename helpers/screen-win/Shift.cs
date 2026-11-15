// How far an observed window's content really moved, measured from its pixels while it moves
// ("shift": Windows only; the Mac's helper never sends it, and the page then follows the wheel).
//
// A wheel says how far the app was asked to scroll, not how far it went: an app's own step, its
// smooth-scroll animation and a page that stops at its end all differ from it, and the lesson's ink
// drawn at a guess slides off the words it marks (the founder, 2026-11-14: "when I scroll up and
// down it displaces and highlights different sections"). So, from the first wheel (or key) on an
// observed window until it settles, at most every FRAME_MS and never for more than IDLE_STOP_MS
// past the last input, the window's body (its frame without the top and bottom EDGE_SHARE, where
// bars sit) is pictured from the screen (Tutornote's own windows are never in it), at one pixel per
// point, in grey. Each picture is matched against the one before (Measure): row profiles of its ink
// in STRIPS vertical strips, each strip's best lag by normalised cross-correlation, the lag most
// strips agree on (a static sidebar's strip votes 0 and is outvoted), refined below a pixel by a
// parabola through the correlation, and checked on the pixels themselves (Residual) so a page that
// changed, rather than moved, is never taken for a shift. A match that is not clearly right says
// nothing ("send nothing rather than a guess"), and the motion's shifts stop with a "lost" one.
//
// Sign: as the wheel's "scroll" dy, the content moved UP by dy points (it was at row y, it is at
// y - dy now), and LEFT by dx.
using System;
using System.Collections.Generic;
using System.Threading;

namespace Tutornote.Screen
{
    /** One match of two pictures: Ok with Dy, Dx (pixels of the pictures), or Why it was refused. */
    public struct ShiftMatch
    {
        public bool Ok;
        public double Dy, Dx;
        public int Votes, Strips;
        public double Residual, Texture;
        public string Why;
    }

    public static class Shift
    {
        /** The body is cut into this many vertical strips, each matched on its own. */
        public const int STRIPS = 8;
        /** A strip's ink profile below this spread is blank: it has no vote. */
        const double FLAT_STD = 20;
        /** A strip's best correlation below this is no match: it has no vote. */
        const double STRIP_NCC = 0.8;
        /** Pixels this far from the page's ground are ink (a fainter edge is the screen's noise). */
        const int INK_FROM = 10;
        /** The rows two pictures must share at the least: a quarter of their height, 16 at the least. */
        const int MIN_OVERLAP = 16;
        /** The pixels at the agreed shift must differ by no more than this share of the page's own
         *  texture (its mean difference to itself one row down): a sub-pixel shift leaves about half
         *  of it, a page that changed leaves more than all of it. */
        const double RESIDUAL_SHARE = 0.75;
        /** A page with less texture than this (grey levels) is too blank to match. */
        const double MIN_TEXTURE = 0.4;

        /** The page's ground: its most common grey value. */
        public static int Ground(Look g)
        {
            var hist = new int[256];
            for (int i = 0; i < g.G.Length; i += 3) hist[g.G[i]]++;
            int best = 0;
            for (int v = 1; v < 256; v++) if (hist[v] > hist[best]) best = v;
            return best;
        }

        /** Each strip's row profile: per row, how much ink it has (distance from the ground). */
        public static double[][] Profiles(Look g, int ground, int strips)
        {
            var p = new double[strips][];
            for (int k = 0; k < strips; k++)
            {
                p[k] = new double[g.H];
                int x0 = k * g.W / strips, x1 = (k + 1) * g.W / strips;
                for (int y = 0; y < g.H; y++)
                {
                    int row = y * g.W, sum = 0;
                    for (int x = x0; x < x1; x++)
                    {
                        int d = g.G[row + x] - ground;
                        if (d < 0) d = -d;
                        if (d > INK_FROM) sum += d - INK_FROM;
                    }
                    p[k][y] = sum;
                }
            }
            return p;
        }

        /** The spread (standard deviation) of a profile. */
        public static double Std(double[] a)
        {
            if (a.Length == 0) return 0;
            double m = 0, s = 0;
            foreach (double v in a) m += v;
            m /= a.Length;
            foreach (double v in a) s += (v - m) * (v - m);
            return Math.Sqrt(s / a.Length);
        }

        /**
         * The normalised cross-correlation of `a` and `b` at `lag`: `a[i]` against `b[i - lag]` over
         * the indices both have (b's content is a's moved by `lag` towards 0). -2 with fewer than
         * `minOverlap` shared or with either side flat there.
         */
        public static double Ncc(double[] a, double[] b, int lag, int minOverlap)
        {
            int from = Math.Max(0, lag), to = Math.Min(a.Length, b.Length + lag);
            int n = to - from;
            if (n < minOverlap) return -2;
            double sa = 0, sb = 0;
            for (int i = from; i < to; i++) { sa += a[i]; sb += b[i - lag]; }
            double ma = sa / n, mb = sb / n, sab = 0, saa = 0, sbb = 0;
            for (int i = from; i < to; i++)
            {
                double x = a[i] - ma, y = b[i - lag] - mb;
                sab += x * y; saa += x * x; sbb += y * y;
            }
            if (saa <= 1e-9 || sbb <= 1e-9) return -2;
            return sab / Math.Sqrt(saa * sbb);
        }

        /** The same over several profiles at once (each pair a[k], b[k], summed). */
        public static double NccAll(double[][] a, double[][] b, List<int> which, int lag, int minOverlap)
        {
            double sab = 0, saa = 0, sbb = 0;
            foreach (int k in which)
            {
                double[] pa = a[k], pb = b[k];
                int from = Math.Max(0, lag), to = Math.Min(pa.Length, pb.Length + lag);
                int n = to - from;
                if (n < minOverlap) return -2;
                double ma = 0, mb = 0;
                for (int i = from; i < to; i++) { ma += pa[i]; mb += pb[i - lag]; }
                ma /= n; mb /= n;
                for (int i = from; i < to; i++)
                {
                    double x = pa[i] - ma, y = pb[i - lag] - mb;
                    sab += x * y; saa += x * x; sbb += y * y;
                }
            }
            if (saa <= 1e-9 || sbb <= 1e-9) return -2;
            return sab / Math.Sqrt(saa * sbb);
        }

        /** The best whole lag of `a` against `b` within +-`maxLag` (its correlation in `score`). */
        public static int BestLag(double[] a, double[] b, int maxLag, int minOverlap, out double score)
        {
            score = -2;
            int best = 0;
            for (int lag = -maxLag; lag <= maxLag; lag++)
            {
                double c = Ncc(a, b, lag, minOverlap);
                // (a tie goes to the smaller move)
                if (c > score + 1e-9 || (Math.Abs(c - score) <= 1e-9 && Math.Abs(lag) < Math.Abs(best))) { score = c; best = lag; }
            }
            return best;
        }

        /** Where a parabola through three correlations at -1, 0, +1 peaks, within half a step of 0. */
        public static double Parabola(double left, double mid, double right)
        {
            if (left < -1.5 || right < -1.5) return 0;
            double den = left - 2 * mid + right;
            if (den >= -1e-12) return 0;
            double d = 0.5 * (left - right) / den;
            return Math.Max(-0.5, Math.Min(0.5, d));
        }

        /**
         * The mean grey difference of `a` against `b` moved by `dy` rows and `dx` columns (b's pixel
         * at (x - dx, y - dy) against a's at (x, y)), in columns x0..x1 of a, every other row and
         * column. 255 when they share too little.
         */
        public static double Residual(Look a, Look b, int dy, int dx, int x0, int x1)
        {
            long sum = 0; int n = 0;
            int y0 = Math.Max(0, dy), y1 = Math.Min(a.H, b.H + dy);
            int xa = Math.Max(Math.Max(0, dx), x0), xb = Math.Min(Math.Min(a.W, b.W + dx), x1);
            for (int y = y0; y < y1; y += 2)
            {
                int ra = y * a.W, rb = (y - dy) * b.W - dx;
                for (int x = xa; x < xb; x += 2) { int d = a.G[ra + x] - b.G[rb + x]; sum += d < 0 ? -d : d; n++; }
            }
            return n < 64 ? 255 : (double)sum / n;
        }

        /**
         * How `cur` moved from `prev` (pictures of the same size): Dy rows up and Dx columns left, in
         * the pictures' pixels, or refused (Ok false, Why): "size", "flat" (too little to match),
         * "split" (the strips do not agree), "changed" (the pixels do not match at the agreed shift).
         */
        public static ShiftMatch Measure(Look prev, Look cur)
        {
            var m = new ShiftMatch { Why = "" };
            if (prev == null || cur == null || prev.W != cur.W || prev.H != cur.H || prev.W < STRIPS * 4 || prev.H < MIN_OVERLAP * 2) { m.Why = "size"; return m; }
            int W = prev.W, H = prev.H;
            int ground = Ground(prev);
            double[][] a = Profiles(prev, ground, STRIPS), b = Profiles(cur, ground, STRIPS);
            int minOverlap = Math.Max(MIN_OVERLAP, H / 4), maxLag = H - minOverlap;
            // Each textured strip's own best lag.
            var lags = new List<int>();
            var voters = new List<int>();
            for (int k = 0; k < STRIPS; k++)
            {
                if (Std(a[k]) < FLAT_STD || Std(b[k]) < FLAT_STD) continue;
                double score;
                int lag = BestLag(a[k], b[k], maxLag, minOverlap, out score);
                if (score < STRIP_NCC) continue;
                lags.Add(lag); voters.Add(k);
            }
            m.Strips = voters.Count;
            if (voters.Count < 2) { m.Why = "flat"; return m; }
            // The lag most strips agree on (within a row of each other), and no other lag as many.
            int bestLag;
            int bestVotes = Vote(lags, out bestLag);
            int secondVotes = 0;
            foreach (int c in lags)
            {
                if (Math.Abs(c - bestLag) <= 2) continue;
                int votes = 0;
                foreach (int l in lags) if (Math.Abs(l - c) <= 1) votes++;
                secondVotes = Math.Max(secondVotes, votes);
            }
            m.Votes = bestVotes;
            if (bestVotes * 2 < voters.Count || bestVotes == secondVotes) { m.Why = "split"; return m; }
            var agree = new List<int>();
            for (int i = 0; i < voters.Count; i++) if (Math.Abs(lags[i] - bestLag) <= 1) agree.Add(voters[i]);
            // The whole lag the agreeing strips peak at together, and below a pixel by a parabola.
            int L = bestLag;
            double c0 = NccAll(a, b, agree, L, minOverlap);
            for (int d = -1; d <= 1; d += 2)
            {
                double c = NccAll(a, b, agree, bestLag + d, minOverlap);
                if (c > c0) { c0 = c; L = bestLag + d; }
            }
            double sub = Parabola(NccAll(a, b, agree, L - 1, minOverlap), c0, NccAll(a, b, agree, L + 1, minOverlap));
            // Checked on the pixels, in the agreeing strips' columns.
            int x0 = int.MaxValue, x1 = 0;
            foreach (int k in agree) { x0 = Math.Min(x0, k * W / STRIPS); x1 = Math.Max(x1, (k + 1) * W / STRIPS); }
            double texture = Residual(prev, prev, 1, 0, x0, x1);
            m.Texture = texture;
            if (texture < MIN_TEXTURE) { m.Why = "flat"; return m; }
            // Sideways: the columns' ink, over the rows the two share at L, nearest the smaller move.
            int dx = 0;
            double subX = 0;
            double[] ca = Columns(prev, ground, L, true), cb = Columns(cur, ground, L, false);
            if (Std(ca) >= FLAT_STD && Std(cb) >= FLAT_STD)
            {
                double score;
                int lx = BestLag(ca, cb, W / 4, Math.Max(MIN_OVERLAP, W / 2), out score);
                if (lx != 0 && score >= STRIP_NCC && Residual(prev, cur, L, lx, 0, W) < 0.8 * Residual(prev, cur, L, 0, 0, W))
                {
                    dx = lx;
                    subX = Parabola(Ncc(ca, cb, lx - 1, W / 2), score, Ncc(ca, cb, lx + 1, W / 2));
                }
            }
            double r = dx == 0 ? Residual(prev, cur, L, 0, x0, x1) : Residual(prev, cur, L, dx, Math.Max(x0, dx), x1);
            m.Residual = r;
            if (r > RESIDUAL_SHARE * texture + 0.5) { m.Why = "changed"; return m; }
            m.Ok = true;
            m.Dy = L + sub;
            m.Dx = dx + subX;
            return m;
        }

        /** The lag most of `lags` lie within a row of (`best`; a tie goes to the smaller move), and how many. */
        public static int Vote(List<int> lags, out int best)
        {
            best = 0;
            int most = 0;
            foreach (int c in lags)
            {
                int votes = 0;
                foreach (int l in lags) if (Math.Abs(l - c) <= 1) votes++;
                if (votes > most || (votes == most && Math.Abs(c) < Math.Abs(best))) { most = votes; best = c; }
            }
            return most;
        }

        /** The columns' ink profile over the rows `prev` (`isPrev`) or `cur` shares with the other at
         *  lag `lag` (a's rows lag.., b's rows ..H-lag). */
        static double[] Columns(Look g, int ground, int lag, bool isPrev)
        {
            int y0, y1;
            if (isPrev) { y0 = Math.Max(0, lag); y1 = Math.Min(g.H, g.H + lag); }
            else { y0 = Math.Max(0, -lag); y1 = Math.Min(g.H, g.H - lag); }
            var c = new double[g.W];
            for (int y = y0; y < y1; y++)
            {
                int row = y * g.W;
                for (int x = 0; x < g.W; x++)
                {
                    int d = g.G[row + x] - ground;
                    if (d < 0) d = -d;
                    if (d > INK_FROM) c[x] += d - INK_FROM;
                }
            }
            return c;
        }
    }

    /**
     * The motion of an observed window, from its first move to when it holds still (the "settled"
     * test, fed by every look taken of it: the watch's thumbnails and the shift tracker's pictures).
     * A move is an input that scrolls or zooms it (Input) or a look that differs from the one before
     * (Frame). It settles once a look holds still QUIET_MS after the last move; one input that moved
     * nothing at all (a wheel at the end of a page) settles UNMOVED_MS after it. Not thread-safe:
     * the watch holds its lock round each call.
     */
    public sealed class Settle
    {
        public const int QUIET_MS = 100, UNMOVED_MS = 250;
        /** Looks are taken often (POLL_MS) for this long after the last move at the most. */
        public const int MAX_MS = 3000;
        public long Start = -1, LastInput = -1, LastChange = -1;
        public bool Moved;

        public bool Moving { get { return Start >= 0; } }

        /** The last move: an input's or a look's. */
        public long Last { get { return Math.Max(Start, Math.Max(LastInput, LastChange)); } }

        /** Whether it moves now: moving, its last move less than MAX_MS ago. */
        public bool MovingNow(long now) { return Moving && now - Last < MAX_MS; }

        public void Input(long now)
        {
            if (Start < 0) { Start = now; Moved = false; LastChange = -1; }
            LastInput = now;
        }

        /** A look taken at `now`, `step` from the one before (Diff.Mean): when it settles, how long
         *  the motion took (ms); else -1. */
        public long Frame(long now, double step)
        {
            if (step >= Diff.SETTLED_BELOW)
            {
                if (Start < 0)
                {
                    if (step <= Diff.CHANGED_ABOVE) return -1;
                    Start = now; LastInput = -1;
                }
                Moved = true;
                LastChange = now;
                return -1;
            }
            if (Start < 0) return -1;
            if (now - Math.Max(LastInput, LastChange) < (Moved ? QUIET_MS : UNMOVED_MS)) return -1;
            long ms = now - Start;
            Start = -1; LastInput = -1; LastChange = -1; Moved = false;
            return ms;
        }
    }

    /**
     * The shift tracker: one observed window at a time (the last moved), on a thread of its own that
     * sleeps while nothing moves. Started by the watch at each input that moves an observed window
     * (Watcher.OnWheel, KeyTick), or at a motion its looks found that no input began (a scroll bar, a
     * touchpad); stops when the window settles (its last shift said, then "settled") or IDLE_STOP_MS
     * after the last input. Each motion is measured from the window's standing picture, taken while
     * it held still (Standing): never from one taken after the app may have moved already.
     */
    public static class Tracker
    {
        const int FRAME_MS = 33;
        const int IDLE_STOP_MS = 3000;
        /** A shift smaller than this (points) is said with the next. */
        const double SAY_FROM = 0.25;
        /** The picture's width at the most (points): a wider window is pictured smaller. */
        const int WIDE_MAX = 1200;
        /** A still observed window's standing picture (Standing) is taken again this often (ms) at the
         *  most, and a motion is measured from it only while it is younger than REF_MAX_MS. */
        public const int REF_EVERY_MS = 1000, REF_MAX_MS = 2000;

        /** A window's picture from before it moved: what a motion's first shift is measured from. An
         *  app gets the same wheel the watch hears (Raw Input), so a picture taken once the tracker is
         *  up may already show the first notch moved; this one never does. */
        sealed class Ref { public Look Look; public RECT Body; public int W, H; public long At; }

        static readonly object Gate = new object();
        // (wakes the idle tracker for a motion; a frame's wait is a plain sleep, so it never goes faster
        // than FRAME_MS however fast the wheel's events come)
        static readonly AutoResetEvent Wake = new AutoResetEvent(false);
        static readonly Dictionary<long, Ref> refs = new Dictionary<long, Ref>();
        static Thread thread;
        static IntPtr window = IntPtr.Zero;
        static long lastInput, runStart;
        static bool settleAsked;
        static long settleMs = -1;
        /** Each motion followed is a run; `followed`, the last one begun, and `following` while one goes. */
        static long run, followed;
        static bool following;
        /** The run was begun by a look the watch found changed, no input (Moved `byLook`): it may be no
         *  scroll at all (a video playing, a dialog), so a match refused says nothing ("lost" is for a
         *  scroll that went unmeasured); its measured moves are said as any. */
        static bool byLook;
        /** The run being followed was lost (a match refused for good): a new input then begins a new
         *  run, measured from the last frame taken before it, instead of being swallowed by the lost one. */
        static bool runLost;
        /** A match refused this many frames in a row loses the motion: one refused frame (a capture
         *  torn mid-repaint, a caret blinking) is skipped, and the next is measured from the same held picture. */
        const int REFUSED_MAX = 4;

        /** An input (or, `look`, a look the watch found changed: a scroll bar dragged, a touchpad's
         *  scroll) moved `h` (an observed window) at `now`. */
        public static void Moved(IntPtr h, long now, bool look = false)
        {
            lock (Gate)
            {
                if (window != h || !following || (runLost && !look)) { window = h; run++; runStart = now; byLook = look; runLost = false; }
                else if (!look) byLook = false;
                lastInput = now;
                settleAsked = false;
                settleMs = -1;
                if (thread == null)
                {
                    thread = new Thread(Loop) { IsBackground = true, Name = "shift", Priority = ThreadPriority.BelowNormal };
                    thread.Start();
                }
            }
            Wake.Set();
        }

        /** `h` is no longer observed: its shifts stop, unsaid, and its standing picture goes. */
        public static void Drop(IntPtr h)
        {
            lock (Gate)
            {
                refs.Remove(h.ToInt64());
                if (window == h) { window = IntPtr.Zero; run++; }
            }
            Wake.Set();
        }

        /** `h` settled after `ms` (the watch's test). While the tracker follows it, its shifts end with
         *  one said settled and then the tracker says "settled" itself (true), so the page and main hear
         *  the motion's last move before its end; else false, and the watch says it. */
        public static bool SettleVia(IntPtr h, long ms)
        {
            lock (Gate)
            {
                if (window != h || !following) return false;
                settleAsked = true;
                settleMs = ms;
                return true;
            }
        }

        /** `h` holds still (the watch's look of it unchanged, no motion open) at `now`: its standing
         *  picture is taken again, REF_EVERY_MS after the last at the soonest. On the watch's thread. */
        public static void Standing(IntPtr h, long now)
        {
            long key = h.ToInt64();
            lock (Gate)
            {
                if (following && window == h) return;
                Ref known;
                if (refs.TryGetValue(key, out known) && now - known.At < REF_EVERY_MS) return;
            }
            RECT body; int dw, dh; double ppp;
            if (!Body(h, out body, out dw, out dh, out ppp)) return;
            Look look = Picture(body, dw, dh);
            if (look == null) return;
            // (`At`, when the picture was done: a motion begun before then is not measured from it)
            long at = Clock.Ms;
            lock (Gate)
                if (!(following && window == h)) refs[key] = new Ref { Look = look, Body = body, W = dw, H = dh, At = at };
        }

        /** Whether a motion begun at `start` may be measured from a standing picture done at `refAt`
         *  (`same`: of the same place and size): taken whole before the motion, and not long before. */
        public static bool RefFits(long refAt, long start, bool same)
        {
            return same && refAt <= start && start - refAt < REF_MAX_MS;
        }

        static void Loop()
        {
            while (true)
            {
                Wake.WaitOne();
                while (true)
                {
                    lock (Gate)
                    {
                        if (window == IntPtr.Zero || run == followed) break;
                        followed = run;
                        following = true;
                    }
                    IntPtr h = IntPtr.Zero;
                    try { Follow(out h); } catch (Exception e) { Out.Log("shift tracker failed: " + e.GetType().Name); }
                    finally
                    {
                        // (a settle asked of a motion that ended without taking it is said all the same)
                        long ms;
                        lock (Gate) { following = false; ms = settleAsked ? settleMs : -1; settleAsked = false; settleMs = -1; }
                        if (ms >= 0 && h != IntPtr.Zero) Watcher.SendSettled(h, ms);
                    }
                }
            }
        }

        /** The body of a window's frame (EDGE_SHARE off its top and bottom), and the size it is pictured at. */
        static bool Body(IntPtr h, out RECT body, out int dw, out int dh, out double pointsPerPixel)
        {
            body = new RECT(); dw = dh = 0; pointsPerPixel = 1;
            if (!Win32.IsWindow(h) || Win32.IsIconic(h)) return false;
            RECT f = Win32.FrameOf(h);
            int cut = (int)(f.Height * Diff.EDGE_SHARE);
            body = new RECT { Left = f.Left, Right = f.Right, Top = f.Top + cut, Bottom = f.Bottom - cut };
            if (body.Width < 64 || body.Height < 64) return false;
            double scale = Math.Max(0.5, Win32.ScaleOf(h));
            double wPoints = body.Width / scale, k = Math.Min(1.0, WIDE_MAX / wPoints);
            dw = Math.Max(32, (int)Math.Round(wPoints * k));
            dh = Math.Max(32, (int)Math.Round(body.Height / scale * k));
            // (one picture pixel is this many points, down and across alike)
            pointsPerPixel = body.Height / scale / dh;
            return true;
        }

        static Look Picture(RECT body, int dw, int dh)
        {
            Picture p = Capture.Screen(body, dw, dh);
            return p == null ? null : Capture.Grey(p);
        }

        /** This motion's shifts stop here: one said "lost" (dy and dx 0), with why (nothing said for a
         *  motion only a look began: byLook). */
        static void Lost(IntPtr h, string why)
        {
            lock (Gate) if (byLook) return;
            Out.Send(new Dictionary<string, object>
            {
                { "ev", "shift" }, { "window", h.ToInt64() }, { "dy", 0 }, { "dx", 0 }, { "settled", false }, { "lost", true }, { "why", why },
            });
        }

        /** Whether a frame `step` (Diff.Mean) from the held picture is no move at all: it is then not
         *  measured, and the held picture stays, so a slow creep of under a pixel a frame adds up
         *  against it until it can be measured, never dropped frame by frame. */
        public static bool Still(double step) { return step < Diff.SETTLED_BELOW / 2; }

        /** What the settle test is fed for a frame `step` from the held picture: a measured move is a
         *  move, however faint its pixels' change. */
        public static double SettleStep(double step, bool measuredMove)
        {
            return measuredMove ? Math.Max(step, Diff.SETTLED_BELOW) : step;
        }

        static void Follow(out IntPtr h)
        {
            long myRun, start;
            lock (Gate) { h = window; myRun = run; start = runStart; }
            if (h == IntPtr.Zero) return;
            RECT body; int dw, dh; double ppp;
            if (!Body(h, out body, out dw, out dh, out ppp)) return;
            Look prev = null;
            lock (Gate)
            {
                Ref r;
                if (refs.TryGetValue(h.ToInt64(), out r) && RefFits(r.At, start, r.W == dw && r.H == dh && r.Body.Left == body.Left && r.Body.Top == body.Top && r.Body.Right == body.Right && r.Body.Bottom == body.Bottom))
                    prev = r.Look;
                // (used or unfit: the next motion is measured from a picture taken after this one)
                refs.Remove(h.ToInt64());
            }
            double carryY = 0, carryX = 0;
            // (`said`: a shift was said in this motion; its last, settled, is said only then, or with a
            // move of its own: a motion that measured no move at all ends with "settled" alone)
            bool lost = false, said = false;
            int refused = 0;
            lock (Gate) runLost = false;
            if (prev == null)
            {
                // (no picture from before it moved: what moved before a first one taken now would be
                // missed, so this motion is not measured at all rather than measured short)
                prev = Picture(body, dw, dh);
                if (prev == null) return;
                lost = true;
                lock (Gate) runLost = true;
                Lost(h, "reference");
            }
            // (the last frame and when it was begun: a new run that ends this one is measured from it)
            Look last = prev; long lastAt = Clock.Ms;
            while (true)
            {
                long t0 = Clock.Ms;
                bool settle, stale; long asked;
                lock (Gate)
                {
                    settle = settleAsked;
                    asked = settleMs;
                    stale = window != h || run != myRun || t0 - lastInput > IDLE_STOP_MS;
                    if (settle && !stale) { settleAsked = false; settleMs = -1; }
                }
                // (a settle asked and not taken here is said by Loop; a new run on the same window, begun
                // after the last frame was taken, is measured from that frame)
                if (stale)
                {
                    lock (Gate)
                        if (window == h && run != myRun && last != null)
                            refs[h.ToInt64()] = new Ref { Look = last, Body = body, W = dw, H = dh, At = lastAt };
                    return;
                }
                RECT now; int nw, nh; double np;
                // (a window moved or resized on the screen: its pictures no longer compare)
                if (!Body(h, out now, out nw, out nh, out np) || now.Left != body.Left || now.Top != body.Top || nw != dw || nh != dh)
                {
                    if (!lost) Lost(h, "frame");
                    if (settle) Watcher.SendSettled(h, asked);
                    return;
                }
                long shotAt = Clock.Ms;
                Look cur = Picture(body, dw, dh);
                if (cur == null)
                {
                    if (!lost) Lost(h, "capture");
                    if (settle) Watcher.SendSettled(h, asked);
                    return;
                }
                double step = Diff.Mean(cur, prev);
                bool moved = false;
                if (!lost && !Still(step))
                {
                    ShiftMatch m = Shift.Measure(prev, cur);
                    if (!m.Ok)
                    {
                        // (no guess: a frame refused is skipped, the held picture kept; refused again and
                        // again, the page is told this motion's shifts stop here)
                        refused++;
                        if (refused >= REFUSED_MAX)
                        {
                            lost = true;
                            lock (Gate) runLost = true;
                            Lost(h, m.Why);
                        }
                    }
                    else
                    {
                        refused = 0;
                        carryY += m.Dy * ppp; carryX += m.Dx * ppp;
                        moved = m.Dy != 0 || m.Dx != 0;
                    }
                }
                // (this frame may settle it: then its last shift is said first, and "settled" after)
                long ms = settle ? asked : Watcher.TrackerFrame(h, Clock.Ms, SettleStep(step, moved));
                bool ends = settle || ms >= 0;
                // (it ends on a frame that would not match: what moved since the last match is unknown)
                if (ends && !lost && refused > 0) { lost = true; Lost(h, "end"); }
                if (!lost && (Math.Abs(carryY) >= SAY_FROM || Math.Abs(carryX) >= SAY_FROM || (ends && (said || carryY != 0 || carryX != 0))))
                {
                    said = true;
                    Out.Send(new Dictionary<string, object>
                    {
                        { "ev", "shift" }, { "window", h.ToInt64() }, { "dy", Math.Round(carryY, 2) }, { "dx", Math.Round(carryX, 2) }, { "settled", ends },
                    });
                    carryY = 0; carryX = 0;
                }
                // (the held picture moves on only once a frame moved, or the motion is lost: see Still)
                bool skipped = !lost && refused > 0;
                if (!skipped && (lost || !Still(step))) prev = cur;
                last = cur; lastAt = shotAt;
                if (ends)
                {
                    Watcher.SendSettled(h, ms);
                    lock (Gate)
                    {
                        // (where it stopped: the next motion's standing picture)
                        refs[h.ToInt64()] = new Ref { Look = cur, Body = body, W = dw, H = dh, At = Clock.Ms };
                        if (run == myRun) window = IntPtr.Zero;
                    }
                    return;
                }
                int rest = FRAME_MS - (int)(Clock.Ms - t0);
                if (rest > 0) Thread.Sleep(rest);
            }
        }
    }
}
