// What the helper says unasked: the window under the cursor ("over"), presses, releases and their
// verdicts ("press", "release", "tap"), scrolls, which app is in front and which document the
// watched window shows and where it is ("front", "ident"), a new look on an observed window
// ("changed"), and that a key went down in the watched window's app ("keyed": never which key).
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
        /** A key this fresh bursts the watched window (the Mac's KEY_FRESH_S), and one is said at most
         *  this often while keys keep coming (KEY_RUN_S): the page trusts its ink again 700 ms after
         *  the last it heard. */
        const int KEY_FRESH_MS = 300, KEY_RUN_MS = 300;

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
        /** The windows observed now that turn by the page ("observe"'s "page"). */
        static HashSet<long> pagedObserved = new HashSet<long>();
        /** A lesson's turns by a key going on, by window, and when the last of each ended: their keys
         *  are no student's (KeyIsOurs). */
        static readonly Dictionary<long, int> keyTurnsOn = new Dictionary<long, int>();
        static readonly Dictionary<long, long> keyTurnEnded = new Dictionary<long, long>();
        /** When the last key said ("keyed") went down, or -1: none yet. */
        static long lastKeyTaken = -1;

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

        // The cursor fed to the app ("cursor"), in place of a hook on the mouse: the app's overlay
        // follows it by these, so nothing of Tutornote's ever sits in the way of the mouse itself (a
        // low-level mouse hook makes every move wait for the app's busy thread: the founder,
        // 2026-11-03, "mouse movement has to be very slick"). Each move Raw Input hears is said, one
        // every CUR_EVERY_MS at the most, and the watch's tick says where it came to rest.
        const int CUR_EVERY_MS = 6;
        static volatile bool cursorOn;
        static readonly object CurGate = new object();
        static POINT curSent;
        static bool curSentAny;
        static long curSentAt;

        // A drag's stroke (circle to explain: the page tells a ring from it), on the input thread
        // alone: from the press to the release, a point every DRAG_STEP pixels, thinned past
        // DRAG_MAX; said with the release ("lift") at LIFT_POINTS at the most.
        const int DRAG_STEP = 2, DRAG_MAX = 1024, LIFT_POINTS = 160;
        static List<POINT> drag;

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

        /** The cursor said to the app ("cur") as it moves, or no longer. */
        public static void Cursor(bool on)
        {
            lock (CurGate) curSentAny = false;
            cursorOn = on;
        }

        /** Raw Input heard the mouse move (the input thread): a drag's stroke grows, and the cursor
         *  is said where it is now (at most every CUR_EVERY_MS). */
        public static void OnMove()
        {
            if (!cursorOn && drag == null) return;
            POINT p;
            if (!Win32.GetCursorPos(out p)) return;
            if (drag != null && press != null) drag = DragAdd(drag, p);
            if (cursorOn) SendCursor(p, false);
        }

        /** The cursor at `p` said, unless it was said there last, or (`resting` false: a move) a
         *  move was said less than CUR_EVERY_MS ago. */
        static void SendCursor(POINT p, bool resting)
        {
            long now = Clock.Ms;
            lock (CurGate)
            {
                if (curSentAny && p.X == curSent.X && p.Y == curSent.Y) return;
                if (!resting && curSentAny && now - curSentAt < CUR_EVERY_MS) return;
                curSent = p;
                curSentAny = true;
                curSentAt = now;
            }
            Out.Send(new Dictionary<string, object> { { "ev", "cur" }, { "x", p.X }, { "y", p.Y } });
        }

        /** The stroke with `p` added, unless it is within DRAG_STEP of the last point; at DRAG_MAX,
         *  every other point goes (the stroke is thinned, never cut short). */
        public static List<POINT> DragAdd(List<POINT> stroke, POINT p)
        {
            if (stroke.Count > 0)
            {
                POINT last = stroke[stroke.Count - 1];
                if (Math.Abs(p.X - last.X) < DRAG_STEP && Math.Abs(p.Y - last.Y) < DRAG_STEP) return stroke;
            }
            stroke.Add(p);
            if (stroke.Count < DRAG_MAX) return stroke;
            var thin = new List<POINT>(DRAG_MAX / 2 + 1);
            for (int i = 0; i < stroke.Count; i += 2) thin.Add(stroke[i]);
            if ((stroke.Count - 1) % 2 != 0) thin.Add(stroke[stroke.Count - 1]);
            return thin;
        }

        /** The stroke as said with its release: `most` points at the most, evenly taken, its first
         *  and last always among them; each [x, y]. */
        public static List<int[]> LiftPoints(List<POINT> stroke, int most)
        {
            var out_ = new List<int[]>();
            if (stroke == null || stroke.Count == 0 || most < 2) return out_;
            if (stroke.Count <= most)
            {
                foreach (var p in stroke) out_.Add(new[] { p.X, p.Y });
                return out_;
            }
            for (int i = 0; i < most; i++)
            {
                POINT p = stroke[(int)Math.Round(i * (stroke.Count - 1) / (double)(most - 1))];
                out_.Add(new[] { p.X, p.Y });
            }
            return out_;
        }

        /** Watch `ids` (two at most) for a new look; `page`: those of them that turn by the page. */
        public static void Observe(List<double> ids, List<double> page)
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
                pagedObserved = new HashSet<long>();
                foreach (double d in page) if (keep.Exists(o => o.H == new IntPtr((long)d))) pagedObserved.Add((long)d);
            }
        }

        /** A lesson's turn of `h` by a key begins (`on`) or ends. */
        public static void KeyTurning(IntPtr h, bool on)
        {
            long key = h.ToInt64();
            lock (Gate)
            {
                int now;
                keyTurnsOn.TryGetValue(key, out now);
                keyTurnsOn[key] = on ? now + 1 : Math.Max(0, now - 1);
                if (!on) keyTurnEnded[key] = Clock.Ms;
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
            // (where the cursor came to rest, if the last move's was not said; and a cursor moved by
            // touch or a pen, which Raw Input's mouse does not hear)
            if (cursorOn) { POINT c; if (Win32.GetCursorPos(out c)) SendCursor(c, true); }
            if (doOver) CheckOver();
            if (doIdent) CheckIdent(watchNow);
            // (a key just pressed in the lesson's app: its window is looked at in this tick)
            if (looks.Count > 0 && watchNow != IntPtr.Zero) KeyTick(looks, watchNow, now);
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
                // (its frame too: a window dragged to another place, same size, is said again there;
                // and its title: another tab clicked in the same window is another document there)
                string title = Apps.TabTitle(app, raw);
                sig = hit.Window.ToInt64() + "|" + f.Left + "," + f.Top + "," + f.Width + "," + f.Height + "|" + (secure ? "s" : "") + "|" + title;
                msg["window"] = hit.Window.ToInt64();
                msg["pid"] = (long)app.Pid;
                msg["app"] = app.Name;
                msg["bundle"] = app.Bundle;
                msg["title"] = title;
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
            // Where the watched window is, whichever app is in front: a window dragged by its title bar
            // changes no pixel of it, so no new look is ever said for it, and the lesson's marks would
            // stay where its words were. Said on every tick while it goes; screenTeach.ts followFrame
            // moves the lesson with it. (Not once closed, nor minimized: no place on the screen.)
            if (Win32.IsWindow(h) && !Win32.IsIconic(h))
            {
                RECT own = Win32.FrameOf(h);
                msg["frame"] = J.Frame(own);
                sig += "|at " + own.Left + "," + own.Top + "," + own.Width + "," + own.Height;
            }
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

        // ---- keys -----------------------------------------------------------------------------------

        /*
          A key pressed in the lesson's app (the founder, 2026-10-28: the tutor over another app should
          be "super responsive"; the Mac's keyTick). A key sends no wheel, so a page turned or scrolled
          by one (Page Down, an arrow, the space bar) was seen only at the window's next idle look, with
          the lesson's ink left on where the words were meanwhile. Each tick asks when a key last went
          down (Input.KeyAt: when, never which key), and one that went down less than KEY_FRESH_MS
          before, with the watched window's app in front and that window observed, bursts it: its new
          look is said as soon as it is still. The first key of a run is also said at once ("keyed": the
          window alone), and one again at most every KEY_RUN_MS while keys keep coming. Never the keys
          of a lesson's own turn by a key (KeyIsOurs).
        */

        /** Whether a key that went down `sinceKey` ms ago, with `front`'s app in front, bursts the watched
         *  window, `window`'s: only one just pressed, and only in that window's own app. */
        public static bool KeyBurstDue(long sinceKey, uint front, uint window)
        {
            return front != 0 && window != 0 && front == window && sinceKey >= 0 && sinceKey < KEY_FRESH_MS;
        }

        /** Whether the key that went down at `keyAt` is said, the last one said having gone down at
         *  `lastKeyAt` (-1: none yet): the first of a run, and one at most every KEY_RUN_MS after it. */
        public static bool KeyRunStarts(long keyAt, long lastKeyAt)
        {
            return lastKeyAt < 0 || keyAt - lastKeyAt > KEY_RUN_MS;
        }

        /** Whether a key at `keyAt` is one a lesson's own turn by a key posted: such a turn going on, or
         *  one that ended at `turnEnded` (-1: none) or after it. */
        public static bool KeyIsOurs(long keyAt, int turnsOn, long turnEnded)
        {
            return turnsOn > 0 || (turnEnded >= 0 && keyAt <= turnEnded);
        }

        static void KeyTick(List<Observed> looks, IntPtr watchNow, long now)
        {
            long keyAt;
            if (!Input.KeyAt(out keyAt) || now - keyAt >= KEY_FRESH_MS) return;
            if (!looks.Exists(o => o.H == watchNow)) return;
            IntPtr fg = Win32.GetForegroundWindow();
            IntPtr root = fg == IntPtr.Zero ? IntPtr.Zero : Win32.GetAncestor(fg, Win32.GA_ROOT);
            uint front = root == IntPtr.Zero ? 0 : Apps.OfWindow(root).Pid;
            uint windowPid;
            lock (Gate) windowPid = watchedPid;
            if (!KeyBurstDue(now - keyAt, front, windowPid)) return;
            bool starts;
            lock (Gate)
            {
                long key = watchNow.ToInt64(), ended;
                int on;
                keyTurnsOn.TryGetValue(key, out on);
                if (!keyTurnEnded.TryGetValue(key, out ended)) ended = -1;
                if (KeyIsOurs(keyAt, on, ended)) return;
                starts = KeyRunStarts(keyAt, lastKeyTaken);
                if (starts) lastKeyTaken = keyAt;
            }
            Burst(watchNow);
            if (starts) Out.Send(new Dictionary<string, object> { { "ev", "keyed" }, { "window", watchNow.ToInt64() } });
        }

        // ---- new looks ----------------------------------------------------------------------------

        /** Whether a new look that began at `since` is the wheel scroll last heard at `scrolled` (-1:
         *  none). Never in a window that turns by the page: a wheel or a swipe there turns a whole page. */
        public static bool ScrollExplains(long since, long scrolled, bool page)
        {
            return !page && scrolled >= 0 && scrolled >= since - SCROLL_EXPLAINS_MS;
        }

        static void CheckObserved(Observed o, long now)
        {
            if (now < o.Next) return;
            o.Next = now + (now < o.BurstUntil ? POLL_MS : OBSERVE_IDLE_MS);
            long key = o.H.ToInt64(), quiet, scrolledAt;
            Look baseLook;
            bool paged;
            lock (Gate)
            {
                if (!quietUntil.TryGetValue(key, out quiet)) quiet = 0;
                if (!lastScrollAt.TryGetValue(key, out scrolledAt)) scrolledAt = -1;
                paged = pagedObserved.Contains(key);
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
                        // (a wheel scroll begun just before the change explains it: the app follows scrolls
                        // itself; never a page turned by the wheel in a window that turns by the page)
                        if (!(o.ChangeStart > 0 && ScrollExplains(o.ChangeStart, scrolledAt, paged)))
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
            drag = null;
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
            // (with the companion off, on the lesson's window alone: what it wrote there hides at once,
            // ahead of the new look a click in a reader's margin may bring)
            bool lessonWindow;
            lock (Gate) lessonWindow = h == watched;
            if (on || lessonWindow) Out.Send(new Dictionary<string, object> { { "ev", "press" }, { "x", p.X }, { "y", p.Y }, { "window", h.ToInt64() } });
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
            // (with the companion on, the drag from here may be a ring round something to explain)
            if (on) drag = new List<POINT> { p };
            lock (Gate) Burst(h);
        }

        public static void OnLeftUp()
        {
            Press pr = press;
            press = null;
            List<POINT> stroke = drag;
            drag = null;
            if (pr == null) return;
            POINT p;
            Win32.GetCursorPos(out p);
            long now = Clock.Ms;
            bool on; IntPtr w;
            lock (Gate) { on = companion; w = watched; }
            double travel = TAP_TRAVEL * pr.Scale;
            if (Math.Abs(p.X - pr.P.X) > travel || Math.Abs(p.Y - pr.P.Y) > travel || now - pr.At > TAP_MAX_MS)
            {
                // No tap: a drag, or a long press. With the companion on it is said ("lift") with its
                // stroke, and the page tells whether it is a ring; nothing is judged here.
                if (on && stroke != null)
                {
                    stroke = DragAdd(stroke, p);
                    Out.Send(new Dictionary<string, object>
                    {
                        { "ev", "lift" }, { "x", p.X }, { "y", p.Y }, { "window", pr.H.ToInt64() }, { "private", pr.Private },
                        { "points", LiftPoints(stroke, LIFT_POINTS) },
                    });
                }
                return;
            }
            int clicks = pr.Second ? lastClicks + 1 : 1;
            lastTapUpAt = now; lastTapAt = p; lastClicks = clicks;
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
            WheelStep step = Wheel(delta, horizontal, Win32.WheelPoints(Win32.FrameOf(hit.Window), Win32.ScaleOf(hit.Window)), Win32.WheelLines());
            // (only a move up or down explains the new look it settles into: a pan sideways leaves it
            // to be said, as a key's is)
            if (step.Scrolls) lock (Gate) lastScrollAt[hit.Window.ToInt64()] = Clock.Ms;
            if (!on && hit.Window != w) return;
            Out.Send(new Dictionary<string, object>
            {
                { "ev", "scroll" }, { "dy", step.Dy }, { "dx", step.Dx }, { "lines", step.Lines }, { "momentum", false }, { "window", hit.Window.ToInt64() },
            });
            lock (Gate) Burst(hit.Window);
        }

        /** What one wheel event says ("scroll"): the content moved up by Dy points and left by Dx;
         *  Lines, the wheel's lines in Dy's sense, by which the page learns the app's own step; and
         *  whether it is the window's scroll for the watch (Scrolls: a move up or down). */
        public struct WheelStep { public double Dy, Dx, Lines; public bool Scrolls; }

        /** A notch (120) moves `points` points, `lines` lines as Windows is set (a screen at a time, one);
         *  down the page is content moving up, and tilting right is content moving left. */
        public static WheelStep Wheel(int delta, bool horizontal, double points, double lines)
        {
            double notches = delta / 120.0;
            double dy = horizontal || delta == 0 ? 0 : -notches * points;
            double dx = !horizontal || delta == 0 ? 0 : notches * points;
            return new WheelStep { Dy = dy, Dx = dx, Lines = horizontal || delta == 0 ? 0 : -notches * lines, Scrolls = dy != 0 };
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
