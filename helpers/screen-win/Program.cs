// tutornote-screen.exe: the Windows screen helper. The Windows twin of the Mac app's
// helpers/screen/main.swift, speaking the same JSON lines (src/main/screen.ts): one command per
// line on stdin ("cmd"), one answer or event per line on stdout ("ev"), its log on stderr. Built
// with the C# compiler that comes with Windows (.NET Framework 4.8): scripts/build-screen-helper.mjs.
//
// Points and boxes are physical screen pixels here; the app turns them into its own points
// (screen.ts). Window ids are window handles. Nothing it reads is written to its log: codes,
// counts and times only.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Tutornote.Screen
{
    public static class Out
    {
        static readonly object Gate = new object();
        static TextWriter writer;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public static void Init()
        {
            writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        }

        public static void Send(Dictionary<string, object> message)
        {
            string line = Json.Serialize(message);
            lock (Gate) { writer.WriteLine(line); }
        }

        public static void Error(long id, string code)
        {
            Send(new Dictionary<string, object> { { "id", id }, { "ev", "error" }, { "code", code } });
        }

        public static void Log(string line)
        {
            lock (Gate) { Console.Error.WriteLine("[screen-win] " + line); }
        }

        public static Dictionary<string, object> Parse(string line)
        {
            return Json.Deserialize<Dictionary<string, object>>(line);
        }
    }

    public static class J
    {
        public static double Num(Dictionary<string, object> m, string key, double fallback)
        {
            object v;
            if (m == null || !m.TryGetValue(key, out v) || v == null) return fallback;
            try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch (Exception) { return fallback; }
        }

        public static bool Has(Dictionary<string, object> m, string key) { object v; return m.TryGetValue(key, out v) && v != null; }

        public static string Str(Dictionary<string, object> m, string key)
        {
            object v;
            return m.TryGetValue(key, out v) && v is string ? (string)v : "";
        }

        public static bool Bool(Dictionary<string, object> m, string key)
        {
            object v;
            return m.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        public static List<double> Nums(Dictionary<string, object> m, string key)
        {
            var list = new List<double>();
            object v;
            if (!m.TryGetValue(key, out v) || !(v is IEnumerable) || v is string) return list;
            foreach (object o in (IEnumerable)v)
                try { list.Add(Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture)); } catch (Exception) { }
            return list;
        }

        public static List<string> Strs(Dictionary<string, object> m, string key)
        {
            var list = new List<string>();
            object v;
            if (!m.TryGetValue(key, out v) || !(v is IEnumerable) || v is string) return list;
            foreach (object o in (IEnumerable)v) if (o is string) list.Add((string)o);
            return list;
        }

        public static double R(double v) { return Math.Round(v, 1); }

        public static Dictionary<string, object> Frame(RECT r)
        {
            return new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "w", r.Width }, { "h", r.Height } };
        }
    }

    public static class Program
    {
        public static uint ParentPid;
        public static readonly long StartUnixMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;

        [STAThread]
        public static int Main(string[] args)
        {
            if (Array.IndexOf(args, "--selftest") >= 0) return SelfTest.Run();
            try { Win32.SetProcessDpiAwarenessContext(Win32.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch (EntryPointNotFoundException) { }
            Out.Init();

            string parentExe;
            ParentPid = Win32.ParentOf((uint)System.Diagnostics.Process.GetCurrentProcess().Id, out parentExe);
            string parent = Path.GetFileName(parentExe).ToLowerInvariant();
            bool devCopy = !AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\').EndsWith("resources", StringComparison.OrdinalIgnoreCase);
            if (parent != "tutornote.exe" && parent != "electron.exe" && !(devCopy && Array.IndexOf(args, "--any-parent") >= 0))
            {
                Out.Log("refused: started by " + (parent.Length > 0 ? parent : "an unknown program") + ", not Tutornote");
                return 1;
            }
            Out.Log("started (ocr " + (Ocr.Language.Length > 0 ? Ocr.Language : "none") + ")");

            Input.Start();
            Watcher.Start();

            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                Dictionary<string, object> cmd;
                try { cmd = Out.Parse(line); } catch (Exception) { Out.Log("a command that is not JSON"); continue; }
                try { Dispatch(cmd); } catch (Exception e) { Out.Log("command failed: " + e.GetType().Name); }
            }
            Out.Log("stdin closed: exiting");
            Environment.Exit(0);
            return 0;
        }

        static void Dispatch(Dictionary<string, object> cmd)
        {
            string name = J.Str(cmd, "cmd");
            long id = (long)J.Num(cmd, "id", -1);
            switch (name)
            {
                // Windows asks no permission of a desktop app to read the screen or post a page turn.
                case "status":
                case "request":
                    Out.Send(new Dictionary<string, object> { { "ev", "status" }, { "screen", true } });
                    break;
                case "ax":
                    Out.Send(new Dictionary<string, object> { { "ev", "ax" }, { "trusted", true } });
                    break;
                case "read":
                    ThreadPool.QueueUserWorkItem(delegate { Reader.Read(cmd, id); });
                    break;
                case "turn":
                    ThreadPool.QueueUserWorkItem(delegate { Turner.Turn(cmd, id); });
                    break;
                case "cancel":
                    Turner.Cancel(id);
                    break;
                case "watch":
                    Watcher.Watch(new IntPtr((long)J.Num(cmd, "window", 0)));
                    break;
                case "unwatch":
                    Watcher.Watch(IntPtr.Zero);
                    break;
                case "companion":
                    Watcher.Companion(J.Bool(cmd, "on"), J.Nums(cmd, "stop"), J.Strs(cmd, "private"), J.Strs(cmd, "readers"));
                    break;
                case "observe":
                    Watcher.Observe(J.Nums(cmd, "windows"));
                    break;
                case "front":
                    BringForward(new IntPtr((long)J.Num(cmd, "window", 0)));
                    break;
                case "chord":
                    // Control+Option has no Windows twin (Ctrl+Alt is AltGr on many keyboards): no chord yet.
                    if (J.Bool(cmd, "on"))
                        Out.Send(new Dictionary<string, object> { { "ev", "chord" }, { "kind", "state" }, { "on", false }, { "why", "hidden" } });
                    break;
                default:
                    if (id >= 0) Out.Error(id, "bad_command");
                    Out.Log("unknown command");
                    break;
            }
        }

        /**
         * A window read before, brought to the front: the board's "Back to {app}", and the keys given
         * back after a question typed to the tutor. Only while Tutornote has the front (it never takes
         * it from another app). Windows refuses a plain SetForegroundWindow from a background program,
         * so the helper joins the foreground thread (Tutornote's) for the hand-over, as Windows allows.
         */
        static void BringForward(IntPtr h)
        {
            if (!Win32.IsWindow(h)) return;
            IntPtr fg = Win32.GetForegroundWindow();
            uint fgPid;
            uint fgThread = Win32.GetWindowThreadProcessId(fg, out fgPid);
            if (fgPid != ParentPid) return;
            if (Win32.IsIconic(h)) Win32.ShowWindow(h, 9);
            uint me = Win32.GetCurrentThreadId();
            bool joined = fgThread != 0 && fgThread != me && Win32.AttachThreadInput(me, fgThread, true);
            try
            {
                Win32.BringWindowToTop(h);
                if (!Win32.SetForegroundWindow(h)) Out.Log("front: Windows kept the front where it was");
            }
            finally
            {
                if (joined) Win32.AttachThreadInput(me, fgThread, false);
            }
        }
    }

    public static class Reader
    {
        /** A window gone off screen for a moment (a desktop switch) is waited for this long. */
        const int SPACE_WAIT_MS = 1200;

        public static void Read(Dictionary<string, object> cmd, long id)
        {
            try
            {
                IntPtr h;
                long heldMs = 0;
                if (J.Has(cmd, "window"))
                {
                    h = new IntPtr((long)J.Num(cmd, "window", 0));
                    if (!Win32.IsWindow(h)) { Out.Error(id, "window_gone"); return; }
                    long until = Clock.Ms + SPACE_WAIT_MS, from = Clock.Ms;
                    while (!Windows.OnScreen(h) && Clock.Ms < until) Thread.Sleep(50);
                    if (!Windows.OnScreen(h)) { Out.Error(id, "window_gone"); return; }
                    heldMs = Clock.Ms - from;
                }
                else
                {
                    var p = new POINT((int)Math.Round(J.Num(cmd, "x", 0)), (int)Math.Round(J.Num(cmd, "y", 0)));
                    var skip = new HashSet<uint>();
                    foreach (double pid in J.Nums(cmd, "exclude")) skip.Add((uint)pid);
                    skip.Add(Program.ParentPid);
                    Hit hit = Windows.At(p, skip, 0, null);
                    if (hit.Window == IntPtr.Zero) { Out.Error(id, "no_window"); return; }
                    h = hit.Window;
                }
                bool fast = J.Str(cmd, "level") == "fast";
                var answer = ReadWindow(h, fast);
                if (answer == null) { Out.Error(id, "capture_failed"); return; }
                answer["id"] = id;
                if (heldMs > 50) answer["heldMs"] = heldMs;
                Out.Send(answer);
            }
            catch (Exception e)
            {
                Out.Log("read failed: " + e.GetType().Name);
                Out.Error(id, "capture_failed");
            }
        }

        /**
         * A read's answer, {"ev":"read"}: `app`, `bundle`, `title`, `window`, `pid`, `frame`, `lines`
         * (each with `t`, `c`, a box and its `words` with boxes), `captureMs`, `ocrMs`, `level`
         * ("fast" for a glance, "accurate"), `ground`; and, on an accurate read only, `rules`: the
         * lines the page draws for an answer (Rules.cs: solid, dotted or dashed; on a dark page its
         * light ones too), [{x0, x1, y}], the line's ends and its middle, an empty list when there
         * are none. A glance looks for none, and sends no `rules`. Every box and point in screen pixels.
         */
        public static Dictionary<string, object> ReadWindow(IntPtr h, bool fast)
        {
            RECT frame = Win32.FrameOf(h);
            AppInfo app = Apps.OfWindow(h);
            string title = Apps.TabTitle(app, Win32.TextOf(h));
            long t0 = Clock.Ms;
            bool fromScreen;
            Picture pic = Capture.Window(h, frame, out fromScreen);
            if (pic == null) return null;
            Look look = Capture.Thumb(frame);
            Watcher.Remember(h, look);
            long captureMs = Clock.Ms - t0;
            double scale = 1;
            Picture read = pic;
            if (fast && pic.W > 1600) { read = Capture.Half(pic); scale = 2; }
            long t1 = Clock.Ms;
            List<OcrLine> lines = Ocr.Read(read, frame.Left, frame.Top, scale);
            string level = fast ? "fast" : "accurate";
            // A glance that found nothing on a window that is not blank reads once more, in full.
            if (fast && scale > 1 && lines.Count == 0 && !Diff.Blank(look))
            {
                lines = Ocr.Read(pic, frame.Left, frame.Top, 1);
                level = "accurate";
            }
            long ocrMs = Clock.Ms - t1;
            double ground = Diff.Ground(look);
            // (the page's answer lines, from the whole picture before it goes: never on a glance)
            List<Rule> rules = level == "accurate" ? Rules.Of(pic, frame.Left, frame.Top, Win32.ScaleOf(h), lines, ground) : null;
            var outLines = new List<object>();
            foreach (var l in lines)
            {
                var words = new List<object>();
                foreach (var w in l.Words)
                    words.Add(new Dictionary<string, object> { { "t", w.T }, { "x", J.R(w.X) }, { "y", J.R(w.Y) }, { "w", J.R(w.W) }, { "h", J.R(w.H) } });
                outLines.Add(new Dictionary<string, object>
                {
                    { "t", l.T }, { "c", 1 }, { "x", J.R(l.X) }, { "y", J.R(l.Y) }, { "w", J.R(l.W) }, { "h", J.R(l.H) }, { "words", words },
                });
            }
            var answer = new Dictionary<string, object>
            {
                { "ev", "read" }, { "app", app.Name }, { "bundle", app.Bundle }, { "title", title },
                { "window", h.ToInt64() }, { "pid", (long)app.Pid }, { "frame", J.Frame(frame) }, { "lines", outLines },
                { "captureMs", captureMs }, { "ocrMs", ocrMs }, { "level", level }, { "ground", ground },
            };
            if (rules != null)
            {
                var outRules = new List<object>();
                foreach (var r in rules) outRules.Add(new Dictionary<string, object> { { "x0", J.R(r.X0) }, { "x1", J.R(r.X1) }, { "y", J.R(r.Y) } });
                answer["rules"] = outRules;
            }
            return answer;
        }
    }

    public static class Turner
    {
        const int POLL_MS = 100;
        const int KEY_GAP_MS = 250;
        /** Marks the helper's own input, so it never reports its own scroll as the student's. */
        public static readonly IntPtr POSTED_BY_US = new IntPtr(0x54555452); // "TUTR"
        static readonly Dictionary<long, bool> Cancelled = new Dictionary<long, bool>();

        public static void Cancel(long id) { lock (Cancelled) Cancelled[id] = true; }
        static bool IsCancelled(long id) { lock (Cancelled) { bool c; return Cancelled.TryGetValue(id, out c) && c; } }

        public static void Turn(Dictionary<string, object> cmd, long id)
        {
            try { DoTurn(cmd, id); }
            catch (Exception e) { Out.Log("turn failed: " + e.GetType().Name); Out.Error(id, "capture_failed"); }
            finally { lock (Cancelled) Cancelled.Remove(id); }
        }

        static void DoTurn(Dictionary<string, object> cmd, long id)
        {
            var h = new IntPtr((long)J.Num(cmd, "window", 0));
            uint pid = (uint)J.Num(cmd, "pid", 0);
            string how = J.Str(cmd, "how");
            int timeout = (int)Math.Max(100, Math.Min(600000, J.Num(cmd, "timeoutMs", 4000)));
            int count = (int)Math.Max(1, Math.Min(50, J.Num(cmd, "count", 1)));
            double dy = Math.Max(-20000, Math.Min(20000, J.Num(cmd, "dy", 0)));
            bool still = J.Bool(cmd, "still") && how == "manual";
            if (!Win32.IsWindow(h) || !Windows.OnScreen(h)) { Out.Error(id, "window_gone"); return; }
            if (pid != 0 && Apps.OfWindow(h).Pid != pid && Win32.PidOf(h) != pid) { Out.Error(id, "no_window"); return; }

            RECT frame = Win32.FrameOf(h);
            Look before = Capture.Thumb(frame);
            Look lastRead = Watcher.LastRead(h);
            if (J.Bool(cmd, "unlessMoved") && !still && lastRead != null && Diff.Middle(before, lastRead) > Diff.CHANGED_ABOVE)
            {
                Out.Send(new Dictionary<string, object> { { "id", id }, { "ev", "turned" }, { "changed", true }, { "settleMs", 0 }, { "moved", true } });
                return;
            }

            bool? front = null;
            if (how == "scroll")
            {
                var at = new POINT((int)Math.Round(J.Num(Sub(cmd, "at"), "x", frame.Left + frame.Width / 2)), (int)Math.Round(J.Num(Sub(cmd, "at"), "y", frame.Top + frame.Height / 2)));
                if (!frame.Contains(at)) at = new POINT(frame.Left + frame.Width / 2, frame.Top + frame.Height / 2);
                Watcher.QuietTurn(h);
                Scroll(h, at, dy, id);
            }
            else if (how == "key")
            {
                ushort vk = KeyOf(J.Str(cmd, "key"));
                if (vk == 0) { Out.Error(id, "bad_command"); return; }
                IntPtr fg = Win32.GetAncestor(Win32.GetForegroundWindow(), Win32.GA_ROOT);
                if (fg != h) { Win32.SetForegroundWindow(h); Thread.Sleep(80); fg = Win32.GetAncestor(Win32.GetForegroundWindow(), Win32.GA_ROOT); }
                front = fg == h;
                // (a key only ever goes to the window being read, never to whatever the student types into)
                if (front == true)
                {
                    Watcher.QuietTurn(h);
                    for (int i = 0; i < count && !IsCancelled(id); i++)
                    {
                        if (i > 0) Thread.Sleep(KEY_GAP_MS);
                        PressKey(vk);
                    }
                }
            }

            // Settling: a thumbnail every POLL_MS until the window has changed and two in a row agree.
            long start = Clock.Ms, until = start + timeout;
            Look prev = before, now = before;
            bool changed = false;
            while (Clock.Ms < until)
            {
                if (IsCancelled(id)) { Out.Error(id, "cancelled"); return; }
                Thread.Sleep(POLL_MS);
                if (!Win32.IsWindow(h)) { Out.Error(id, "window_gone"); return; }
                now = Capture.Thumb(Win32.FrameOf(h));
                bool agree = Diff.Mean(now, prev) < Diff.SETTLED_BELOW;
                if (still && agree)
                {
                    bool moved = lastRead == null || Diff.Middle(now, lastRead) > Diff.CHANGED_ABOVE;
                    Out.Send(new Dictionary<string, object> { { "id", id }, { "ev", "turned" }, { "changed", moved }, { "settleMs", Clock.Ms - start }, { "moved", false }, { "still", true } });
                    return;
                }
                if (!changed && Diff.Mean(now, before) > Diff.CHANGED_ABOVE) changed = true;
                if (changed && agree) break;
                prev = now;
            }
            var answer = new Dictionary<string, object>
            {
                { "id", id }, { "ev", "turned" }, { "changed", changed || Diff.Mean(now, before) > Diff.CHANGED_ABOVE },
                { "settleMs", Clock.Ms - start }, { "moved", false },
            };
            if (front.HasValue) answer["front"] = front.Value;
            if (still) answer["still"] = false;
            Out.Send(answer);
        }

        static Dictionary<string, object> Sub(Dictionary<string, object> m, string key)
        {
            object v;
            return m.TryGetValue(key, out v) ? v as Dictionary<string, object> : null;
        }

        static ushort KeyOf(string key)
        {
            switch (key)
            {
                case "right": return 0x27;
                case "left": return 0x25;
                case "pagedown": return 0x22;
                case "pageup": return 0x21;
                case "down": return 0x28;
                case "up": return 0x26;
                default: return 0;
            }
        }

        static void PressKey(ushort vk)
        {
            var down = new INPUT { type = Win32.INPUT_KEYBOARD };
            down.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = Win32.KEYEVENTF_EXTENDEDKEY, dwExtraInfo = POSTED_BY_US };
            var up = down;
            up.u.ki.dwFlags = Win32.KEYEVENTF_EXTENDEDKEY | Win32.KEYEVENTF_KEYUP;
            Win32.SendInput(2, new[] { down, up }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
        }

        /**
         * A scroll of `dy` points (positive shows later content) at `at`, where the Mac posts its wheel:
         * a notch (120 wheel units) per WheelPoints of content, in steps of one notch at most, 12 ms apart. The wheel goes to
         * the window at `at` when it is part of the one being read (else to that window itself), so a
         * sidebar under the cursor or another app lying over `at` never takes it. Only with the cursor
         * resting on `at` is it the system's own wheel, which goes where the cursor is.
         */
        static void Scroll(IntPtr h, POINT at, double dy, long id)
        {
            // (120 wheel units are one notch, which moves as many lines as Windows is set to)
            int total = (int)Math.Round(Math.Abs(dy) / Win32.WheelPoints(Win32.FrameOf(h), Win32.ScaleOf(h)) * 120);
            int sign = dy >= 0 ? -1 : 1;
            POINT cursor;
            Win32.GetCursorPos(out cursor);
            bool atCursor = Math.Abs(cursor.X - at.X) <= 4 && Math.Abs(cursor.Y - at.Y) <= 4
                && Windows.At(cursor, null, Program.ParentPid, null).Window == h;
            IntPtr target = Win32.WindowFromPoint(at);
            if (target == IntPtr.Zero || Win32.GetAncestor(target, Win32.GA_ROOT) != h) target = h;
            // (a window Windows stretches is told the point in its own, smaller coordinates)
            POINT posted = at;
            try { Win32.PhysicalToLogicalPointForPerMonitorDPI(target, ref posted); } catch (EntryPointNotFoundException) { posted = at; }
            while (total > 0 && !IsCancelled(id))
            {
                int step = Math.Min(120, total);
                total -= step;
                int delta = sign * step;
                if (atCursor)
                {
                    var wheel = new INPUT { type = Win32.INPUT_MOUSE };
                    wheel.u.mi = new MOUSEINPUT { mouseData = delta, dwFlags = Win32.MOUSEEVENTF_WHEEL, dwExtraInfo = POSTED_BY_US };
                    Win32.SendInput(1, new[] { wheel }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
                }
                else
                {
                    long w = ((long)(short)delta) << 16;
                    long l = ((long)(ushort)posted.Y << 16) | (ushort)posted.X;
                    Win32.PostMessage(target, Win32.WM_MOUSEWHEEL, new IntPtr(w), new IntPtr(l));
                }
                Thread.Sleep(12);
            }
        }
    }
}
