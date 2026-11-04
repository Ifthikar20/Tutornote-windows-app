// The mouse, heard and never taken: Windows' Raw Input, delivered to a hidden message-only window
// whatever app is in front (RIDEV_INPUTSINK). Every click, move and wheel still goes where it was going;
// no hook sits in the input's way, and the keyboard is not listened to at all: that a key went down
// is told from the time of the last input of any kind, which no mouse event explains (KeyAt), so
// which key is never known here. The Mac's lastEventAt(.keyDown): when, never which key.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Tutornote.Screen
{
    public static class Input
    {
        static WndProc proc; // (kept: the window calls it for the helper's whole life)

        /** GetTickCount when the mouse last did anything (Raw Input hears every event of it). */
        static int lastMouseTick;
        /** The last input is a mouse's when it came this long or less before that mouse event was heard
         *  (the two clocks tick every 16 ms or so); and it is judged only once this old, so a mouse
         *  event still on its way to this window is not taken for a key. */
        const uint MOUSE_SLACK_MS = 32;

        /** Whether the last input, `inputTick`, is one no mouse event explains, the mouse's last being
         *  `mouseTick`, `nowTick` being the time now (GetTickCount's, which wraps). A key, as a rule; a
         *  touch screen's tap or a pen says the same, and a key is all that is said of it. */
        public static bool NoMouseExplains(uint inputTick, uint mouseTick, uint nowTick)
        {
            uint age = unchecked(nowTick - inputTick);
            if (age < MOUSE_SLACK_MS || age > 60000) return false;
            return unchecked((int)(inputTick - mouseTick)) > (int)MOUSE_SLACK_MS;
        }

        /** When a key last went down, on Clock.Ms, if one did in the last minute. */
        public static bool KeyAt(out long at)
        {
            at = 0;
            uint input;
            if (!Win32.LastInputTick(out input)) return false;
            uint now = unchecked((uint)Environment.TickCount), mouse = unchecked((uint)Volatile.Read(ref lastMouseTick));
            if (!NoMouseExplains(input, mouse, now)) return false;
            at = Clock.Ms - unchecked(now - input);
            return true;
        }

        public static void Start()
        {
            var t = new Thread(Run) { IsBackground = true, Name = "input" };
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        static void Run()
        {
            proc = WndProcOf;
            var wc = new WNDCLASSEX
            {
                cbSize = Marshal.SizeOf(typeof(WNDCLASSEX)),
                lpfnWndProc = proc,
                hInstance = Win32.GetModuleHandle(IntPtr.Zero),
                lpszClassName = "TutornoteScreenInput",
            };
            if (Win32.RegisterClassEx(ref wc) == 0) { Out.Log("input: no window class (" + Marshal.GetLastWin32Error() + ")"); return; }
            IntPtr hwnd = Win32.CreateWindowEx(0, wc.lpszClassName, "", 0, 0, 0, 0, 0, Win32.HWND_MESSAGE, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
            if (hwnd == IntPtr.Zero) { Out.Log("input: no window"); return; }
            var mouse = new[] { new RAWINPUTDEVICE { UsagePage = 0x01, Usage = 0x02, Flags = Win32.RIDEV_INPUTSINK, Target = hwnd } };
            if (!Win32.RegisterRawInputDevices(mouse, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)))) { Out.Log("input: raw input refused"); return; }
            MSG msg;
            while (Win32.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                Win32.TranslateMessage(ref msg);
                Win32.DispatchMessage(ref msg);
            }
        }

        /** Raw Input's flags for the primary button going down and up. */
        public static void PrimaryFlags(bool swapped, out ushort down, out ushort up)
        {
            down = swapped ? Win32.RI_MOUSE_RIGHT_DOWN : Win32.RI_MOUSE_LEFT_DOWN;
            up = swapped ? Win32.RI_MOUSE_RIGHT_UP : Win32.RI_MOUSE_LEFT_UP;
        }

        // RAWINPUTHEADER is 24 bytes on 64-bit Windows (16 on 32-bit); RAWMOUSE follows it:
        // usFlags (2), padding (2), usButtonFlags (2), usButtonData (2), ulRawButtons (4), lLastX, lLastY, ulExtraInformation.
        static readonly int Header = IntPtr.Size == 8 ? 24 : 16;

        static IntPtr WndProcOf(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
        {
            if (message != Win32.WM_INPUT) return Win32.DefWindowProc(hwnd, message, wParam, lParam);
            uint size = 0;
            uint headerSize = (uint)Header;
            Win32.GetRawInputData(lParam, Win32.RID_INPUT, IntPtr.Zero, ref size, headerSize);
            if (size == 0 || size > 1024) return Win32.DefWindowProc(hwnd, message, wParam, lParam);
            IntPtr buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                if (Win32.GetRawInputData(lParam, Win32.RID_INPUT, buffer, ref size, headerSize) == size)
                {
                    int type = Marshal.ReadInt32(buffer, 0);
                    if (type == 0)
                    {
                        Volatile.Write(ref lastMouseTick, Environment.TickCount);
                        ushort flags = (ushort)Marshal.ReadInt16(buffer, Header + 4);
                        short data = Marshal.ReadInt16(buffer, Header + 6);
                        uint extra = (uint)Marshal.ReadInt32(buffer, Header + 20);
                        // (the helper's own scroll steps carry its mark: never the student's)
                        bool ours = extra == (uint)Turner.POSTED_BY_US.ToInt64();
                        try
                        {
                            // Raw Input says the physical button: with the buttons swapped (left-handed),
                            // the primary click is the right one.
                            ushort down, up;
                            PrimaryFlags(Win32.ButtonsSwapped(), out down, out up);
                            // (any mouse event may have moved it: the cursor fed to the app, a drag's stroke)
                            Watcher.OnMove();
                            if ((flags & down) != 0) Watcher.OnLeftDown();
                            if ((flags & up) != 0) Watcher.OnLeftUp();
                            if (!ours && (flags & Win32.RI_MOUSE_WHEEL) != 0) Watcher.OnWheel(data, false);
                            if (!ours && (flags & Win32.RI_MOUSE_HWHEEL) != 0) Watcher.OnWheel(data, true);
                        }
                        catch (Exception e) { Out.Log("input event failed: " + e.GetType().Name); }
                    }
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
            return Win32.DefWindowProc(hwnd, message, wParam, lParam);
        }
    }
}
