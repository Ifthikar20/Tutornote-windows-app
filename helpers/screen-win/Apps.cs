// Which app a window belongs to, said the way the shared rules expect it, and which window is
// under a point.
//
// The app's rules (companionPlace.ts, docIdentity.ts, and the web app's content kinds) know apps
// by their Mac bundle ids: com.google.Chrome is a browser, com.amazon.Kindle a reader,
// com.microsoft.Word an editor, com.1password.1password private. Those files are kept exactly as
// the Mac app has them (MAC_BASE), so this helper says a Windows app by the bundle id of its Mac
// twin (chrome.exe -> com.google.Chrome), and an app with no twin as "win.<exe name>". The id
// only ever names the app for those rules; it is never shown.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Tutornote.Screen
{
    public sealed class AppInfo
    {
        public uint Pid;
        public string Exe = "";     // lower case, "chrome.exe"
        public string Bundle = "";  // the rules' name for it
        public string Name = "";    // what people call it
        public bool Private;        // never pictured
    }

    public static class Apps
    {
        // exe -> (bundle id of the Mac twin, name)
        static readonly Dictionary<string, string[]> Twins = new Dictionary<string, string[]>
        {
            { "msedge.exe", new[] { "com.microsoft.edgemac", "Microsoft Edge" } },
            { "chrome.exe", new[] { "com.google.Chrome", "Google Chrome" } },
            { "firefox.exe", new[] { "org.mozilla.firefox", "Firefox" } },
            { "brave.exe", new[] { "com.brave.Browser", "Brave" } },
            { "opera.exe", new[] { "com.operasoftware.Opera", "Opera" } },
            { "vivaldi.exe", new[] { "com.vivaldi.Vivaldi", "Vivaldi" } },
            { "arc.exe", new[] { "company.thebrowser.Browser", "Arc" } },
            { "chromium.exe", new[] { "org.chromium.Chromium", "Chromium" } },
            // (the Mac's page-turning Kindle: PAGE_APPS turns its pages by key, as Kindle for PC's are)
            { "kindle.exe", new[] { "com.amazon.Lassen", "Kindle" } },
            { "acrord32.exe", new[] { "com.apple.Preview", "Adobe Acrobat Reader" } },
            { "acrobat.exe", new[] { "com.apple.Preview", "Adobe Acrobat" } },
            { "sumatrapdf.exe", new[] { "com.apple.Preview", "SumatraPDF" } },
            { "winword.exe", new[] { "com.microsoft.Word", "Microsoft Word" } },
            { "excel.exe", new[] { "com.microsoft.Excel", "Microsoft Excel" } },
            { "powerpnt.exe", new[] { "com.microsoft.Powerpoint", "Microsoft PowerPoint" } },
            { "onenote.exe", new[] { "com.apple.Notes", "OneNote" } },
            { "notepad.exe", new[] { "com.apple.TextEdit", "Notepad" } },
            { "code.exe", new[] { "com.microsoft.VSCode", "Visual Studio Code" } },
            { "cursor.exe", new[] { "com.todesktop.230313mzl4w4u92", "Cursor" } },
            { "notion.exe", new[] { "notion.id", "Notion" } },
            { "obsidian.exe", new[] { "md.obsidian", "Obsidian" } },
            { "windowsterminal.exe", new[] { "com.apple.Terminal", "Terminal" } },
            { "explorer.exe", new[] { "com.apple.finder", "File Explorer" } },
            { "1password.exe", new[] { "com.1password.1password", "1Password" } },
            { "bitwarden.exe", new[] { "com.bitwarden.desktop", "Bitwarden" } },
            { "systemsettings.exe", new[] { "com.apple.systempreferences", "Settings" } },
        };

        // Never pictured, whatever the app asks: password managers, Windows' own security and sign-in
        // screens, and remote or virtual machines (someone else's screen).
        static readonly HashSet<string> PrivateExes = new HashSet<string>
        {
            "1password.exe", "bitwarden.exe", "keepass.exe", "keepassxc.exe", "dashlane.exe", "lastpass.exe",
            "nordpass.exe", "roboform.exe", "enpass.exe", "systemsettings.exe", "credentialuibroker.exe",
            "consent.exe", "lockapp.exe", "logonui.exe", "sechealthui.exe", "securityhealthsystray.exe",
            "mstsc.exe", "msrdc.exe", "vmconnect.exe", "vmware.exe", "virtualboxvm.exe",
        };

        static readonly Dictionary<uint, AppInfo> Known = new Dictionary<uint, AppInfo>();
        static readonly object KnownLock = new object();

        public static string BundleFor(string exe)
        {
            string[] twin;
            if (Twins.TryGetValue(exe, out twin)) return twin[0];
            return "win." + (exe.EndsWith(".exe") ? exe.Substring(0, exe.Length - 4) : exe);
        }

        public static bool IsPrivateExe(string exe) { return PrivateExes.Contains(exe); }

        public static AppInfo Of(uint pid)
        {
            lock (KnownLock)
            {
                AppInfo known;
                if (Known.TryGetValue(pid, out known)) return known;
            }
            var info = new AppInfo { Pid = pid };
            string path = Win32.ExePathOf(pid);
            info.Exe = Path.GetFileName(path).ToLowerInvariant();
            info.Bundle = info.Exe.Length > 0 ? BundleFor(info.Exe) : "";
            string[] twin;
            if (Twins.TryGetValue(info.Exe, out twin)) info.Name = twin[1];
            else
            {
                try { info.Name = FileVersionInfo.GetVersionInfo(path).FileDescription ?? ""; } catch (Exception) { }
                if (info.Name.Trim().Length == 0) info.Name = Path.GetFileNameWithoutExtension(path);
            }
            info.Private = IsPrivateExe(info.Exe);
            lock (KnownLock) { if (Known.Count > 500) Known.Clear(); Known[pid] = info; }
            return info;
        }

        /** The app a window really belongs to: a Store app's frame (ApplicationFrameHost) holds the
         *  app's own window as a child, in the app's own process. */
        public static AppInfo OfWindow(IntPtr h)
        {
            uint pid = Win32.PidOf(h);
            var app = Of(pid);
            if (app.Exe != "applicationframehost.exe") return app;
            uint inner = 0;
            Win32.EnumChildWindows(h, delegate (IntPtr child, IntPtr l)
            {
                if (Win32.ClassOf(child) == "Windows.UI.Core.CoreWindow")
                {
                    uint p = Win32.PidOf(child);
                    if (p != pid) { inner = p; return false; }
                }
                return true;
            }, IntPtr.Zero);
            return inner != 0 ? Of(inner) : app;
        }

        // A browser's own ending of its window's title, after the tab's: " - Google Chrome", Edge's
        // " and 2 more pages - Personal - Microsoft Edge" (the "Microsoft Edge" with a zero-width space).
        static readonly System.Text.RegularExpressions.Regex EdgeName = new System.Text.RegularExpressions.Regex(
            @" - Microsoft​?\s?Edge(?: Beta| Dev| Canary)?$");
        static readonly System.Text.RegularExpressions.Regex EdgeMore = new System.Text.RegularExpressions.Regex(
            @" and \d+ more pages?$");

        /**
         * Edge's window title, "<tab>[ and N more pages][ - <profile>] - Microsoft Edge", as the tab's
         * own title. The tab's title may hold " - " parts of its own ("Cells - Wikipedia"), so a profile
         * part is cut only when it is one of `profiles` (this PC's Edge profiles: EdgeProfiles).
         */
        public static string EdgeTitle(string title, ICollection<string> profiles)
        {
            string t = EdgeName.Replace(title, "");
            if (t == title) return title;
            foreach (string p in profiles)
            {
                if (string.IsNullOrEmpty(p)) continue;
                string end = " - " + p;
                if (t.EndsWith(end, StringComparison.Ordinal)) { t = t.Substring(0, t.Length - end.Length); break; }
            }
            return EdgeMore.Replace(t, "");
        }

        static readonly object ProfilesGate = new object();
        static List<string> edgeProfiles;
        static long edgeProfilesAt = -100000;

        /** This PC's Edge profile names (Edge's own Local State file, read again at most every 30 s), and
         *  the names Edge gives a private or guest window. */
        public static List<string> EdgeProfiles()
        {
            lock (ProfilesGate)
            {
                if (edgeProfiles != null && Clock.Ms - edgeProfilesAt < 30000) return edgeProfiles;
                var names = new List<string> { "InPrivate", "[InPrivate]", "Guest" };
                string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                foreach (string channel in new[] { "Edge", "Edge Beta", "Edge Dev", "Edge SxS" })
                {
                    string file = Path.Combine(root, "Microsoft", channel, "User Data", "Local State");
                    try
                    {
                        if (!File.Exists(file)) continue;
                        var state = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = int.MaxValue }
                            .Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                        object profile, cache;
                        if (!state.TryGetValue("profile", out profile) || !(profile is Dictionary<string, object>)) continue;
                        if (!((Dictionary<string, object>)profile).TryGetValue("info_cache", out cache) || !(cache is Dictionary<string, object>)) continue;
                        foreach (object entry in ((Dictionary<string, object>)cache).Values)
                        {
                            var e = entry as Dictionary<string, object>;
                            object name;
                            if (e != null && e.TryGetValue("name", out name) && name is string && ((string)name).Length > 0 && !names.Contains((string)name))
                                names.Add((string)name);
                        }
                    }
                    catch (Exception) { }
                }
                // (longest first: "Work (2)" before "Work")
                names.Sort((a, b) => b.Length.CompareTo(a.Length));
                edgeProfiles = names;
                edgeProfilesAt = Clock.Ms;
                return names;
            }
        }
        static readonly System.Text.RegularExpressions.Regex ChromiumEnd = new System.Text.RegularExpressions.Regex(
            @" - (?:Google Chrome(?: Beta| Dev| Canary)?|Chromium|Brave|Opera|Vivaldi)$");
        static readonly System.Text.RegularExpressions.Regex FirefoxEnd = new System.Text.RegularExpressions.Regex(
            @" (?:-|—) (?:Mozilla Firefox|Firefox(?: Developer Edition| Nightly)?)(?: Private Browsing)?$");

        /**
         * The tab's title alone, as the Mac's window list says a browser window's (the shared rules look
         * for ".pdf", "Google Slides" and the like at its end): a Windows browser's window title carries
         * the browser's name, Edge's also its profile and how many more tabs it has. Any other app's
         * title is as Windows has it.
         */
        public static string TabTitle(AppInfo app, string title)
        {
            if (string.IsNullOrEmpty(title)) return title ?? "";
            switch (app.Bundle)
            {
                case "com.microsoft.edgemac": return EdgeTitle(title, EdgeProfiles());
                case "com.google.Chrome":
                case "org.chromium.Chromium":
                case "com.brave.Browser":
                case "com.operasoftware.Opera":
                case "com.vivaldi.Vivaldi":
                    return ChromiumEnd.Replace(title, "");
                case "org.mozilla.firefox": return FirefoxEnd.Replace(title, "");
                default: return title;
            }
        }

        /** A browser's private window: its title says so ("InPrivate", "Incognito", "Private Browsing"). */
        public static bool PrivateTitle(AppInfo app, string title)
        {
            string b = app.Bundle;
            bool browser = b == "com.microsoft.edgemac" || b == "com.google.Chrome" || b == "org.mozilla.firefox" || b == "com.brave.Browser"
                || b == "com.operasoftware.Opera" || b == "com.vivaldi.Vivaldi" || b == "org.chromium.Chromium";
            if (!browser) return false;
            return title.IndexOf("InPrivate", StringComparison.OrdinalIgnoreCase) >= 0
                || title.IndexOf("Incognito", StringComparison.OrdinalIgnoreCase) >= 0
                || title.IndexOf("Private Browsing", StringComparison.OrdinalIgnoreCase) >= 0
                || title.IndexOf("Private window", StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }

    /** What is at a point: an ordinary window, one of Tutornote's own, or nothing (the taskbar, the desktop, a menu). */
    public sealed class Hit
    {
        public IntPtr Window = IntPtr.Zero;
        public bool Own;
        public bool Nothing { get { return Window == IntPtr.Zero && !Own; } }
    }

    public static class Windows
    {
        /** Shown, not minimised, not on another virtual desktop, at least 40 points each way, not see-through. */
        public static bool Ordinary(IntPtr h)
        {
            if (!Win32.IsWindowVisible(h) || Win32.IsIconic(h) || Win32.Cloaked(h)) return false;
            RECT r = Win32.FrameOf(h);
            double s = Win32.ScaleOf(h);
            if (r.Width <= 40 * s || r.Height <= 40 * s) return false;
            long ex = Win32.ExStyle(h);
            if ((ex & Win32.WS_EX_LAYERED) != 0)
            {
                uint key, flags; byte alpha;
                if (Win32.GetLayeredWindowAttributes(h, out key, out alpha, out flags) && (flags & 0x2) != 0 && alpha < 13) return false;
            }
            return true;
        }

        public static bool IsNothing(IntPtr h)
        {
            if (NothingClass(Win32.ClassOf(h))) return true;
            return NothingExe(Apps.Of(Win32.PidOf(h)).Exe);
        }

        static bool NothingClass(string cls) { return NothingClassSet.Contains(cls); }
        static bool NothingExe(string exe) { return NothingExeSet.Contains(exe); }
        // Windows' own pieces that are no page: the taskbar, the desktop, menus, tooltips, Start, search.
        static readonly HashSet<string> NothingClassSet = new HashSet<string>(new[]
        {
            "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "#32768", "tooltips_class32",
            "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland", "Xaml_WindowedPopupClass",
            "ForegroundStaging", "MultitaskingViewFrame", "TaskListThumbnailWnd", "XamlExplorerHostIslandWindow",
        });
        static readonly HashSet<string> NothingExeSet = new HashSet<string>(new[]
        {
            "startmenuexperiencehost.exe", "searchhost.exe", "searchapp.exe", "shellexperiencehost.exe", "textinputhost.exe",
            "shellhost.exe",
        });

        /** Windows' own shell in front (the taskbar, Start, search, Quick Settings, Alt-Tab): no app the
         *  student went to, as the Mac's Dock and menu bar never are. The desktop is (Explorer, as Finder). */
        public static bool IsShell(IntPtr h)
        {
            string cls = Win32.ClassOf(h);
            return cls != "Progman" && cls != "WorkerW" && IsNothing(h);
        }

        /**
         * The window on top at a point, front to back. Click-through windows (Tutornote's lesson layer
         * among them) are looked through; the processes in `skip` are looked through (a read skips
         * Tutornote's own); a window of `ownPid`, or one in `stop`, is Tutornote's own; Windows' own
         * pieces are nothing.
         */
        public static Hit At(POINT p, ICollection<uint> skip, uint ownPid, ICollection<long> stop)
        {
            var hit = new Hit();
            for (IntPtr h = Win32.GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = Win32.GetWindow(h, Win32.GW_HWNDNEXT))
            {
                if (!Win32.IsWindowVisible(h) || Win32.IsIconic(h)) continue;
                RECT r = Win32.FrameOf(h);
                if (!r.Contains(p)) continue;
                if (Win32.Cloaked(h)) continue;
                long ex = Win32.ExStyle(h);
                if ((ex & Win32.WS_EX_TRANSPARENT) != 0) continue;
                uint pid = Win32.PidOf(h);
                if (skip != null && skip.Contains(pid)) continue;
                if (stop != null && stop.Contains(h.ToInt64()))
                {
                    hit.Own = true;
                    return hit;
                }
                if (ownPid != 0 && pid == ownPid)
                {
                    // Tutornote's own: its ordinary windows; its other floating ones (the lesson's layer,
                    // which takes clicks only over the card and the dock) are looked through, as on the Mac.
                    if ((ex & Win32.WS_EX_TOPMOST) != 0) continue;
                    hit.Own = true;
                    return hit;
                }
                if (IsNothing(h)) return hit;
                if (!Ordinary(h)) continue;
                hit.Window = h;
                return hit;
            }
            return hit;
        }

        /** The foreground window, when it is an ordinary one. */
        public static IntPtr Front()
        {
            IntPtr h = Win32.GetForegroundWindow();
            if (h == IntPtr.Zero) return IntPtr.Zero;
            IntPtr root = Win32.GetAncestor(h, Win32.GA_ROOT);
            if (root != IntPtr.Zero) h = root;
            return Ordinary(h) && !IsNothing(h) ? h : IntPtr.Zero;
        }

        public static bool OnScreen(IntPtr h)
        {
            return Win32.IsWindow(h) && Win32.IsWindowVisible(h) && !Win32.IsIconic(h) && !Win32.Cloaked(h);
        }

        /** Whether the keys and the screen are Windows' own now (a UAC prompt, the lock screen). */
        public static bool SecureDesktop()
        {
            IntPtr desk = Win32.OpenInputDesktop(0, false, 0x0001);
            if (desk == IntPtr.Zero) return true;
            try
            {
                var sb = new StringBuilder(64);
                int needed;
                if (!Win32.GetUserObjectInformation(desk, 2, sb, sb.Capacity * 2, out needed)) return false;
                return !string.Equals(sb.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
            }
            finally { Win32.CloseDesktop(desk); }
        }
    }
}
