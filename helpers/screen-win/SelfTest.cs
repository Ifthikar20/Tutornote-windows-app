// tutornote-screen.exe --selftest: the pure parts on made-up inputs, and Windows' text reader on
// words drawn here. Needs no window, no app and no permission. Prints ok or FAIL per check.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Tutornote.Screen
{
    public static class SelfTest
    {
        static int failed;

        static void Check(string name, bool ok)
        {
            Console.WriteLine((ok ? "ok   " : "FAIL ") + name);
            if (!ok) failed++;
        }

        static Look Flat(int w, int h, byte v)
        {
            var l = new Look(w, h);
            for (int i = 0; i < l.G.Length; i++) l.G[i] = v;
            return l;
        }

        public static int Run()
        {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);

            // Differences
            Look white = Flat(64, 40, 255), black = Flat(64, 40, 0);
            Check("the same look differs by 0", Diff.Mean(white, Flat(64, 40, 255)) == 0);
            Check("white and black differ by 255", Diff.Mean(white, black) == 255);
            Check("looks of another size count as changed", Diff.Mean(white, Flat(32, 40, 255)) == 255);
            Look topChanged = Flat(64, 40, 255);
            for (int y = 0; y < 4; y++) for (int x = 0; x < 64; x++) topChanged.G[y * 64 + x] = 0;
            Check("a bar fading at the top is no new look (middle rows)", Diff.Middle(white, topChanged) == 0);
            Check("but the whole look did change", Diff.Mean(white, topChanged) > Diff.CHANGED_ABOVE);
            Look caret = Flat(64, 40, 255);
            for (int y = 10; y < 30; y++) { caret.G[y * 64 + 20] = 0; caret.G[y * 64 + 21] = 0; }
            RECT box = Diff.ChangedBox(white, caret);
            Check("a caret's stroke is two pixels wide and twenty tall", box.Width == 2 && box.Height == 20);
            Check("the look away from the caret did not change", Diff.Away(white, caret, 15, 5, 12, 30) == 0);
            Check("a white page is light ground", Diff.Ground(white) == 1 && Diff.Ground(black) == 0);
            Check("a flat look is blank", Diff.Blank(white) && !Diff.Blank(caret));

            var p = new Picture(4, 2);
            for (int i = 0; i < p.Bgra.Length; i++) p.Bgra[i] = (byte)(i % 8 < 4 ? 200 : 100);
            Picture half = Capture.Half(p);
            Check("halving averages each 2x2 block", half.W == 2 && half.H == 1 && half.Bgra[0] == 150);

            // Apps, said as the shared rules know them
            Check("chrome.exe is Chrome", Apps.BundleFor("chrome.exe") == "com.google.Chrome");
            Check("msedge.exe is Edge", Apps.BundleFor("msedge.exe") == "com.microsoft.edgemac");
            Check("powerpnt.exe is PowerPoint", Apps.BundleFor("powerpnt.exe") == "com.microsoft.Powerpoint");
            Check("kindle.exe is a reader", Apps.BundleFor("kindle.exe") == "com.amazon.Kindle");
            Check("an app with no twin is win.<name>", Apps.BundleFor("foo.exe") == "win.foo");
            Check("password managers are private", Apps.IsPrivateExe("keepassxc.exe") && Apps.IsPrivateExe("1password.exe"));
            var edge = new AppInfo { Bundle = "com.microsoft.edgemac" };
            Check("an InPrivate window is private", Apps.PrivateTitle(edge, "New tab - [InPrivate] - Microsoft Edge"));
            Check("an ordinary tab is not", !Apps.PrivateTitle(edge, "Photosynthesis - Wikipedia - Microsoft Edge"));
            Check("a document called Incognito in Word is not a private window", !Apps.PrivateTitle(new AppInfo { Bundle = "com.microsoft.Word" }, "Incognito.docx - Word"));

            // JSON both ways
            var line = new Dictionary<string, object> { { "t", "Café 1–2" }, { "c", 1 }, { "x", 10.5 } };
            var back = Out.Parse(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(line));
            Check("a line goes to JSON and back, accents and dashes kept", (string)back["t"] == "Café 1–2" && J.Num(back, "x", 0) == 10.5);

            // Windows' text reader on words drawn here
            if (Ocr.Engine() == null) Console.WriteLine("skip Windows has no text reader for this account's languages");
            else
            {
                Picture drawn = Draw("Mitochondria turn glucose into energy", 900, 90);
                List<OcrLine> lines = Ocr.Read(drawn, 100, 200, 1);
                string all = string.Join(" ", lines.ConvertAll(l => l.T).ToArray());
                Check("the reader reads drawn words (" + Ocr.Language + ")", all.IndexOf("Mitochondria", StringComparison.OrdinalIgnoreCase) >= 0 && all.IndexOf("energy", StringComparison.OrdinalIgnoreCase) >= 0);
                Check("its boxes are placed on the screen (offset by the picture's corner)", lines.Count > 0 && lines[0].X >= 100 && lines[0].Y >= 200 && lines[0].Words.Count >= 4);
                Picture small = Capture.Half(drawn);
                List<OcrLine> glance = Ocr.Read(small, 0, 0, 2);
                Check("a halved glance still finds the line, boxes at full size", glance.Count > 0 && glance[0].W > drawn.W / 3);
            }

            Console.WriteLine(failed == 0 ? "all checks passed" : failed + " checks failed");
            return failed == 0 ? 0 : 1;
        }

        static Picture Draw(string text, int w, int h)
        {
            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                using (var font = new Font("Segoe UI", 28))
                {
                    g.Clear(Color.White);
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                    g.DrawString(text, font, Brushes.Black, 10, 15);
                }
                var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                var pic = new Picture(w, h);
                for (int y = 0; y < h; y++) Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), pic.Bgra, y * w * 4, w * 4);
                bmp.UnlockBits(data);
                return pic;
            }
        }
    }
}
