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

            AnswerLines();

            Console.WriteLine(failed == 0 ? "all checks passed" : failed + " checks failed");
            return failed == 0 ? 0 : 1;
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
