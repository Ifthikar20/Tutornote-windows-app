// The mouse, heard and never taken: Windows' Raw Input, delivered to a hidden message-only window
// whatever app is in front (RIDEV_INPUTSINK). Every click and wheel still goes where it was going;
// no hook sits in the input's way, and the keyboard is not listened to at all.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Tutornote.Screen
{
    public static class Input
    {
        static WndProc proc; // (kept: the window calls it for the helper's whole life)

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
                        ushort flags = (ushort)Marshal.ReadInt16(buffer, Header + 4);
                        short data = Marshal.ReadInt16(buffer, Header + 6);
                        uint extra = (uint)Marshal.ReadInt32(buffer, Header + 20);
                        // (the helper's own scroll steps carry its mark: never the student's)
                        bool ours = extra == (uint)Turner.POSTED_BY_US.ToInt64();
                        try
                        {
                            if ((flags & Win32.RI_MOUSE_LEFT_DOWN) != 0) Watcher.OnLeftDown();
                            if ((flags & Win32.RI_MOUSE_LEFT_UP) != 0) Watcher.OnLeftUp();
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
