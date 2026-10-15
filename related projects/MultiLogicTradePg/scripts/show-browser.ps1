<#
  #997: поднять окно браузера с приложением MultiLogic Trade поверх всех окон.

  Браузер не может выйти на передний план из фоновой вкладки средствами JS
  (window.focus() лишь подсвечивает кнопку на панели задач). Поэтому локальный
  API (тот же ПК, что и браузер) запускает этот Windows-хелпер: он находит окно
  с заданным фрагментом заголовка (заголовок страницы — «MultiLogic Trade») и
  выводит его вперёд через SetForegroundWindow (+ трюк с AttachThreadInput). Если
  такого заголовка нет (пользователь ушёл на другую вкладку) — фолбэк на любое
  окно браузера (по имени процесса).

  Запускается из api/routes/terminal.js. Возвращает JSON { ok, title }.
  На не-Windows не вызывается.
#>
param(
  [string]$TitleMatch = 'MultiLogic Trade'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class MltWin
{
    // Процессы браузеров — фолбэк, когда активная вкладка не наше приложение
    // (тогда заголовок окна не содержит «MultiLogic Trade»).
    static readonly string[] BrowserProcs = {
        "chrome", "msedge", "brave", "firefox", "opera", "vivaldi",
        "chromium", "browser", "yandex"
    };

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
    [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern uint GetWindowPid(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    const int SW_RESTORE = 9;
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;

    public static string LastTitle = "";

    public static bool IsBrowserWindow(IntPtr h)
    {
        uint pid;
        GetWindowPid(h, out pid);
        if (pid == 0) return false;
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                string n = (p.ProcessName ?? "").ToLowerInvariant();
                return Array.IndexOf(BrowserProcs, n) >= 0;
            }
        }
        catch { return false; }
    }

    public static IntPtr Find(string match)
    {
        IntPtr titleMatch = IntPtr.Zero;
        string titleText = "";
        IntPtr browserMatch = IntPtr.Zero;
        string browserText = "";
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowText(h, sb, sb.Capacity);
            string t = sb.ToString();
            if (titleMatch == IntPtr.Zero &&
                t.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                titleMatch = h;
                titleText = t;
            }
            if (browserMatch == IntPtr.Zero && IsBrowserWindow(h))
            {
                browserMatch = h;
                browserText = t;
            }
            return true;
        }, IntPtr.Zero);
        // Приоритет — окно самого приложения (точный заголовок); иначе любое окно
        // браузера (пользователь мог уйти на другую вкладку — заголовок не наш).
        if (titleMatch != IntPtr.Zero)
        {
            LastTitle = titleText;
            return titleMatch;
        }
        LastTitle = browserText;
        return browserMatch;
    }

    public static bool Activate(string match)
    {
        IntPtr h = Find(match);
        if (h == IntPtr.Zero) return false;

        ShowWindow(h, SW_RESTORE);

        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint thisThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != thisThread)
            attached = AttachThreadInput(thisThread, fgThread, true);

        bool ok = BringWindowToTop(h);
        ok = SetForegroundWindow(h) || ok;

        if (attached) AttachThreadInput(thisThread, fgThread, false);

        if (!ok)
        {
            SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            ok = true;
        }
        return ok;
    }
}
"@

$ok = [MltWin]::Activate($TitleMatch)
[pscustomobject]@{ ok = $ok; title = [MltWin]::LastTitle } | ConvertTo-Json -Compress
