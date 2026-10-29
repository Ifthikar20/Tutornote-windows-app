// Windows' own text reader (Windows.Media.Ocr): on this PC, free, in the languages Windows has a
// reader for (Settings > Time & language > Language: each language's "optical character
// recognition" part). One picture at a time.
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

        public static T Wait<T>(IAsyncOperation<T> op)
        {
            using (var done = new ManualResetEvent(false))
            {
                op.Completed = delegate { done.Set(); };
                if (op.Status == AsyncStatus.Started) done.WaitOne();
                if (op.Status != AsyncStatus.Completed)
                    throw new InvalidOperationException("ocr " + op.Status + (op.ErrorCode == null ? "" : ": " + op.ErrorCode.Message));
                return op.GetResults();
            }
        }

        /**
         * The lines of a picture, their boxes in screen pixels: `left`, `top` is where the picture's
         * top left is on the screen, and `scale` how many screen pixels one picture pixel stands for
         * (2 for a picture halved for a glance).
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
            var lines = new List<OcrLine>();
            var e = Engine();
            if (e == null || pic == null || pic.W < 8 || pic.H < 8) return lines;
            int max = (int)OcrEngine.MaxImageDimension;
            while (pic.W > max || pic.H > max) { pic = Capture.Half(pic); scale *= 2; }
            OcrResult result;
            if (!Monitor.TryEnter(Gate, waitMs)) return null;
            try
            {
                var bitmap = SoftwareBitmap.CreateCopyFromBuffer(CryptographicBuffer.CreateFromByteArray(pic.Bgra), BitmapPixelFormat.Bgra8, pic.W, pic.H, BitmapAlphaMode.Premultiplied);
                result = Wait(e.RecognizeAsync(bitmap));
            }
            finally { Monitor.Exit(Gate); }
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
