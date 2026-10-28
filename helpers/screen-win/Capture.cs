// Pictures of windows, and the small grey looks the helper compares.
//
// A read pictures the one window with PrintWindow(PW_RENDERFULLCONTENT): the window's own content,
// even where another window covers it, with no capture border and no permission to ask. A window
// that gives a black picture that way (some do) is pictured from the screen instead.
// Thumbnails (256 px wide, grey) and the patch around a tap come from the screen, which is cheap;
// Tutornote's own floating windows are left out of every screen picture by the app
// (setContentProtection), so the tutor's marks never count as the page changing.
using System;
using System.Runtime.InteropServices;

namespace Tutornote.Screen
{
    /** A picture: top-down 32-bit BGRA pixels. */
    public sealed class Picture
    {
        public int W, H;
        public byte[] Bgra;
        public Picture(int w, int h) { W = w; H = h; Bgra = new byte[w * h * 4]; }
    }

    /** A grey look of a window: W x H values, 0 to 255. */
    public sealed class Look
    {
        public int W, H;
        public byte[] G;
        public long At;
        public Look(int w, int h) { W = w; H = h; G = new byte[w * h]; At = Clock.Ms; }
    }

    public static class Clock
    {
        static readonly System.Diagnostics.Stopwatch Watch = System.Diagnostics.Stopwatch.StartNew();
        public static long Ms { get { return Watch.ElapsedMilliseconds; } }
    }

    public static class Capture
    {
        public const int THUMB_WIDE = 256;

        static Picture FromDc(IntPtr srcDc, int sx, int sy, int w, int h, int dw, int dh, bool viaPrint, IntPtr window)
        {
            if (w <= 0 || h <= 0 || dw <= 0 || dh <= 0) return null;
            var bmi = new BITMAPINFOHEADER { biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER)), biWidth = dw, biHeight = -dh, biPlanes = 1, biBitCount = 32 };
            IntPtr bits;
            IntPtr mem = Win32.CreateCompatibleDC(srcDc);
            IntPtr dib = Win32.CreateDIBSection(mem, ref bmi, 0, out bits, IntPtr.Zero, 0);
            if (dib == IntPtr.Zero) { Win32.DeleteDC(mem); return null; }
            IntPtr old = Win32.SelectObject(mem, dib);
            try
            {
                bool ok;
                if (viaPrint) ok = Win32.PrintWindow(window, mem, Win32.PW_RENDERFULLCONTENT);
                else if (dw == w && dh == h) ok = Win32.BitBlt(mem, 0, 0, w, h, srcDc, sx, sy, Win32.SRCCOPY | Win32.CAPTUREBLT);
                else
                {
                    Win32.SetStretchBltMode(mem, Win32.HALFTONE);
                    ok = Win32.StretchBlt(mem, 0, 0, dw, dh, srcDc, sx, sy, w, h, Win32.SRCCOPY | Win32.CAPTUREBLT);
                }
                if (!ok) return null;
                var pic = new Picture(dw, dh);
                Marshal.Copy(bits, pic.Bgra, 0, pic.Bgra.Length);
                return pic;
            }
            finally
            {
                Win32.SelectObject(mem, old);
                Win32.DeleteObject(dib);
                Win32.DeleteDC(mem);
            }
        }

        /** What the screen shows in a rectangle (physical pixels), at its own size or scaled to dw x dh. */
        public static Picture Screen(RECT r, int dw, int dh)
        {
            IntPtr screen = Win32.GetDC(IntPtr.Zero);
            try { return FromDc(screen, r.Left, r.Top, r.Width, r.Height, dw, dh, false, IntPtr.Zero); }
            finally { Win32.ReleaseDC(IntPtr.Zero, screen); }
        }

        /** The window's own picture, cropped to its visible frame. `fromScreen` says when it had to be the screen's. */
        public static Picture Window(IntPtr h, RECT frame, out bool fromScreen)
        {
            fromScreen = false;
            RECT whole;
            Win32.GetWindowRect(h, out whole);
            IntPtr screen = Win32.GetDC(IntPtr.Zero);
            Picture pic;
            try { pic = FromDc(screen, 0, 0, whole.Width, whole.Height, whole.Width, whole.Height, true, h); }
            finally { Win32.ReleaseDC(IntPtr.Zero, screen); }
            if (pic != null)
            {
                pic = Crop(pic, frame.Left - whole.Left, frame.Top - whole.Top, frame.Width, frame.Height);
                if (pic != null && !AllDark(pic)) return pic;
            }
            fromScreen = true;
            return Screen(frame, frame.Width, frame.Height);
        }

        public static Picture Crop(Picture p, int x, int y, int w, int h)
        {
            x = Math.Max(0, x); y = Math.Max(0, y);
            w = Math.Min(w, p.W - x); h = Math.Min(h, p.H - y);
            if (w <= 0 || h <= 0) return null;
            if (x == 0 && y == 0 && w == p.W && h == p.H) return p;
            var c = new Picture(w, h);
            for (int row = 0; row < h; row++) Buffer.BlockCopy(p.Bgra, ((y + row) * p.W + x) * 4, c.Bgra, row * w * 4, w * 4);
            return c;
        }

        /** A picture scaled down by a whole-number step (a box filter), for a glance at a large window. */
        public static Picture Half(Picture p)
        {
            int w = p.W / 2, h = p.H / 2;
            var q = new Picture(w, h);
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int a = ((2 * y) * p.W + 2 * x) * 4, b = a + p.W * 4, o = (y * w + x) * 4;
                    for (int k = 0; k < 4; k++) q.Bgra[o + k] = (byte)((p.Bgra[a + k] + p.Bgra[a + 4 + k] + p.Bgra[b + k] + p.Bgra[b + 4 + k]) >> 2);
                }
            return q;
        }

        static bool AllDark(Picture p)
        {
            // (sampled: a black picture is black everywhere)
            int step = Math.Max(4, p.Bgra.Length / 4 / 4096) * 4;
            for (int i = 0; i + 2 < p.Bgra.Length; i += step)
                if (p.Bgra[i] > 8 || p.Bgra[i + 1] > 8 || p.Bgra[i + 2] > 8) return false;
            return true;
        }

        public static Look Grey(Picture p)
        {
            var g = new Look(p.W, p.H);
            for (int i = 0, j = 0; j < g.G.Length; i += 4, j++)
                g.G[j] = (byte)((p.Bgra[i + 2] * 77 + p.Bgra[i + 1] * 150 + p.Bgra[i] * 29) >> 8);
            return g;
        }

        /** A 256-wide grey thumbnail of what the screen shows of a window, or null. */
        public static Look Thumb(RECT frame)
        {
            if (frame.Width <= 0 || frame.Height <= 0) return null;
            int h = Math.Max(1, (int)Math.Round(frame.Height * (double)THUMB_WIDE / frame.Width));
            var p = Screen(frame, THUMB_WIDE, h);
            return p == null ? null : Grey(p);
        }

        /** The grey patch of the screen in a rectangle, at full size. */
        public static Look Patch(RECT r)
        {
            var p = Screen(r, r.Width, r.Height);
            return p == null ? null : Grey(p);
        }
    }

    /** How different two looks are: mean absolute difference of their grey values, 0 to 255. */
    public static class Diff
    {
        /** Above this, a window has changed (the Mac's CHANGED_ABOVE). */
        public const double CHANGED_ABOVE = 1.5;
        /** Below this between two thumbnails in a row, it has settled (SETTLED_BELOW). */
        public const double SETTLED_BELOW = 0.4;
        /** The top and bottom share left out of a "new look" (EDGE_SHARE): bars that fade. */
        public const double EDGE_SHARE = 0.12;

        public static double Mean(Look a, Look b)
        {
            if (a == null || b == null) return 255;
            if (a.W != b.W || a.H != b.H) return 255;
            long sum = 0;
            for (int i = 0; i < a.G.Length; i++) sum += Math.Abs(a.G[i] - b.G[i]);
            return a.G.Length == 0 ? 0 : (double)sum / a.G.Length;
        }

        /** The middle rows only (EDGE_SHARE left out top and bottom). */
        public static double Middle(Look a, Look b)
        {
            if (a == null || b == null) return 255;
            if (a.W != b.W || a.H != b.H) return 255;
            int top = (int)(a.H * EDGE_SHARE), bottom = a.H - top;
            if (bottom <= top) return Mean(a, b);
            long sum = 0; int n = 0;
            for (int y = top; y < bottom; y++)
                for (int x = 0; x < a.W; x++) { int i = y * a.W + x; sum += Math.Abs(a.G[i] - b.G[i]); n++; }
            return n == 0 ? 0 : (double)sum / n;
        }

        /** The look away from a box (in the look's own pixels): what a tap did elsewhere. */
        public static double Away(Look a, Look b, int bx, int by, int bw, int bh)
        {
            if (a == null || b == null) return 255;
            if (a.W != b.W || a.H != b.H) return 255;
            long sum = 0; int n = 0;
            for (int y = 0; y < a.H; y++)
                for (int x = 0; x < a.W; x++)
                {
                    if (x >= bx && x < bx + bw && y >= by && y < by + bh) continue;
                    int i = y * a.W + x; sum += Math.Abs(a.G[i] - b.G[i]); n++;
                }
            return n == 0 ? 0 : (double)sum / n;
        }

        /** The box of pixels that changed by more than 40 grey levels, or an empty box. */
        public static RECT ChangedBox(Look a, Look b)
        {
            var box = new RECT { Left = int.MaxValue, Top = int.MaxValue, Right = -1, Bottom = -1 };
            if (a == null || b == null || a.W != b.W || a.H != b.H) return new RECT();
            for (int y = 0; y < a.H; y++)
                for (int x = 0; x < a.W; x++)
                {
                    int i = y * a.W + x;
                    if (Math.Abs(a.G[i] - b.G[i]) <= 40) continue;
                    if (x < box.Left) box.Left = x;
                    if (y < box.Top) box.Top = y;
                    if (x + 1 > box.Right) box.Right = x + 1;
                    if (y + 1 > box.Bottom) box.Bottom = y + 1;
                }
            return box.Right < 0 ? new RECT() : box;
        }

        /** How bright a look is, 0 (black) to 1 (white): the lesson draws strong marks on a light page. */
        public static double Ground(Look a)
        {
            if (a == null || a.G.Length == 0) return 1;
            long sum = 0;
            foreach (byte v in a.G) sum += v;
            return Math.Round((double)sum / a.G.Length / 255.0, 3);
        }

        /** A blank window: every grey value within 12 of each other (the Mac's isBlank). */
        public static bool Blank(Look a)
        {
            if (a == null || a.G.Length == 0) return true;
            byte lo = 255, hi = 0;
            foreach (byte v in a.G) { if (v < lo) lo = v; if (v > hi) hi = v; }
            return hi - lo < 12;
        }
    }
}
