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
        static long lastScrollAt = -100000;

        // Secure: Windows' own desktop (UAC, the lock screen) has the screen
        static bool secure;
        static long secureAt;

        // Presses and taps
        sealed class Press
        {
            public long At; public POINT P; public IntPtr H; public string Title = ""; public bool Alt, Hand, Private, Second;
            public double Scale = 1; public RECT Frame, LineRect; public Look Thumb, Patch;
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
                watchedTitle = h == IntPtr.Zero ? "" : Win32.TextOf(h);
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
            foreach (var o in observed) if (o.H == h) { o.BurstUntil = Clock.Ms + BURST_MS; o.Next = 0; }
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
            lock (Gate)
            {
                if (now - secureAt >= 500) { secureAt = now; secure = Windows.SecureDesktop(); }
                if (companion && now - overAt >= OVER_EVERY_MS) { overAt = now; CheckOver(); }
                if (watched != IntPtr.Zero && now - identAt >= IDENT_MS) { identAt = now; CheckIdent(); }
                foreach (var o in observed) CheckObserved(o, now);
                for (int i = pending.Count - 1; i >= 0; i--)
                    if (pending[i].Due <= now) { if (due == null) due = new List<Pending>(); due.Add(pending[i]); pending.RemoveAt(i); }
            }
            if (due != null) foreach (var p in due) Judge(p);
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
                string title = Win32.TextOf(hit.Window);
                RECT f = Win32.FrameOf(hit.Window);
                sig = hit.Window.ToInt64() + "|" + (secure ? "s" : "");
                msg["window"] = hit.Window.ToInt64();
                msg["pid"] = (long)app.Pid;
                msg["app"] = app.Name;
                msg["bundle"] = app.Bundle;
                msg["title"] = title;
                msg["frame"] = J.Frame(f);
                msg["own"] = false;
                msg["secure"] = secure || PrivateApp(app, title);
            }
            if (sig == overSig) return;
            overSig = sig;
            Out.Send(msg);
            if (hit.Window != IntPtr.Zero) Burst(hit.Window);
        }

        // ---- front and ident --------------------------------------------------------------------

        static void CheckIdent()
        {
            IntPtr h = watched;
            IntPtr fgAny = Win32.GetForegroundWindow();
            IntPtr fgRoot = fgAny == IntPtr.Zero ? IntPtr.Zero : Win32.GetAncestor(fgAny, Win32.GA_ROOT);
            uint fp = fgRoot == IntPtr.Zero ? 0 : Apps.OfWindow(fgRoot).Pid;
            if (fp != frontPid && fp != 0)
            {
                frontPid = fp;
                Out.Send(new Dictionary<string, object> { { "ev", "front" }, { "pid", (long)fp }, { "bundle", Apps.Of(fp).Bundle } });
            }
            string title = Win32.IsWindow(h) ? Win32.TextOf(h) : "";
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
                if (app.Pid == watchedPid)
                {
                    string t = Win32.TextOf(fg);
                    RECT f = Win32.FrameOf(fg);
                    msg["top"] = fg.ToInt64(); msg["topTitle"] = t; msg["topFrame"] = J.Frame(f);
                    sig += "|top " + fg.ToInt64() + " " + t + " " + f.Left + "," + f.Top + "," + f.Width + "," + f.Height;
                }
                else if (Win32.PidOf(fg) != Program.ParentPid && !secure && !PrivateApp(app, Win32.TextOf(fg)))
                {
                    string t = Win32.TextOf(fg);
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
            long quiet;
            if (quietUntil.TryGetValue(o.H.ToInt64(), out quiet) && quiet > now) { o.Prev = null; return; }
            if (!Windows.OnScreen(o.H)) { o.Prev = null; return; }
            Look t = Capture.Thumb(Win32.FrameOf(o.H));
            if (t == null) return;
            Look baseLook;
            if (!lastRead.TryGetValue(o.H.ToInt64(), out baseLook)) { if (o.First == null) o.First = t; baseLook = o.First; }
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
                        bool scrolled = o.ChangeStart > 0 && lastScrollAt >= o.ChangeStart - SCROLL_EXPLAINS_MS;
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
            string title = Win32.TextOf(h);
            long now = Clock.Ms;
            double s = Win32.ScaleOf(h);
            var pr = new Press
            {
                At = now, P = p, H = h, Title = title, Alt = Win32.KeyDown(Win32.VK_MENU), Hand = CursorIsHand(), Scale = s,
                Second = now - lastTapUpAt <= Win32.GetDoubleClickTime()
                    && Math.Abs(p.X - lastTapAt.X) <= Win32.GetSystemMetrics(Win32.SM_CXDOUBLECLK)
                    && Math.Abs(p.Y - lastTapAt.Y) <= Win32.GetSystemMetrics(Win32.SM_CYDOUBLECLK),
            };
            lock (Gate) pr.Private = secure || PrivateApp(app, title);
            if (on) Out.Send(new Dictionary<string, object> { { "ev", "press" }, { "x", p.X }, { "y", p.Y }, { "window", h.ToInt64() } });
            if (!pr.Private && !pr.Second)
            {
                pr.Frame = Win32.FrameOf(h);
                pr.LineRect = LineRect(p, s);
                pr.Thumb = Capture.Thumb(pr.Frame);
                pr.Patch = Capture.Patch(pr.LineRect);
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
            lock (Gate) { on = companion; w = watched; stopNow = stop; lastScrollAt = Clock.Ms; }
            Hit hit = Windows.At(p, null, Program.ParentPid, stopNow);
            if (hit.Window == IntPtr.Zero) return;
            if (!on && hit.Window != w) return;
            // A wheel notch (120) is about 100 points of content; down the page is content moving up.
            double amount = delta / 120.0 * 100.0;
            Out.Send(new Dictionary<string, object>
            {
                { "ev", "scroll" }, { "dy", horizontal ? 0 : -amount }, { "dx", horizontal ? amount : 0 }, { "momentum", false }, { "window", hit.Window.ToInt64() },
            });
            lock (Gate) Burst(hit.Window);
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
            string words; bool acted;
            double line = 0, away = 0;
            HashSet<long> stopNow;
            lock (Gate) stopNow = stop;
            if (t.Clicks >= 2) { words = "select"; acted = true; }
            else if (Windows.At(t.Up, null, Program.ParentPid, stopNow).Window != h) { words = "covered"; acted = true; }
            else if (Win32.TextOf(h) != pr.Title) { words = "title"; acted = true; }
            else if (pr.Patch == null || pr.Thumb == null) { words = "pixels"; acted = false; }
            else
            {
                Look patch = Capture.Patch(pr.LineRect);
                line = Diff.Mean(pr.Patch, patch);
                // (the thumbnail's own pixels for the reach around the tap)
                double k = thumb != null && frame.Width > 0 ? thumb.W / (double)frame.Width : 1;
                int reach = (int)Math.Ceiling(TAP_REACH * pr.Scale * k);
                int tx = (int)((t.Up.X - frame.Left) * k), ty = (int)((t.Up.Y - frame.Top) * k);
                away = Diff.Away(pr.Thumb, thumb, tx - reach, ty - reach, reach * 2, reach * 2);
                RECT box = Diff.ChangedBox(pr.Patch, patch);
                if (line <= Diff.CHANGED_ABOVE)
                {
                    if (away > Diff.CHANGED_ABOVE * 2) { words = "content"; acted = true; }
                    else { words = "skipped"; acted = false; }
                }
                else if (box.Width > 0 && box.Width <= CARET_WIDE * pr.Scale + 1 && box.Height <= 40 * pr.Scale) { words = "caret"; acted = true; }
                else if (away > Diff.CHANGED_ABOVE) { words = "content"; acted = true; }
                else { words = "pixels"; acted = line > 6; }
            }
            msg["acted"] = acted;
            msg["words"] = words;
            msg["line"] = Math.Round(line, 2);
            msg["away"] = Math.Round(away, 2);
            msg["wide"] = away > Diff.CHANGED_ABOVE;
            msg["look"] = -1;
            Out.Send(msg);
        }
    }
}
