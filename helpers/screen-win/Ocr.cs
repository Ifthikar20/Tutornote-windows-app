// Windows' own text reader (Windows.Media.Ocr): on this PC, free, in the languages Windows has a
// reader for (Settings > Time & language > Language: each language's "optical character
// recognition" part). One picture at a time per reader: a whole window's read on one, a tap's few
// words on another of their own (TapEngine), so a tap's verdict never waits behind a whole window.
// No read waits for ever: one the reader has not finished in READ_MS is given up and its reader made
// again, and a whole window's read waits WHOLE_GATE_MS at the most for another's.
using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Security.Cryptography;

namespace Tutornote.Screen
{
    public sealed class OcrWord { public string T; public double X, Y, W, H; }
    public sealed class OcrLine { public string T; public double X, Y, W, H; public List<OcrWord> Words = new List<OcrWord>(); }

    public static class Ocr
    {
        static readonly object Gate = new object();
        // (the engine is made once, under a lock of its own: asking for it never waits behind a read)
        static readonly object EngineGate = new object();
        static volatile OcrEngine engine;
        static volatile bool tried;
        // (the reader kept for a tap's words, and its own lock)
        static readonly object TapGate = new object();
        static volatile OcrEngine tapEngine;
        static volatile bool tapTried;

        public static string Language
        {
            get { var e = Engine(); return e == null ? "" : e.RecognizerLanguage.LanguageTag; }
        }

        public static OcrEngine Engine()
        {
            if (tried) return engine;
            lock (EngineGate)
            {
                if (!tried)
                {
                    try { engine = OcrEngine.TryCreateFromUserProfileLanguages(); } catch (Exception) { engine = null; }
                    tried = true;
                }
                return engine;
            }
        }

        /** The reader kept for taps' words (another of the same languages), or the shared one if
         *  Windows gives no second. */
        public static OcrEngine TapEngine()
        {
            if (tapTried) return tapEngine ?? Engine();
            lock (EngineGate)
            {
                if (!tapTried)
                {
                    if (Engine() != null)
                        try { tapEngine = OcrEngine.TryCreateFromUserProfileLanguages(); } catch (Exception) { tapEngine = null; }
                    tapTried = true;
                }
                return tapEngine ?? engine;
            }
        }

        /** A read the reader has not finished in this long is stuck (a whole window's takes well under a
         *  second, as a rule): it is given up, its reader retired (Retire) and a new one made for the next
         *  read, so one stuck read never holds every read after it. A tap's few words, sooner. */
        public const int READ_MS = 8000, TAP_READ_MS = 2000;
        /** A whole window's read waits this long at the most for the reader another whole window's read
         *  is using, then answers capture_failed (main's own wait for a read is 30 s). */
        public const int WHOLE_GATE_MS = 5000;

        /** A read given up as stuck (READ_MS). */
        public sealed class StuckException : Exception
        {
            public StuckException() : base("ocr stuck") { }
        }

        /** Selftest only: the next read that gets a reader hangs as a stuck one would, and is given up
         *  after this many ms (in place of READ_MS). 0: off. */
        public static int StallNextMs;
        /** How many readers were retired as stuck (the selftest's, and the log's). */
        public static int Retired;

        /** The reader `e` is retired: the next read asking for its kind gets a new one. */
        public static void Retire(OcrEngine e)
        {
            if (e == null) return;
            lock (EngineGate)
            {
                bool any = false;
                if (ReferenceEquals(engine, e)) { engine = null; tried = false; any = true; }
                if (ReferenceEquals(tapEngine, e)) { tapEngine = null; tapTried = false; any = true; }
                if (any) Interlocked.Increment(ref Retired);
            }
        }

        /** The result of `op`, waiting `ms` at the most: past it, `op` is cancelled, `e` retired and
         *  StuckException thrown. */
        public static T Wait<T>(IAsyncOperation<T> op, OcrEngine e, int ms)
        {
            // (not disposed when it is given up: the op may still finish later and set it)
            var done = new ManualResetEvent(false);
            op.Completed = delegate { try { done.Set(); } catch (ObjectDisposedException) { } };
            if (op.Status == AsyncStatus.Started && !done.WaitOne(ms))
            {
                try { op.Cancel(); } catch (Exception) { }
                Retire(e);
                Out.Log("ocr: a read stuck past " + ms + " ms was given up; a new reader is made");
                throw new StuckException();
            }
            done.Dispose();
            if (op.Status != AsyncStatus.Completed)
                throw new InvalidOperationException("ocr " + op.Status + (op.ErrorCode == null ? "" : ": " + op.ErrorCode.Message));
            return op.GetResults();
        }

        /** A stalled read (StallNextMs), given up as a stuck one is. */
        static void Stall(OcrEngine e, int ms)
        {
            using (var never = new ManualResetEvent(false)) never.WaitOne(ms);
            Retire(e);
            throw new StuckException();
        }

        /**
         * The lines of a picture, their boxes in screen pixels: `left`, `top` is where the picture's
         * top left is on the screen, and `scale` how many screen pixels one picture pixel stands for
         * (2 for a picture halved for a glance). It waits for the reader as long as another read holds
         * it, which is READ_MS at the most; a whole window's read for the app uses TryRead with
         * WHOLE_GATE_MS instead (Program.cs ReadWindow).
         */
        public static List<OcrLine> Read(Picture pic, int left, int top, double scale)
        {
            return TryRead(pic, left, top, scale, Timeout.Infinite);
        }

        /**
         * Read, waiting at most `waitMs` for the reader another read is using (a tap's verdict has a
         * budget, as on the Mac: TEXT_BUDGET_MS). Null when it stayed busy that long.
         */
        public static List<OcrLine> TryRead(Picture pic, int left, int top, double scale, int waitMs)
        {
            return TryRead(pic, left, top, scale, waitMs, false);
        }

        /** The same on the reader kept for taps (`tap`): it waits only for another tap's words. */
        public static List<OcrLine> TryRead(Picture pic, int left, int top, double scale, int waitMs, bool tap)
        {
            // (a read stuck past READ_MS throws StuckException: the caller answers as for any failed read)
            var lines = new List<OcrLine>();
            var e = tap ? TapEngine() : Engine();
            object gate = tap && tapEngine != null ? TapGate : Gate;
            if (e == null || pic == null || pic.W < 8 || pic.H < 8) return lines;
            int max = (int)OcrEngine.MaxImageDimension;
            while (pic.W > max || pic.H > max) { pic = Capture.Half(pic); scale *= 2; }
            OcrResult result;
            if (!Monitor.TryEnter(gate, waitMs)) return null;
            try
            {
                var bitmap = SoftwareBitmap.CreateCopyFromBuffer(CryptographicBuffer.CreateFromByteArray(pic.Bgra), BitmapPixelFormat.Bgra8, pic.W, pic.H, BitmapAlphaMode.Premultiplied);
                int stall = Interlocked.Exchange(ref StallNextMs, 0);
                if (stall > 0) Stall(e, stall);
                result = Wait(e.RecognizeAsync(bitmap), e, tap ? TAP_READ_MS : READ_MS);
            }
            finally { Monitor.Exit(gate); }
            foreach (var line in result.Lines)
            {
                var l = new OcrLine { T = line.Text };
                double x0 = double.MaxValue, y0 = double.MaxValue, x1 = double.MinValue, y1 = double.MinValue;
                foreach (var word in line.Words)
                {
                    Rect r = word.BoundingRect;
                    var w = new OcrWord
                    {
                        T = word.Text,
                        X = left + r.X * scale,
                        Y = top + r.Y * scale,
                        W = r.Width * scale,
                        H = r.Height * scale,
                    };
                    l.Words.Add(w);
                    x0 = Math.Min(x0, w.X); y0 = Math.Min(y0, w.Y);
                    x1 = Math.Max(x1, w.X + w.W); y1 = Math.Max(y1, w.Y + w.H);
                }
                if (l.Words.Count == 0) continue;
                l.X = x0; l.Y = y0; l.W = x1 - x0; l.H = y1 - y0;
                lines.Add(l);
            }
            return lines;
        }
    }
}
