// What the helper says unasked: the window under the cursor ("over"), presses, releases and their
// verdicts ("press", "release", "tap"), scrolls, which app is in front and which document the
// watched window shows ("front", "ident"), and a new look on an observed window ("changed").
// The Mac helper's rules and numbers (main.swift), with the screen's grey thumbnails as its looks.
using System;
using System.Collections.Generic;
using System.Threading;

namespace Tutornote.Screen
{
    public static class Watcher
    {
        // The Mac's numbers, in points (scaled to pixels by the window's scale).
        const int OVER_EVERY_MS = 50;
        const int IDENT_MS = 150;
        const int OBSERVE_IDLE_MS = 500;
        const int POLL_MS = 100;
        const int BURST_MS = 1500;
        const int SCROLL_EXPLAINS_MS = 600;
        const int TURN_QUIET_MS = 2000;
        const int TAP_AFTER_MS = 150;
        const double TAP_TRAVEL = 5, TAP_MAX_MS = 700;
        const double LINE_REACH = 14, SIDE_REACH = 160, TAP_REACH = 60, CARET_WIDE = 3;
        const int SEEN_KEPT = 64;

        static readonly object Gate = new object();

        // The companion
        static bool companion;
        static HashSet<long> stop = new HashSet<long>();
        static HashSet<string> privateBundles = new HashSet<string>();
        static string overSig = "";
        static IntPtr overWindow = IntPtr.Zero;
        static long overAt;

        // The lesson's watch
        static IntPtr watched = IntPtr.Zero;
        static uint watchedPid;
        static string identSig = "";
        static string watchedTitle = "";
        static long identAt;
        static uint frontPid = uint.MaxValue;

        // New looks
        sealed class Observed { public IntPtr H; public Look Prev, First, Said; public long Next, BurstUntil, ChangeStart; }
        static readonly List<Observed> observed = new List<Observed>();
        static readonly Dictionary<long, Look> lastRead = new Dictionary<long, Look>();
        static readonly Queue<long> lastReadOrder = new Queue<long>();
        static readonly Dictionary<long, long> quietUntil = new Dictionary<long, long>();
        /** When each window was last scrolled by the student (a scroll explains that window's new look only). */
        static readonly Dictionary<long, long> lastScrollAt = new Dictionary<long, long>();

        // Secure: Windows' own desktop (UAC, the lock screen) has the screen
        static bool secure;
        static long secureAt;

        // Presses and taps
        sealed class Press
        {
            public long At; public POINT P; public IntPtr H; public string Title = ""; public bool Alt, Hand, Private, Second;
            public double Scale = 1; public RECT Frame, LineRect; public Look Thumb, Patch; public Picture PatchPic;
        }
        static Press press;
        static long lastTapUpAt = -100000;
        static POINT lastTapAt;
        static int lastClicks;
        static long tapCount;
        sealed class Pending { public long Due; public Press P; public POINT Up; public int Clicks; public long Id; public bool Companion; }
        static readonly List<Pending> pending = new List<Pending>();

        public static void Start()
        {
            var t = new Thread(Loop) { IsBackground = true, Name = "watch" };
            t.Start();
        }

        public static void Companion(bool on, List<double> stopIds, List<string> privates, List<string> readers)
        {
            lock (Gate)
            {
                companion = on;
                stop = new HashSet<long>();
                foreach (double d in stopIds) stop.Add((long)d);
                privateBundles = new HashSet<string>(privates);
                overSig = "";
                if (!on) observed.Clear();
            }
        }

        public static void Watch(IntPtr h)
        {
            lock (Gate)
            {
                watched = h;
                watchedPid = h == IntPtr.Zero ? 0 : Apps.OfWindow(h).Pid;
                identSig = "";
                watchedTitle = h == IntPtr.Zero ? "" : Apps.TabTitle(Apps.OfWindow(h), Win32.TextOf(h));
                frontPid = uint.MaxValue;
            }
        }

        public static void Observe(List<double> ids)
        {
            lock (Gate)
            {
                var keep = new List<Observed>();
                foreach (double d in ids)
                {
                    if (keep.Count >= 2) break;
                    var h = new IntPtr((long)d);
                    var known = observed.Find(o => o.H == h);
                    keep.Add(known ?? new Observed { H = h, BurstUntil = Clock.Ms + BURST_MS });
                }
                observed.Clear();
                observed.AddRange(keep);
            }
        }

        /** The look a read saw: what "moved since its last read" and a new look are judged against. */
        public static void Remember(IntPtr h, Look look)
        {
            if (look == null) return;
            lock (Gate)
            {
                long key = h.ToInt64();
                if (!lastRead.ContainsKey(key)) lastReadOrder.Enqueue(key);
                lastRead[key] = look;
                while (lastReadOrder.Count > SEEN_KEPT) lastRead.Remove(lastReadOrder.Dequeue());
            }
        }

        public static Look LastRead(IntPtr h)
        {
            lock (Gate) { Look l; return lastRead.TryGetValue(h.ToInt64(), out l) ? l : null; }
        }

        public static void QuietTurn(IntPtr h)
        {
            lock (Gate) quietUntil[h.ToInt64()] = Clock.Ms + TURN_QUIET_MS;
        }

        static void Burst(IntPtr h)
        {
            lock (Gate) foreach (var o in observed) if (o.H == h) { o.BurstUntil = Clock.Ms + BURST_MS; o.Next = 0; }
        }

        static bool PrivateApp(AppInfo app, string title)
        {
            return app.Private || privateBundles.Contains(app.Bundle) || Apps.PrivateTitle(app, title);
        }

        static void Loop()
        {
            while (true)
            {
                try { Tick(); } catch (Exception e) { Out.Log("watch tick failed: " + e.GetType().Name); }
                Thread.Sleep(33);
            }
        }

        static void Tick()
        {
            long now = Clock.Ms;
            List<Pending> due = null;
            List<Observed> looks;
            bool doOver, doIdent;
            IntPtr watchNow;
            lock (Gate)
            {
                doOver = companion && now - overAt >= OVER_EVERY_MS;
                if (doOver) overAt = now;
                doIdent = watched != IntPtr.Zero && now - identAt >= IDENT_MS;
                if (doIdent) identAt = now;
                watchNow = watched;
                looks = new List<Observed>(observed);
                for (int i = pending.Count - 1; i >= 0; i--)
                    if (pending[i].Due <= now) { if (due == null) due = new List<Pending>(); due.Add(pending[i]); pending.RemoveAt(i); }
            }
            // (the screen's pictures and the window walks out of the lock: the mouse's thread takes it)
            if (now - secureAt >= 500) { secureAt = now; secure = Windows.SecureDesktop(); }
            if (doOver) CheckOver();
            if (doIdent) CheckIdent(watchNow);
            foreach (var o in looks) CheckObserved(o, now);
            // (each verdict on a worker of its own: its word check may wait for the text reader, and the
            // cursor, the front app and new looks keep their rhythm meanwhile)
            if (due != null)
                foreach (var p in due)
                {
                    Pending job = p;
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        try { Judge(job); } catch (Exception e) { Out.Log("tap verdict failed: " + e.GetType().Name); }
                    });
                }
        }

        // ---- over -------------------------------------------------------------------------------

        static void CheckOver()
        {
            POINT c;
            if (!Win32.GetCursorPos(out c)) return;
            Hit hit = Windows.At(c, null, Program.ParentPid, stop);
            string sig;
            var msg = new Dictionary<string, object> { { "ev", "over" } };
            if (hit.Window == IntPtr.Zero)
            {
                sig = hit.Own ? "own" : "none";
                sig += secure ? "|s" : "";
                msg["window"] = null;
                msg["own"] = hit.Own;
                msg["secure"] = secure;
            }
            else
            {
                AppInfo app = Apps.OfWindow(hit.Window);
                string raw = Win32.TextOf(hit.Window);
                RECT f = Win32.FrameOf(hit.Window);
                // (its frame too: a window dragged to another place, same size, is said again there)
                sig = hit.Window.ToInt64() + "|" + f.Left + "," + f.Top + "," + f.Width + "," + f.Height + "|" + (secure ? "s" : "");
                msg["window"] = hit.Window.ToInt64();
                msg["pid"] = (long)app.Pid;
                msg["app"] = app.Name;
                msg["bundle"] = app.Bundle;
                msg["title"] = Apps.TabTitle(app, raw);
                msg["frame"] = J.Frame(f);
                msg["own"] = false;
                msg["secure"] = secure || PrivateApp(app, raw);
            }
            if (sig == overSig) return;
            overSig = sig;
            Out.Send(msg);
            // (a burst only on arriving at a window: a drag says it again every 50 ms)
            if (hit.Window != IntPtr.Zero && hit.Window != overWindow) Burst(hit.Window);
            overWindow = hit.Window;
        }

        // ---- front and ident --------------------------------------------------------------------

        static void CheckIdent(IntPtr h)
        {
            IntPtr fgAny = Win32.GetForegroundWindow();
            IntPtr fgRoot = fgAny == IntPtr.Zero ? IntPtr.Zero : Win32.GetAncestor(fgAny, Win32.GA_ROOT);
            uint fp = fgRoot == IntPtr.Zero ? 0 : Apps.OfWindow(fgRoot).Pid;
            // (the taskbar, Start, search or Alt-Tab in front is no app the student went to: as the Mac's
            // Dock and menu bar, it changes nothing)
            if (fp != frontPid && fp != 0 && !Windows.IsShell(fgRoot))
            {
                frontPid = fp;
                Out.Send(new Dictionary<string, object> { { "ev", "front" }, { "pid", (long)fp }, { "bundle", Apps.Of(fp).Bundle } });
            }
            string title = Win32.IsWindow(h) ? Apps.TabTitle(Apps.OfWindow(h), Win32.TextOf(h)) : "";
            bool onScreen = Windows.OnScreen(h);
            IntPtr fg = Windows.Front();
            var msg = new Dictionary<string, object>
            {
                { "ev", "ident" }, { "window", h.ToInt64() }, { "title", title }, { "onScreen", onScreen }, { "secure", secure },
                { "top", null }, { "topTitle", "" }, { "topFrame", null },
            };
            string sig = title + "|" + onScreen + "|" + secure;
            if (fg != IntPtr.Zero)
            {
                AppInfo app = Apps.OfWindow(fg);
                string raw = Win32.TextOf(fg);
                if (app.Pid == watchedPid)
                {
                    string t = Apps.TabTitle(app, raw);
                    RECT f = Win32.FrameOf(fg);
                    msg["top"] = fg.ToInt64(); msg["topTitle"] = t; msg["topFrame"] = J.Frame(f);
                    sig += "|top " + fg.ToInt64() + " " + t + " " + f.Left + "," + f.Top + "," + f.Width + "," + f.Height;
                }
                else if (Win32.PidOf(fg) != Program.ParentPid && !secure && !PrivateApp(app, raw))
                {
                    string t = Apps.TabTitle(app, raw);
                    RECT f = Win32.FrameOf(fg);
                    msg["other"] = new Dictionary<string, object>
                    {
                        { "window", fg.ToInt64() }, { "pid", (long)app.Pid }, { "app", app.Name }, { "bundle", app.Bundle }, { "title", t }, { "frame", J.Frame(f) },
                    };
                    sig += "|other " + fg.ToInt64() + " " + t + " " + f.Left + "," + f.Top + "," + f.Width + "," + f.Height;
                }
            }
            if (title != watchedTitle) { watchedTitle = title; Burst(h); }
            if (sig == identSig) return;
            identSig = sig;
            Out.Send(msg);
        }

        // ---- new looks ----------------------------------------------------------------------------

        static void CheckObserved(Observed o, long now)
        {
            if (now < o.Next) return;
            o.Next = now + (now < o.BurstUntil ? POLL_MS : OBSERVE_IDLE_MS);
            long key = o.H.ToInt64(), quiet, scrolledAt;
            Look baseLook;
            lock (Gate)
            {
                if (!quietUntil.TryGetValue(key, out quiet)) quiet = 0;
                if (!lastScrollAt.TryGetValue(key, out scrolledAt)) scrolledAt = -100000;
                if (!lastRead.TryGetValue(key, out baseLook)) baseLook = null;
            }
            if (quiet > now) { o.Prev = null; return; }
            if (!Windows.OnScreen(o.H)) { o.Prev = null; return; }
            Look t = Capture.Thumb(Win32.FrameOf(o.H));
            if (t == null) return;
            if (baseLook == null) { if (o.First == null) o.First = t; baseLook = o.First; }
            if (o.Prev != null)
            {
                double step = Diff.Mean(t, o.Prev);
                if (step > Diff.CHANGED_ABOVE && o.ChangeStart == 0) o.ChangeStart = now;
                if (step < Diff.SETTLED_BELOW)
                {
                    bool news = Diff.Middle(t, baseLook) > Diff.CHANGED_ABOVE && (o.Said == null || Diff.Middle(t, o.Said) > Diff.CHANGED_ABOVE);
                    if (news)
                    {
                        o.Said = t;
                        // (a wheel scroll begun just before the change explains it: the app follows scrolls itself)
                        bool scrolled = o.ChangeStart > 0 && scrolledAt >= o.ChangeStart - SCROLL_EXPLAINS_MS;
                        if (!scrolled)
                            Out.Send(new Dictionary<string, object> { { "ev", "changed" }, { "window", o.H.ToInt64() }, { "settleMs", o.ChangeStart > 0 ? now - o.ChangeStart : 0 } });
                    }
                    o.ChangeStart = 0;
                }
            }
            o.Prev = t;
        }

        // ---- presses, taps, scrolls (from Input, on its own thread) ------------------------------

        static RECT LineRect(POINT p, double s)
        {
            return new RECT
            {
                Left = (int)(p.X - SIDE_REACH * s), Right = (int)(p.X + SIDE_REACH * s),
                Top = (int)(p.Y - LINE_REACH * s), Bottom = (int)(p.Y + LINE_REACH * s),
            };
        }

        static bool CursorIsHand()
        {
            var info = new CURSORINFO { cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(CURSORINFO)) };
            return Win32.GetCursorInfo(ref info) && info.hCursor == Win32.LoadCursor(IntPtr.Zero, new IntPtr(Win32.IDC_HAND));
        }

        public static void OnLeftDown()
        {
            POINT p;
            Win32.GetCursorPos(out p);
            bool on, watching;
            HashSet<long> stopNow;
            lock (Gate) { on = companion; watching = watched != IntPtr.Zero; stopNow = stop; }
            if (!on && !watching) { press = null; return; }
            Hit hit = Windows.At(p, null, Program.ParentPid, stopNow);
            if (hit.Window == IntPtr.Zero) { press = null; return; }
            IntPtr h = hit.Window;
            AppInfo app = Apps.OfWindow(h);
            string raw = Win32.TextOf(h);
            string title = Apps.TabTitle(app, raw);
            long now = Clock.Ms;
            double s = Win32.ScaleOf(h);
            var pr = new Press
            {
                At = now, P = p, H = h, Title = title, Alt = Win32.KeyDown(Win32.VK_MENU), Hand = CursorIsHand(), Scale = s,
                Second = now - lastTapUpAt <= Win32.GetDoubleClickTime()
                    && Math.Abs(p.X - lastTapAt.X) <= Win32.GetSystemMetrics(Win32.SM_CXDOUBLECLK)
                    && Math.Abs(p.Y - lastTapAt.Y) <= Win32.GetSystemMetrics(Win32.SM_CYDOUBLECLK),
            };
            lock (Gate) pr.Private = secure || PrivateApp(app, raw);
            if (on) Out.Send(new Dictionary<string, object> { { "ev", "press" }, { "x", p.X }, { "y", p.Y }, { "window", h.ToInt64() } });
            if (!pr.Private && !pr.Second)
            {
                pr.Frame = Win32.FrameOf(h);
                pr.LineRect = LineRect(p, s);
                pr.Thumb = Capture.Thumb(pr.Frame);
                // (in colour too: the words at the tap are read from it if the line changes)
                pr.PatchPic = Capture.Screen(pr.LineRect, pr.LineRect.Width, pr.LineRect.Height);
                pr.Patch = pr.PatchPic == null ? null : Capture.Grey(pr.PatchPic);
            }
            press = pr;
            lock (Gate) Burst(h);
        }

        public static void OnLeftUp()
        {
            Press pr = press;
            press = null;
            if (pr == null) return;
            POINT p;
            Win32.GetCursorPos(out p);
            long now = Clock.Ms;
            double travel = TAP_TRAVEL * pr.Scale;
            if (Math.Abs(p.X - pr.P.X) > travel || Math.Abs(p.Y - pr.P.Y) > travel || now - pr.At > TAP_MAX_MS) return;
            int clicks = pr.Second ? lastClicks + 1 : 1;
            lastTapUpAt = now; lastTapAt = p; lastClicks = clicks;
            bool on; IntPtr w;
            lock (Gate) { on = companion; w = watched; }
            if (on)
            {
                long id = Program.StartUnixMs + Interlocked.Increment(ref tapCount);
                Out.Send(new Dictionary<string, object>
                {
                    { "ev", "release" }, { "id", id }, { "x", p.X }, { "y", p.Y }, { "window", pr.H.ToInt64() },
                    { "alt", pr.Alt }, { "clicks", clicks }, { "hand", pr.Hand }, { "private", pr.Private },
                });
                if (pr.Private)
                {
                    // (said at once, with no picture)
                    Out.Send(new Dictionary<string, object>
                    {
                        { "ev", "tap" }, { "x", p.X }, { "y", p.Y }, { "window", pr.H.ToInt64() }, { "moved", false }, { "acted", false }, { "alt", pr.Alt }, { "id", id },
                    });
                    return;
                }
                lock (Gate) pending.Add(new Pending { Due = now + TAP_AFTER_MS, P = pr, Up = p, Clicks = clicks, Id = id, Companion = true });
            }
            else if (w == pr.H)
            {
                lock (Gate) pending.Add(new Pending { Due = now + TAP_AFTER_MS, P = pr, Up = p, Clicks = clicks, Companion = false });
            }
        }

        public static void OnWheel(int delta, bool horizontal)
        {
            POINT p;
            Win32.GetCursorPos(out p);
            bool on; IntPtr w; HashSet<long> stopNow;
            lock (Gate) { on = companion; w = watched; stopNow = stop; }
            Hit hit = Windows.At(p, null, Program.ParentPid, stopNow);
            if (hit.Window == IntPtr.Zero) return;
            lock (Gate) lastScrollAt[hit.Window.ToInt64()] = Clock.Ms;
            if (!on && hit.Window != w) return;
            // A wheel notch (120) moves as many lines as Windows is set to (3 lines, about 100 points, by
            // default; a page when set so); down the page is content moving up.
            double amount = delta / 120.0 * Win32.WheelPoints(Win32.FrameOf(hit.Window), Win32.ScaleOf(hit.Window));
            Out.Send(new Dictionary<string, object>
            {
                { "ev", "scroll" }, { "dy", horizontal ? 0 : -amount }, { "dx", horizontal ? amount : 0 }, { "momentum", false }, { "window", hit.Window.ToInt64() },
            });
            lock (Gate) Burst(hit.Window);
        }

        /**
         * The words of a tap's verdict, from what was measured (the Mac's judgeTap and its verdict
         * table, by pixels): `line`, how much the tapped line's own patch changed; `away`, the window
         * away from the tap; `boxW` x `boxH`, the box of the patch's changed pixels. A tapped line that
         * did not change is "skipped" and not acted, whatever moved elsewhere (a playing video, a
         * reader's bars): as on the Mac, `away` only says it was wide. When the line did change, its
         * words decide (`text`, TapText: the Mac's judgeText): still there, the student was pointing at
         * them ("kept"; "content" when the page around them changed, a tab or a sidebar item); gone,
         * the click did something ("gone"). With no words read there, the pixels decide.
         */
        public static string Verdict(int clicks, bool covered, bool retitled, bool pictured, double line, double away,
            int boxW, int boxH, double scale, string text, out bool acted)
        {
            acted = true;
            if (clicks >= 2) return "select";
            if (covered) return "covered";
            if (retitled) return "title";
            acted = false;
            if (!pictured) return "pixels";
            if (line <= Diff.CHANGED_ABOVE) return "skipped";
            acted = true;
            if (boxW > 0 && boxW <= CARET_WIDE * scale + 1 && boxH <= 40 * scale) return "caret";
            if (text == "gone") return "gone";
            if (text == "kept")
            {
                acted = away > Diff.CHANGED_ABOVE;
                return acted ? "content" : "kept";
            }
            if (away > Diff.CHANGED_ABOVE) return "content";
            acted = line > 6;
            return text == "none" ? "none" : "pixels";
        }

        /** Share of the tapped row's words found again for "kept" (the Mac's words rule). */
        const double KEPT_SHARE = 0.6;
        /** The words at a tap are read within this, or the pixels decide (the Mac's TEXT_BUDGET_MS). */
        const int TEXT_BUDGET_MS = 120;

        /**
         * What the words at the tap say, read by Windows' text reader in the tapped line's patch at the
         * press and after the release: "kept" when most of the tapped row's words are still there,
         * "gone" when they went, "none" with no words at the tap, null when nothing could be read.
         * `tapY` is the tap's height inside the patch. `share` is how many of the row's words were found.
         */
        public static string TapText(Picture before, Picture after, int tapY, out double share)
        {
            share = 0;
            if (before == null || after == null || Ocr.Engine() == null) return null;
            // (within TEXT_BUDGET_MS: a whole window being read holds the text reader, and then the
            // pixels decide, as on the Mac)
            long until = Clock.Ms + TEXT_BUDGET_MS;
            List<OcrLine> was, now;
            try
            {
                was = Ocr.TryRead(before, 0, 0, 1, (int)Math.Max(0, until - Clock.Ms));
                if (was == null) return null;
                now = Ocr.TryRead(after, 0, 0, 1, (int)Math.Max(0, until - Clock.Ms));
                if (now == null) return null;
            }
            catch (Exception) { return null; }
            OcrLine row = null;
            double best = double.MaxValue;
            foreach (var l in was)
            {
                double d = tapY < l.Y ? l.Y - tapY : tapY > l.Y + l.H ? tapY - (l.Y + l.H) : 0;
                if (d < best) { best = d; row = l; }
            }
            if (row == null) return "none";
            var seen = new HashSet<string>();
            foreach (var l in now) foreach (var w in l.Words) { string k = Plain(w.T); if (k.Length > 0) seen.Add(k); }
            int n = 0, found = 0;
            foreach (var w in row.Words)
            {
                string k = Plain(w.T);
                if (k.Length == 0) continue;
                n++;
                if (seen.Contains(k)) found++;
            }
            if (n == 0) return "none";
            share = (double)found / n;
            return share >= KEPT_SHARE ? "kept" : "gone";
        }

        /** A word as compared: lower case, letters and digits only (a comma or a capital is no change). */
        static string Plain(string s)
        {
            var sb = new System.Text.StringBuilder(s.Length);
            foreach (char c in s.ToLowerInvariant()) if (char.IsLetterOrDigit(c)) sb.Append(c);
            return sb.ToString();
        }

        /**
         * A tap's verdict, on pictures taken TAP_AFTER_MS after the release (the Mac's judgeTap, by
         * pixels): did the click do something in its app (`acted`), or is the student pointing at words?
         */
        static void Judge(Pending t)
        {
            Press pr = t.P;
            IntPtr h = pr.H;
            Look last = LastRead(h);
            var msg = new Dictionary<string, object>
            {
                { "ev", "tap" }, { "x", t.Up.X }, { "y", t.Up.Y }, { "window", h.ToInt64() }, { "alt", pr.Alt },
            };
            if (t.Companion) msg["id"] = t.Id;
            if (!Win32.IsWindow(h) || !Windows.OnScreen(h))
            {
                msg["moved"] = true; msg["acted"] = true; msg["words"] = "covered";
                Out.Send(msg);
                return;
            }
            RECT frame = Win32.FrameOf(h);
            Look thumb = Capture.Thumb(frame);
            msg["moved"] = last != null && Diff.Middle(thumb, last) > Diff.CHANGED_ABOVE;
            if (!t.Companion)
            {
                msg["acted"] = false;
                Out.Send(msg);
                return;
            }
            bool acted;
            double line = 0, away = 0;
            HashSet<long> stopNow;
            lock (Gate) stopNow = stop;
            bool covered = t.Clicks < 2 && Windows.At(t.Up, null, Program.ParentPid, stopNow).Window != h;
            bool retitled = !covered && t.Clicks < 2 && Apps.TabTitle(Apps.OfWindow(h), Win32.TextOf(h)) != pr.Title;
            bool pictured = pr.Patch != null && pr.Thumb != null;
            RECT box = new RECT();
            string text = null;
            double share = 0;
            long textMs = -1;
            if (pictured && t.Clicks < 2 && !covered && !retitled)
            {
                Picture now = Capture.Screen(pr.LineRect, pr.LineRect.Width, pr.LineRect.Height);
                Look patch = now == null ? null : Capture.Grey(now);
                line = Diff.Mean(pr.Patch, patch);
                // (the thumbnail's own pixels for the reach around the tap)
                double k = thumb != null && frame.Width > 0 ? thumb.W / (double)frame.Width : 1;
                int reach = (int)Math.Ceiling(TAP_REACH * pr.Scale * k);
                int tx = (int)((t.Up.X - frame.Left) * k), ty = (int)((t.Up.Y - frame.Top) * k);
                away = Diff.MiddleAway(pr.Thumb, thumb, ty - reach, ty + reach);
                box = Diff.ChangedBox(pr.Patch, patch);
                // The line changed and is no caret's stroke: its words decide.
                bool caret = box.Width > 0 && box.Width <= CARET_WIDE * pr.Scale + 1 && box.Height <= 40 * pr.Scale;
                if (line > Diff.CHANGED_ABOVE && !caret)
                {
                    long t0 = Clock.Ms;
                    text = TapText(pr.PatchPic, now, t.Up.Y - pr.LineRect.Top, out share);
                    textMs = Clock.Ms - t0;
                }
            }
            string words = Verdict(t.Clicks, covered, retitled, pictured, line, away, box.Width, box.Height, pr.Scale, text, out acted);
            msg["acted"] = acted;
            msg["words"] = words;
            msg["line"] = Math.Round(line, 2);
            msg["away"] = Math.Round(away, 2);
            msg["wide"] = away > Diff.CHANGED_ABOVE;
            msg["look"] = -1;
            if (text == "kept" || text == "gone") msg["kept"] = Math.Round(share, 2);
            if (textMs >= 0) msg["textMs"] = textMs;
            Out.Send(msg);
        }
    }
}
