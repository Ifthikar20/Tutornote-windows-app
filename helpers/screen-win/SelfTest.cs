// tutornote-screen.exe --selftest: the pure parts on made-up inputs, and Windows' text reader on
// words drawn here. Needs no window, no app and no permission. Prints ok or FAIL per check.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
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

            // A drag's stroke (circle to explain)
            var stroke = new List<POINT>();
            stroke = Watcher.DragAdd(stroke, new POINT(10, 10));
            stroke = Watcher.DragAdd(stroke, new POINT(11, 10));
            Check("a stroke keeps no point within 2 px of the last", stroke.Count == 1);
            for (int i = 1; i < 3000; i++) stroke = Watcher.DragAdd(stroke, new POINT(10 + i * 3, 10));
            Check("a long stroke is thinned, never cut short", stroke.Count < 1024 && stroke[stroke.Count - 1].X == 10 + 2999 * 3 && stroke[0].X == 10);
            List<int[]> lifted = Watcher.LiftPoints(stroke, 160);
            Check("a lift says 160 points at the most, its first and last among them",
                lifted.Count == 160 && lifted[0][0] == 10 && lifted[159][0] == 10 + 2999 * 3);
            Check("a short stroke is said whole", Watcher.LiftPoints(new List<POINT> { new POINT(1, 2), new POINT(3, 4) }, 160).Count == 2);
            string jpeg = Program.Jpeg(Flat2(40, 30), 82);
            byte[] jb = Convert.FromBase64String(jpeg);
            Check("a crop is a JPEG", jb.Length > 100 && jb[0] == 0xFF && jb[1] == 0xD8 && jb[2] == 0xFF);

            // Apps, said as the shared rules know them
            Check("chrome.exe is Chrome", Apps.BundleFor("chrome.exe") == "com.google.Chrome");
            Check("msedge.exe is Edge", Apps.BundleFor("msedge.exe") == "com.microsoft.edgemac");
            Check("powerpnt.exe is PowerPoint", Apps.BundleFor("powerpnt.exe") == "com.microsoft.Powerpoint");
            Check("kindle.exe is the Mac's page-turning Kindle", Apps.BundleFor("kindle.exe") == "com.amazon.Lassen");
            Check("an app with no twin is win.<name>", Apps.BundleFor("foo.exe") == "win.foo");
            Check("password managers are private", Apps.IsPrivateExe("keepassxc.exe") && Apps.IsPrivateExe("1password.exe"));
            var edge = new AppInfo { Bundle = "com.microsoft.edgemac" };
            Check("an InPrivate window is private", Apps.PrivateTitle(edge, "New tab - [InPrivate] - Microsoft Edge"));
            Check("an ordinary tab is not", !Apps.PrivateTitle(edge, "Photosynthesis - Wikipedia - Microsoft Edge"));
            Check("a document called Incognito in Word is not a private window", !Apps.PrivateTitle(new AppInfo { Bundle = "com.microsoft.Word" }, "Incognito.docx - Word"));

            // Tab titles, as the Mac's window list says a browser window's
            var chrome = new AppInfo { Bundle = "com.google.Chrome" };
            var firefox = new AppInfo { Bundle = "org.mozilla.firefox" };
            Check("Chrome's name leaves a PDF's title", Apps.TabTitle(chrome, "lecture 3.pdf - Google Chrome") == "lecture 3.pdf");
            var profiles = new List<string> { "Personal", "Work", "InPrivate" };
            Check("Edge's profile and name leave it", Apps.EdgeTitle("lecture 3.pdf - Personal - Microsoft​ Edge", profiles) == "lecture 3.pdf");
            Check("so does Edge's count of other tabs", Apps.EdgeTitle("Cells - Wikipedia and 2 more pages - Work - Microsoft​ Edge", profiles) == "Cells - Wikipedia");
            Check("Edge with no profile", Apps.EdgeTitle("Notes.pdf - Microsoft Edge", profiles) == "Notes.pdf");
            Check("a tab title's own last part is no profile", Apps.EdgeTitle("Cells - Wikipedia - Microsoft​ Edge", profiles) == "Cells - Wikipedia");
            Check("nor is a PDF's name after a dash", Apps.EdgeTitle("Chapter 3 - Cells.pdf - Microsoft​ Edge", profiles) == "Chapter 3 - Cells.pdf");
            Check("a title not in Edge's form is left as it is", Apps.EdgeTitle("Downloads", profiles) == "Downloads");
            Check("Firefox's name leaves it", Apps.TabTitle(firefox, "Week 4 slides - Google Slides — Mozilla Firefox") == "Week 4 slides - Google Slides");
            Check("a title's own dashes stay", Apps.TabTitle(chrome, "Cells - Wikipedia - Google Chrome") == "Cells - Wikipedia");
            Check("any other app's title is as Windows has it", Apps.TabTitle(new AppInfo { Bundle = "com.microsoft.Word" }, "Essay.docx - Word") == "Essay.docx - Word");

            // Tap verdicts (the Mac's verdict table, by pixels)
            bool acted;
            Check("an unchanged line is skipped, not acted", Watcher.Verdict(1, false, false, true, 0.2, 0, 0, 0, 1.5, null, out acted) == "skipped" && !acted);
            Check("even with a video playing elsewhere in the window", Watcher.Verdict(1, false, false, true, 0.2, 40, 0, 0, 1.5, null, out acted) == "skipped" && !acted);
            Check("a double click selects", Watcher.Verdict(2, false, false, true, 30, 30, 50, 20, 1.5, null, out acted) == "select" && acted);
            Check("a menu over the tap covers it", Watcher.Verdict(1, true, false, true, 0, 0, 0, 0, 1.5, null, out acted) == "covered" && acted);
            Check("a new title is the click's doing", Watcher.Verdict(1, false, true, true, 0, 0, 0, 0, 1.5, null, out acted) == "title" && acted);
            Check("a caret's thin stroke acted", Watcher.Verdict(1, false, false, true, 3, 0, 2, 22, 1.5, null, out acted) == "caret" && acted);
            Check("the line and the page around it changed: content", Watcher.Verdict(1, false, false, true, 20, 9, 200, 30, 1.5, null, out acted) == "content" && acted);
            Check("a faint change of the line alone is no click (a hover)", Watcher.Verdict(1, false, false, true, 2.5, 0.3, 120, 20, 1.5, null, out acted) == "pixels" && !acted);
            Check("a private window is never pictured, never acted", Watcher.Verdict(1, false, false, false, 0, 0, 0, 0, 1.5, null, out acted) == "pixels" && !acted);
            Check("a changed line whose words stayed: pointing at them (a selection or highlight)", Watcher.Verdict(1, false, false, true, 32, 0.9, 400, 30, 1.5, "kept", out acted) == "kept" && !acted);
            Check("words that stayed while the page around them changed: content (a tab)", Watcher.Verdict(1, false, false, true, 32, 9, 400, 30, 1.5, "kept", out acted) == "content" && acted);
            Check("words that went: the click did something", Watcher.Verdict(1, false, false, true, 32, 0.9, 400, 30, 1.5, "gone", out acted) == "gone" && acted);
            if (Ocr.Engine() != null)
            {
                const string said = "Mitochondria turn glucose into energy";
                Picture was = Draw(said, 900, 90);
                Picture marked = Paint(900, 90, delegate (Graphics g)
                {
                    using (var mark = new SolidBrush(Color.FromArgb(255, 255, 236, 140))) g.FillRectangle(mark, 0, 10, 900, 70);
                    using (var font = new Font("Segoe UI", 28)) g.DrawString(said, font, Brushes.Black, 10, 15);
                });
                Picture other = Draw("Chloroplasts capture light for plants", 900, 90);
                double share;
                Check("the same words with a highlight behind them are kept", Watcher.TapText(was, marked, 40, out share) == "kept" && share >= 0.6);
                Check("other words where the tap was: gone", Watcher.TapText(was, other, 40, out share) == "gone");
                Check("no words at the tap: none", Watcher.TapText(Paint(900, 90, delegate (Graphics g) { }), was, 40, out share) == "none");
            }

            // The primary button, swapped for a left-handed student
            ushort down, up;
            Input.PrimaryFlags(false, out down, out up);
            Check("the primary button is the left one", down == Win32.RI_MOUSE_LEFT_DOWN && up == Win32.RI_MOUSE_LEFT_UP);
            Input.PrimaryFlags(true, out down, out up);
            Check("and the right one with the buttons swapped", down == Win32.RI_MOUSE_RIGHT_DOWN && up == Win32.RI_MOUSE_RIGHT_UP);

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

            AnswerLines();
            WheelsAndKeys();
            if (Ocr.Engine() != null) PageDrawing();

            Console.WriteLine(failed == 0 ? "all checks passed" : failed + " checks failed");
            return failed == 0 ? 0 : 1;
        }

        // A wheel's step, and the keys that burst a window (the Mac's selftest, on made up numbers)
        static void WheelsAndKeys()
        {
            Watcher.WheelStep notch = Watcher.Wheel(-120, false, 100, 3);
            Check("a notch down the document is 100 points up, said as 3 lines", notch.Dy == 100 && notch.Dx == 0 && notch.Lines == 3 && notch.Scrolls);
            Check("a notch back up is 3 lines the other way", Watcher.Wheel(120, false, 100, 3).Lines == -3);
            Check("half a notch of a fine wheel is half as far", Watcher.Wheel(-60, false, 100, 3).Dy == 50 && Watcher.Wheel(-60, false, 100, 3).Lines == 1.5);
            Watcher.WheelStep pan = Watcher.Wheel(120, true, 100, 3);
            Check("a sideways wheel is said, with no lines, and is no scroll up or down", pan.Dx == 100 && pan.Dy == 0 && pan.Lines == 0 && !pan.Scrolls);
            Check("a wheel event that moved nothing is no scroll", !Watcher.Wheel(0, false, 100, 3).Scrolls);
            Check("a scroll just before a new look explains it", Watcher.ScrollExplains(10200, 10000, false));
            Check("a scroll 2 s before does not", !Watcher.ScrollExplains(12000, 10000, false));
            Check("no scroll explains nothing", !Watcher.ScrollExplains(10000, -1, false));
            Check("a scroll explains nothing in a window that turns by the page", !Watcher.ScrollExplains(10200, 10000, true));

            Check("a key 100 ms ago in the window's app bursts it", Watcher.KeyBurstDue(100, 678, 678));
            Check("not one pressed in another app", !Watcher.KeyBurstDue(100, 679, 678));
            Check("nor one 500 ms ago", !Watcher.KeyBurstDue(500, 678, 678));
            Check("nor with the window's app not known", !Watcher.KeyBurstDue(100, 678, 0));
            Check("nor with no app in front", !Watcher.KeyBurstDue(100, 0, 678));
            Check("the first key is said", Watcher.KeyRunStarts(10000, -1));
            // A key held down: the first press, then its repeats every 50 ms after a 400 ms wait.
            int told = 0;
            long last = -1;
            foreach (long keyAt in new long[] { 10000, 10400, 10450, 10500, 10550, 10600, 10650, 10700, 10750 })
                if (Watcher.KeyRunStarts(keyAt, last)) { told++; last = keyAt; }
            Check("a key held down is said again while it is held", told == 3);
            Check("the same key seen on the next tick is not said again", !Watcher.KeyRunStarts(10600, 10600));
            Check("a key while a lesson's turn by a key goes on is ours", Watcher.KeyIsOurs(10000, 1, -1));
            Check("so is one that went down before that turn ended", Watcher.KeyIsOurs(10000, 0, 10500));
            Check("not one after it ended", !Watcher.KeyIsOurs(11000, 0, 10500));
            Check("nor one with no turn by a key ever", !Watcher.KeyIsOurs(10000, 0, -1));

            Check("a window that takes no activation keeps the rest of its style", Win32.WithNoActivate(0x00280008) == 0x08280008 && Win32.WithNoActivate(0x08000000) == 0x08000000);

            // A key is the last input no mouse event explains (never which key: none is listened to).
            Check("input with no mouse event near it is a key", Input.NoMouseExplains(1000, 500, 1100));
            Check("input the mouse explains is not", !Input.NoMouseExplains(1000, 990, 1100));
            Check("nor one so new a mouse event may still be on its way", !Input.NoMouseExplains(1000, 500, 1010));
            Check("nor one a minute old", !Input.NoMouseExplains(1000, 500, 70000));
            Check("the clock wrapping changes nothing", Input.NoMouseExplains(10, 0xFFFFFF00u, 110));
        }

        // The page's paper and ink (Geometry.cs), the Mac's geometrySelfTest on windows drawn here and
        // read by Windows' reader: a page with two paragraphs of made up words, a 200 point rule under
        // the first, a filled box between them, and under it the top of the next page (no words).
        static void PageDrawing()
        {
            string[] list = "river market garden window paper candle silver morning yellow travel kitchen pencil orange thunder".Split(' ');
            var rows = new string[12];
            var baselines = new float[12];
            for (int i = 0; i < 12; i++)
            {
                var w = new string[6];
                for (int k = 0; k < 6; k++) w[k] = list[(i * 5 + k * 3) % list.Length];
                rows[i] = string.Join(" ", w);
                baselines[i] = (i < 6 ? 110 : 364) + i * 26;
            }
            RectangleF page = new RectangleF(150, 40, 500, 900), next = new RectangleF(150, 960, 500, 40);
            RectangleF rule = new RectangleF(200, 262, 200, 1), box = new RectangleF(220, 320, 160, 120);

            Func<int, int, int, RectangleF[], RectangleF?, double, Picture> picture = (viewer, paper, ink, pages, bar, scale) =>
                Paint((int)(800 * scale), (int)(1000 * scale), g =>
                {
                    g.ScaleTransform((float)scale, (float)scale);
                    g.Clear(Color.FromArgb(viewer, viewer, viewer));
                    using (var paperBrush = new SolidBrush(Color.FromArgb(paper, paper, paper)))
                    using (var inkBrush = new SolidBrush(Color.FromArgb(ink, ink, ink)))
                    using (var font = new Font("Georgia", 16, GraphicsUnit.Pixel))
                    {
                        foreach (RectangleF p in pages) g.FillRectangle(paperBrush, p);
                        if (bar.HasValue) g.FillRectangle(paperBrush, bar.Value);
                        g.FillRectangle(inkBrush, rule);
                        g.FillRectangle(inkBrush, box);
                        for (int i = 0; i < 12; i++) g.DrawString(rows[i], font, inkBrush, 200, baselines[i] - 18);
                        if (bar.HasValue) g.DrawString("Reading notes", font, inkBrush, 40, 8);
                    }
                });
            Func<RectangleF, double, double, RECT> on = (r, s, unused) => new RECT
            {
                Left = (int)Math.Round((100 + r.X) * s), Top = (int)Math.Round((50 + r.Y) * s),
                Right = (int)Math.Round((100 + r.Right) * s), Bottom = (int)Math.Round((50 + r.Bottom) * s),
            };
            Func<int, int, RECT, bool> near = (a, b, unused) => Math.Abs(a - b) <= 2;

            Action<string, Picture, double> checkPage = (what, pic, scale) =>
            {
                int left = (int)(100 * scale), top = (int)(50 * scale);
                List<OcrLine> lines = Ocr.Read(pic, left, top, 1);
                PageGeometry g = Geometry.Of(pic, left, top, scale, lines);
                Check(what + ": the reader reads its 12 rows", lines.FindAll(l => Geometry.HasLetterOrDigit(l.T)).Count == 12);
                if (g == null) { Check(what + ": its geometry is told", false); return; }
                RECT want = on(page, scale, 0);
                Check(what + ": the page's rectangle is told within 2 pixels, not the next page's",
                    g.HasPaper && near(g.PaperX, want.Left, want) && near(g.PaperY, want.Top, want) && near(g.PaperX + g.PaperW, want.Right, want) && near(g.PaperY + g.PaperH, want.Bottom, want));
                Check(what + ": the grid lies over the paper told, in cells of 8 points", g.Ink.X == g.PaperX && g.Ink.Y == g.PaperY
                    && g.Ink.Cell == (int)Math.Round(8 * scale) && g.Ink.Cols == (g.PaperW + g.Ink.Cell - 1) / g.Ink.Cell && g.Ink.Rows == (g.PaperH + g.Ink.Cell - 1) / g.Ink.Cell);
                RECT boxOn = on(box, scale, 0), ruleOn = on(rule, scale, 0);
                ruleOn.Left -= 1; ruleOn.Right += 1; ruleOn.Top -= 2; ruleOn.Bottom += 2;
                int inside = 0, insideInked = 0, stray = 0, overWords = 0;
                for (int r = 0; r < g.Ink.Rows; r++)
                    for (int c = 0; c < g.Ink.Cols; c++)
                    {
                        int x = g.Ink.X + c * g.Ink.Cell, y = g.Ink.Y + r * g.Ink.Cell, cell = g.Ink.Cell;
                        bool inked = g.Ink.Inked(c, r);
                        if (x >= boxOn.Left && y >= boxOn.Top && x + cell <= boxOn.Right && y + cell <= boxOn.Bottom) { inside++; if (inked) insideInked++; }
                        if (!inked) continue;
                        bool onBox = x < boxOn.Right && x + cell > boxOn.Left && y < boxOn.Bottom && y + cell > boxOn.Top;
                        bool onRule = x < ruleOn.Right && x + cell > ruleOn.Left && y < ruleOn.Bottom && y + cell > ruleOn.Top;
                        if (onBox || onRule) continue;
                        stray++;
                        foreach (OcrLine l in lines) foreach (OcrWord w in l.Words) if (x < w.X + w.W && x + cell > w.X && y < w.Y + w.H && y + cell > w.Y) overWords++;
                    }
                Check(what + ": the filled box sets every cell inside it", inside > 0 && insideInked == inside);
                Check(what + ": nothing else is inked, and the cells over the words stay clear", stray == 0 && overWords == 0);
                List<Rule> ruled = Rules.Of(pic, left, top, scale, lines, Diff.Ground(Capture.Grey(pic))).FindAll(r => Geometry.OnPaper(r, g));
                Dictionary<string, object> sent = ruled.Count == 1 ? Geometry.RuleBox(ruled[0]) : null;
                Check(what + ": the 200 point rule is found, as a thin rect, and the words and the box are not", sent != null
                    && Math.Abs(J.Num(sent, "x", 0) - on(rule, scale, 0).Left) <= 2 && Math.Abs(J.Num(sent, "y", 0) - on(rule, scale, 0).Top) <= 2
                    && Math.Abs(J.Num(sent, "w", 0) - 200 * scale) <= 2 && J.Num(sent, "h", 0) >= 1 && J.Num(sent, "h", 0) <= 3 * scale);
            };

            var both = new[] { page, next };
            Picture white = picture(153, 255, 26, both, null, 1);
            checkPage("a white page on a grey viewer", white, 1);
            List<OcrLine> whiteLines = Ocr.Read(white, 100, 50, 1);
            PageGeometry told = Geometry.Of(white, 100, 50, 1, whiteLines);
            if (told != null)
            {
                var fields = new Dictionary<string, object>();
                Geometry.Fields(told, fields);
                var ink = (Dictionary<string, object>)fields["ink"];
                byte[] bytes = Convert.FromBase64String((string)ink["bits"]);
                bool same = (int)ink["cell"] == 8 && (int)ink["cols"] == told.Ink.Cols && (int)ink["rows"] == told.Ink.Rows;
                for (int i = 0; i < told.Ink.Cols * told.Ink.Rows; i++)
                    if (((bytes[i >> 3] & (1 << (i & 7))) != 0) != told.Ink.Inked(i % told.Ink.Cols, i / told.Ink.Cols)) same = false;
                Check("the grid goes as base64, cell r * cols + c at bit (i & 7) of byte i >> 3", same);
            }
            // A night theme: a dark page, light words and marks, on a dark grey viewer.
            checkPage("a dark page", picture(84, 31, 230, both, null, 1), 1);
            // A window at 150%: every number scales.
            checkPage("a white page at 150%", picture(153, 255, 26, both, null, 1.5), 1.5);
            // Kindle's way: the page fills the window.
            Picture fills = picture(255, 255, 26, new RectangleF[0], null, 1);
            PageGeometry filling = Geometry.Of(fills, 100, 50, 1, Ocr.Read(fills, 100, 50, 1));
            Check("a page that fills the window has no paper told, and its grid covers the window",
                filling != null && !filling.HasPaper && filling.Ink.X == 100 && filling.Ink.Y == 50 && filling.Ink.Cols == 100 && filling.Ink.Rows == 125);
            // A browser's white tab strip over its dark PDF viewer: no part of the page.
            RectangleF below = new RectangleF(150, 92, 500, 888);
            Picture barred = picture(84, 255, 26, new[] { below }, new RectangleF(0, 0, 800, 80), 1);
            PageGeometry bars = Geometry.Of(barred, 100, 50, 1, Ocr.Read(barred, 100, 50, 1));
            Check("under a browser's white bars, the page's rectangle is told, not the window's width",
                bars != null && bars.HasPaper && Math.Abs(bars.PaperX - 250) <= 2 && Math.Abs(bars.PaperW - 500) <= 2 && Math.Abs(bars.PaperY - 142) <= 2);
            // A page with no one ground: nothing of it is sent.
            Picture speckle = Paint(400, 200, g =>
            {
                var noise = new Random(7);
                for (int y = 0; y < 200; y += 4) for (int x = 0; x < 400; x += 4)
                    using (var b = new SolidBrush(Color.FromArgb(noise.Next(256), noise.Next(256), noise.Next(256)))) g.FillRectangle(b, x, y, 4, 4);
            });
            var made = new List<OcrLine> { new OcrLine { T = "words", X = 10, Y = 10, W = 300, H = 120 } };
            Check("words on no one ground: no geometry", Geometry.Of(speckle, 0, 0, 1, made) == null);
        }

        // Answer lines (Rules.cs), on worksheets drawn here at 100% and at 150%
        static void AnswerLines()
        {
            const string QUESTION = "1. Solve 2x + 3 = 11", LINKED = "See the worked example", STRUCK = "an old answer";
            Picture sheet = Sheet(1);
            List<OcrLine> inked = SheetLines(1);
            List<Rule> found = Rules.Of(sheet, 0, 0, 1, inked);
            Rule answer = Near(found, 80.5, 1);
            Check("a drawn answer line under printed text is found", answer != null && answer.X0 == 40 && answer.X1 == 560);
            Check("so is a leader drawn as a rule after a word (Name ______)", Near(found, 194.5, 1) != null && Near(found, 194.5, 1).X0 == 110);
            Check("and nothing else on the sheet (words, an underline, a bar, a box)", found.Count == 2);
            Rule placed = Near(Rules.Of(sheet, 100, 200, 1, Shifted(inked, 100, 200)), 280.5, 1);
            Check("the lines are placed on the screen (offset by the picture's corner)", placed != null && placed.X0 == 140 && placed.X1 == 660);

            Picture words = Paint(640, 160, delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 16f, GraphicsUnit.Pixel))
                    for (int i = 0; i < 4; i++) g.DrawString("Plants turn light, water and carbon dioxide into glucose and oxygen.", font, Brushes.Black, 10, 10 + 34 * i);
            });
            Check("a printed line of words is not", Rules.In(words, Rules.MinRunAt(1), Rules.ThickAt(1)).Count == 0);

            Action<Graphics> underlined = delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 20f, FontStyle.Underline, GraphicsUnit.Pixel)) g.DrawString(LINKED, font, Brushes.Black, 40, 20);
            };
            Picture link = Paint(640, 80, underlined);
            List<OcrLine> linkLine = new List<OcrLine> { Inked(Paint(640, 80, delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 20f, GraphicsUnit.Pixel)) g.DrawString(LINKED, font, Brushes.Black, 40, 20);
            }), LINKED) };
            Check("underlined words: a line is under them", Rules.In(link, Rules.MinRunAt(1), Rules.ThickAt(1)).Count == 1);
            Check("but it is the words' own, and not an answer line", Rules.Of(link, 0, 0, 1, linkLine).Count == 0);
            Picture struck = Paint(640, 80, delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 24f, FontStyle.Strikeout, GraphicsUnit.Pixel)) g.DrawString(STRUCK, font, Brushes.Black, 40, 20);
            });
            List<OcrLine> struckLine = new List<OcrLine> { Inked(Paint(640, 80, delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 24f, GraphicsUnit.Pixel)) g.DrawString(STRUCK, font, Brushes.Black, 40, 20);
            }), STRUCK) };
            Check("struck words: the strike is a line, but the words' own", Rules.In(struck, Rules.MinRunAt(1), Rules.ThickAt(1)).Count == 1 && Rules.Of(struck, 0, 0, 1, struckLine).Count == 0);
            var asLine = new OcrLine { T = "Name ______", X = 40, Y = 180, W = 520, H = 18 };
            asLine.Words.Add(new OcrWord { T = "Name", X = 40, Y = 180, W = 50, H = 18 });
            asLine.Words.Add(new OcrWord { T = "______", X = 110, Y = 186, W = 450, H = 12 });
            Check("a line the reader read as underscores is still the page's", Near(Rules.Of(sheet, 0, 0, 1, new List<OcrLine> { asLine }), 194.5, 1) != null);
            asLine.Words[1].T = new string((char)0x2014, 8);
            Check("and as a dash leader (em dashes)", Near(Rules.Of(sheet, 0, 0, 1, new List<OcrLine> { asLine }), 194.5, 1) != null);
            asLine.Words[1].T = "answer";
            Check("but under a word that is no line, it is the word's underline", Near(Rules.Of(sheet, 0, 0, 1, new List<OcrLine> { asLine }), 194.5, 1) == null);

            Picture grey = Paint(800, 340, delegate (Graphics g)
            {
                using (var ground = new SolidBrush(Color.FromArgb(0x52, 0x56, 0x59))) g.FillRectangle(ground, 0, 0, 800, 340);
                g.FillRectangle(Brushes.White, 80, 0, 640, 340);
                g.TranslateTransform(80, 0);
                SheetWords(g, 1, false);
                SheetMarks(g, 1);
            });
            List<Rule> onGrey = Rules.Of(grey, 0, 0, 1, Shifted(inked, 80, 0));
            Check("a page in a dark grey ground (Chrome's around a PDF): its lines still found, the ground not",
                onGrey.Count == 2 && Near(onGrey, 80.5, 1) != null && Near(onGrey, 80.5, 1).X0 == 120 && Near(onGrey, 80.5, 1).X1 == 640);
            Picture twoInARow = Paint(640, 60, delegate (Graphics g)
            {
                g.FillRectangle(Brushes.Black, 40, 30, 250, 2);
                g.FillRectangle(Brushes.Black, 340, 30, 250, 2);
            });
            Check("two lines in one row (Name ____ Date ____) are two", Rules.Of(twoInARow, 0, 0, 1, null).Count == 2);

            Picture bars = Paint(640, 240, delegate (Graphics g)
            {
                g.FillRectangle(Brushes.Black, 40, 20, 520, 10);
                g.FillRectangle(Brushes.Black, 40, 60, 520, 4);
                g.FillRectangle(Brushes.DimGray, 40, 100, 200, 120);
            });
            Check("a thick bar or a filled box is not", Rules.Of(bars, 0, 0, 1, null).Count == 0);
            Picture bridged = Paint(600, 120, delegate (Graphics g)
            {
                g.FillRectangle(Brushes.Black, 0, 0, 100, 50);
                g.FillRectangle(Brushes.Black, 200, 0, 100, 50);
                g.FillRectangle(Brushes.Black, 50, 50, 200, 2);
                g.FillRectangle(Brushes.Black, 260, 50, 140, 2);
            });
            Check("one dark shape (two blocks a run joins, a run under the second) has no line in it", Rules.In(bridged, Rules.MinRunAt(1), Rules.ThickAt(1)).Count == 0);

            // (dotted and dashed: the founder's "dash or line", drawn with a pen or typed)
            List<Rule> pens = Rules.Of(PenSheet(1), 0, 0, 1, null);
            Rule dots = Near(pens, 90, 1), dashes = Near(pens, 190, 1);
            Check("a dotted line under a question is found, end to end", dots != null && Math.Abs(dots.X0 - 40) <= 2 && Math.Abs(dots.X1 - 700) <= 3);
            Check("so is a dashed one", dashes != null && Math.Abs(dashes.X0 - 40) <= 2 && Math.Abs(dashes.X1 - 700) <= 3 && pens.Count == 2);
            List<Rule> bigPens = Rules.Of(PenSheet(1.5), 0, 0, 1.5, null);
            bool samePens = bigPens.Count == pens.Count;
            for (int i = 0; samePens && i < pens.Count; i++)
                samePens = Math.Abs(bigPens[i].X0 - pens[i].X0 * 1.5) <= 4 && Math.Abs(bigPens[i].X1 - pens[i].X1 * 1.5) <= 4 && Math.Abs(bigPens[i].Y - pens[i].Y * 1.5) <= 1.5;
            Check("the same at 150%: the same lines, in pixels x1.5", samePens);
            Picture typed = Paint(900, 160, delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 20f, GraphicsUnit.Pixel))
                {
                    g.DrawString("Name ........................................................", font, Brushes.Black, 40, 20);
                    g.DrawString("Answer - - - - - - - - - - - - - - - - - - - - - -", font, Brushes.Black, 40, 90);
                }
            });
            OcrLine label = Inked(Paint(900, 160, delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 20f, GraphicsUnit.Pixel)) g.DrawString("Name", font, Brushes.Black, 40, 20);
            }), "Name");
            List<Rule> leaders = Rules.In(typed, Rules.MinRunAt(1), Rules.ThickAt(1));
            Check("typed dots after a word (Name ......) are a line, from past the word", leaders.Count == 2 && leaders[0].X0 > label.X + label.W && leaders[0].X1 - leaders[0].X0 > 200);
            Check("and typed spaced dashes (Answer - - - -)", leaders.Count == 2 && leaders[1].Y > 100 && leaders[1].X1 - leaders[1].X0 > 250);
            int dotted = 0;
            foreach (string face in new[] { "Segoe UI", "Calibri", "Arial", "Times New Roman", "Georgia" })
                foreach (float size in new[] { 12f, 14f, 16f, 20f })
                    dotted += Rules.In(Paint(1300, (int)(size * 8), delegate (Graphics g)
                    {
                        using (var font = new Font(face, size, GraphicsUnit.Pixel))
                            for (int i = 0; i < Dotty.Length; i++) g.DrawString(Dotty[i], font, Brushes.Black, 10, 10 + i * size * 1.25f);
                    }), Rules.MinRunAt(1), Rules.ThickAt(1)).Count;
            Check("words in five faces at four sizes make no line (i's dots, accents, colons, equals signs)", dotted == 0);

            // (a dark page: its lines are light, and its own ground between its letters is no line)
            Picture dark = Paint(900, 160, delegate (Graphics g)
            {
                using (var ground = new SolidBrush(Color.FromArgb(0x1E, 0x1E, 0x1E))) g.FillRectangle(ground, 0, 0, 900, 160);
                using (var font = new Font("Segoe UI", 20f, GraphicsUnit.Pixel)) g.DrawString(QUESTION, font, Brushes.White, 40, 20);
                g.FillRectangle(Brushes.White, 40, 90, 520, 2);
                using (var dot = new Pen(Color.White, 1.5f) { DashStyle = DashStyle.Dot }) g.DrawLine(dot, 40, 130, 560, 130);
            });
            double darkGround = Diff.Ground(Capture.Grey(dark));
            List<Rule> onDark = Rules.Of(dark, 0, 0, 1, null, darkGround);
            Check("a dark page (ground " + darkGround + "): its light answer line and dotted line are found",
                darkGround < Rules.DARK_GROUND && onDark.Count == 2 && Near(onDark, 90.5, 1) != null && Near(onDark, 90.5, 1).X0 == 40 && Near(onDark, 90.5, 1).X1 == 560 && Near(onDark, 130, 1) != null);
            Check("but a light page is not looked over for light lines", Rules.Of(dark, 0, 0, 1, null, 1).Count == 0);
            Picture darkWords = Inverted(words);
            Check("a dark page's ground between its light letters is no line", Rules.Of(darkWords, 0, 0, 1, null, Diff.Ground(Capture.Grey(darkWords))).Count == 0);

            Picture big = Sheet(1.5);
            List<Rule> bigFound = Rules.Of(big, 0, 0, 1.5, SheetLines(1.5));
            bool same = bigFound.Count == found.Count;
            for (int i = 0; same && i < found.Count; i++)
                same = Math.Abs(bigFound[i].X0 - found[i].X0 * 1.5) <= 2 && Math.Abs(bigFound[i].X1 - found[i].X1 * 1.5) <= 2 && Math.Abs(bigFound[i].Y - found[i].Y * 1.5) <= 1.5;
            Check("the same sheet at 150% finds the same lines, in pixels x1.5", same);
            Check("a line 3 pixels thick is a line; 4 is not at 100%, but is at 150%",
                Rules.In(Paint(640, 40, delegate (Graphics g) { g.FillRectangle(Brushes.Black, 40, 10, 520, 3); }), Rules.MinRunAt(1), Rules.ThickAt(1)).Count == 1 &&
                Rules.In(Paint(640, 40, delegate (Graphics g) { g.FillRectangle(Brushes.Black, 40, 10, 520, 4); }), Rules.MinRunAt(1), Rules.ThickAt(1)).Count == 0 &&
                Rules.In(Paint(640, 40, delegate (Graphics g) { g.FillRectangle(Brushes.Black, 40, 10, 520, 4); }), Rules.MinRunAt(1.5), Rules.ThickAt(1.5)).Count == 1);

            // (words with no tall or long letters: the reader boxes them as short as their x-height,
            // here "resources" in Calibri 16 px as it read it, and their underline sits under that box)
            var xHeight = new OcrLine { T = "resources", X = 42, Y = 28, W = 55, H = 7 };
            xHeight.Words.Add(new OcrWord { T = "resources", X = 42, Y = 28, W = 55, H = 7 });
            Check("an underline just under an x-height box is still the words' own", Rules.UnderWords(new Rule { X0 = 42, X1 = 99, Y = 37 }, new List<OcrLine> { xHeight }));
            Check("but a line a line's height under it is not", !Rules.UnderWords(new Rule { X0 = 42, X1 = 99, Y = 46 }, new List<OcrLine> { xHeight }));

            // (with Windows' text reader's own lines, as a read has them)
            if (Ocr.Engine() != null)
            {
                List<OcrLine> read = Ocr.Read(sheet, 0, 0, 1);
                List<Rule> withReader = Rules.Of(sheet, 0, 0, 1, read);
                Check("with the reader's lines: the answer line and the leader, not the underline",
                    read.Count >= 2 && Near(withReader, 80.5, 1) != null && Near(withReader, 194.5, 1) != null && withReader.Count == 2);
                Picture links = Paint(1200, 700, delegate (Graphics g)
                {
                    using (var font = new Font("Segoe UI", 16f, GraphicsUnit.Pixel))
                        for (int i = 0; i < 6; i++)
                        {
                            g.DrawString("Plants turn light, water and carbon dioxide into glucose and oxygen.", font, Brushes.Black, 40, 40 + 30 * i);
                            g.DrawString("The process happens in the chloroplasts, mostly in the leaves.", font, Brushes.Black, 40, 480 + 30 * i);
                        }
                    using (var font = new Font("Calibri", 16f, FontStyle.Underline, GraphicsUnit.Pixel)) g.DrawString("resources", font, Brushes.Black, 40, 240);
                    using (var font = new Font("Calibri", 14f, FontStyle.Underline, GraphicsUnit.Pixel)) g.DrawString("resources", font, Brushes.Black, 40, 300);
                    using (var font = new Font("Segoe UI", 16f, FontStyle.Underline, GraphicsUnit.Pixel)) g.DrawString("more resources", font, Brushes.Black, 40, 360);
                    using (var font = new Font("Times New Roman", 20f, FontStyle.Underline, GraphicsUnit.Pixel)) g.DrawString("answers", font, Brushes.Black, 40, 420);
                });
                Check("with the reader's lines: x-height words' underlines are the words' own (Calibri, Segoe UI, Times)",
                    Rules.In(links, Rules.MinRunAt(1), Rules.ThickAt(1)).Count == 4 && Rules.Of(links, 0, 0, 1, Ocr.Read(links, 0, 0, 1)).Count == 0);
                List<Rule> typedRead = Rules.Of(typed, 0, 0, 1, Ocr.Read(typed, 0, 0, 1));
                Check("with the reader's lines: the typed dots and dashes are still the page's", typedRead.Count == 2);
            }

            // (the time it adds to a read: a full window's picture, best of three)
            Picture screenful = Paint(2560, 1440, delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 20f, GraphicsUnit.Pixel))
                    for (int i = 0; i < 40; i++)
                    {
                        g.DrawString(QUESTION + "  Plants turn light, water and carbon dioxide into glucose and oxygen.", font, Brushes.Black, 60, 20 + 35 * i);
                        if (i % 4 == 3) g.FillRectangle(Brushes.Black, 60, 48 + 35 * i, 1400, 2);
                    }
            });
            long best = long.MaxValue;
            int lines = 0;
            for (int k = 0; k < 3; k++)
            {
                var watch = System.Diagnostics.Stopwatch.StartNew();
                lines = Rules.Of(screenful, 0, 0, 1, null).Count;
                best = Math.Min(best, watch.ElapsedMilliseconds);
            }
            Check("a 2560x1440 picture's answer lines in " + best + " ms (under 150), all 10 found", best < 150 && lines == 10);
            Picture darkScreen = Inverted(screenful);
            double darkScreenGround = Diff.Ground(Capture.Grey(darkScreen));
            best = long.MaxValue;
            for (int k = 0; k < 3; k++)
            {
                var watch = System.Diagnostics.Stopwatch.StartNew();
                lines = Rules.Of(darkScreen, 0, 0, 1, null, darkScreenGround).Count;
                best = Math.Min(best, watch.ElapsedMilliseconds);
            }
            Check("and as a dark page (light lines and dark looked for) in " + best + " ms (under 150), all 10 found", best < 150 && lines == 10);
        }

        /** Lines of words with what a dotted line could be taken for in them: i's dots, accents,
         *  colons, equals signs. */
        static readonly string[] Dotty =
        {
            "Mississippi: minimizing initiation, inhibiting divisibility; visibility infinitesimally.",
            "Naïve café résumé: déjà vu, über façade; Zürich Ålesund. Hawaiian skiing in Fiji and Iliad.",
            "1. Solve 2x + 3 = 11, so x = 4; y = 2x = 8 and a = b = c: ratio 3:4:5 is 6:8:10 again.",
            "Plants turn light, water and carbon dioxide into glucose and oxygen in their chloroplasts.",
            "summer sessions; seemingly unnecessary emissions, sea snails, mummies, swimming, assessments",
        };

        /** A question with a dotted line under it, another with a dashed one, at `s` times their size. */
        static Picture PenSheet(double s)
        {
            return Paint((int)(900 * s), (int)(240 * s), delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", (float)(20 * s), GraphicsUnit.Pixel))
                {
                    g.DrawString("1. What is photosynthesis?", font, Brushes.Black, (float)(40 * s), (float)(20 * s));
                    g.DrawString("2. Name the gas plants give off.", font, Brushes.Black, (float)(40 * s), (float)(120 * s));
                }
                using (var dot = new Pen(Color.Black, (float)(1.5 * s)) { DashStyle = DashStyle.Dot }) g.DrawLine(dot, (float)(40 * s), (float)(90 * s), (float)(700 * s), (float)(90 * s));
                using (var dash = new Pen(Color.Black, (float)(1.5 * s)) { DashStyle = DashStyle.Dash }) g.DrawLine(dash, (float)(40 * s), (float)(190 * s), (float)(700 * s), (float)(190 * s));
            });
        }

        /** A picture with its colours turned over: a light page as the same page in dark mode. */
        static Picture Inverted(Picture p)
        {
            var q = new Picture(p.W, p.H);
            for (int i = 0; i < p.Bgra.Length; i++) q.Bgra[i] = (byte)(i % 4 == 3 ? p.Bgra[i] : 255 - p.Bgra[i]);
            return q;
        }

        /** A worksheet at `s` times its size: a question with an answer line under it, underlined
         *  words, "Name" with a leader drawn as a rule after it, a thick bar and a filled box. */
        static Picture Sheet(double s)
        {
            return Paint((int)(640 * s), (int)(340 * s), delegate (Graphics g) { SheetWords(g, s, false); SheetMarks(g, s); });
        }

        static void SheetWords(Graphics g, double s, bool plain)
        {
            using (var font = new Font("Segoe UI", (float)(20 * s), GraphicsUnit.Pixel))
            using (var link = new Font("Segoe UI", (float)(20 * s), plain ? FontStyle.Regular : FontStyle.Underline, GraphicsUnit.Pixel))
            {
                g.DrawString("1. Solve 2x + 3 = 11", font, Brushes.Black, (float)(40 * s), (float)(20 * s));
                g.DrawString("See the worked example", link, Brushes.Black, (float)(40 * s), (float)(110 * s));
                g.DrawString("Name", font, Brushes.Black, (float)(40 * s), (float)(170 * s));
            }
        }

        static void SheetMarks(Graphics g, double s)
        {
            g.FillRectangle(Brushes.Black, (float)(40 * s), (float)(80 * s), (float)(520 * s), (float)(2 * s));
            g.FillRectangle(Brushes.Black, (float)(110 * s), (float)(194 * s), (float)(450 * s), (float)(2 * s));
            g.FillRectangle(Brushes.Black, (float)(40 * s), (float)(240 * s), (float)(520 * s), (float)(10 * s));
            g.FillRectangle(Brushes.Black, (float)(40 * s), (float)(270 * s), (float)(120 * s), (float)(50 * s));
        }

        /** The sheet's lines of words as the reader would box them: each one's ink, drawn alone. */
        static List<OcrLine> SheetLines(double s)
        {
            int w = (int)(640 * s), h = (int)(340 * s);
            Picture plain = Paint(w, h, delegate (Graphics g) { SheetWords(g, s, true); });
            var lines = new List<OcrLine>();
            // (the bands the three lines of words are drawn in: the question, the linked words, "Name")
            foreach (int[] band in new[] { new[] { 0, 60 }, new[] { 100, 160 }, new[] { 160, 230 } })
            {
                int top = (int)(band[0] * s);
                OcrLine l = Inked(Capture.Crop(plain, 0, top, w, (int)(band[1] * s) - top), "words");
                if (l != null) lines.Add(Shifted(new List<OcrLine> { l }, 0, top)[0]);
            }
            return lines;
        }

        /** The box a picture's dark pixels take, as a reader's line of one word, or null. */
        static OcrLine Inked(Picture p, string t)
        {
            int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
            for (int y = 0; y < p.H; y++)
                for (int x = 0; x < p.W; x++)
                {
                    int i = (y * p.W + x) * 4;
                    if (299 * p.Bgra[i + 2] + 587 * p.Bgra[i + 1] + 114 * p.Bgra[i] >= 160000) continue;
                    x0 = Math.Min(x0, x); y0 = Math.Min(y0, y); x1 = Math.Max(x1, x + 1); y1 = Math.Max(y1, y + 1);
                }
            if (x1 < 0) return null;
            var l = new OcrLine { T = t, X = x0, Y = y0, W = x1 - x0, H = y1 - y0 };
            l.Words.Add(new OcrWord { T = t, X = x0, Y = y0, W = x1 - x0, H = y1 - y0 });
            return l;
        }

        static List<OcrLine> Shifted(List<OcrLine> lines, double dx, double dy)
        {
            var out_ = new List<OcrLine>();
            foreach (OcrLine l in lines)
            {
                var m = new OcrLine { T = l.T, X = l.X + dx, Y = l.Y + dy, W = l.W, H = l.H };
                foreach (OcrWord w in l.Words) m.Words.Add(new OcrWord { T = w.T, X = w.X + dx, Y = w.Y + dy, W = w.W, H = w.H });
                out_.Add(m);
            }
            return out_;
        }

        static Rule Near(List<Rule> rules, double y, double within)
        {
            foreach (Rule r in rules) if (Math.Abs(r.Y - y) <= within) return r;
            return null;
        }

        /** A grey picture w x h, for the JPEG check. */
        static Picture Flat2(int w, int h)
        {
            var pic = new Picture(w, h);
            for (int i = 0; i < pic.Bgra.Length; i++) pic.Bgra[i] = 128;
            return pic;
        }

        static Picture Draw(string text, int w, int h)
        {
            return Paint(w, h, delegate (Graphics g)
            {
                using (var font = new Font("Segoe UI", 28)) g.DrawString(text, font, Brushes.Black, 10, 15);
            });
        }

        /** A white picture w x h, drawn on by `draw`. */
        static Picture Paint(int w, int h, Action<Graphics> draw)
        {
            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.White);
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                    draw(g);
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
