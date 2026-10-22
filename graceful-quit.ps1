<#
.SYNOPSIS
  Ask the DSH desktop shell to quit the way the tray menu does.

.DESCRIPTION
  The Electron main process is the only place that can run `app.quit()`, and a
  plugin (which lives in the Host child process) has no channel to it. What it
  does have is a window: the shell keeps a `session-end` listener on Windows,
  and when the window receives a session-end notification the shell marks that
  the session is ending and lets the next close through instead of hiding to
  the tray.

  Measured behaviour of that route: the notification makes Chromium tear every
  top-level window down within a hundred milliseconds and the process then exits
  on its own with code 0, so the shell's own quit path (and with it
  `tray.destroy()`) does not get to run — the tray icon is left registered and
  Explorer keeps a dead icon until it is hovered. The icon is therefore removed
  from here first, by window and id, which needs no cooperation from the shell.

  So this script does four things:

    0. `Shell_NotifyIcon(NIM_DELETE)` on the shell's notification-area window,
       so the tray entry cannot outlive the process;
    1. `WM_QUERYENDSESSION`, sent rather than posted so the window's answer can
       be read: Windows only delivers the following notification to a window
       that agreed to the session ending, and Chromium tracks that answer;
    2. `WM_ENDSESSION` (wParam 1 = the session really is ending), which is the
       notification Electron turns into `session-end`;
    3. `WM_CLOSE`, once the listener has had a moment to run.

  Only the query is sent (bounded by `SendMessageTimeout`), because its reply is
  the point; the other two are posted, so nothing here can block on a window
  that is not pumping messages. If the shell does not honour them the relauncher
  falls back to terminating the process, which is what it always did.

  `-Mode probe` only reports the windows it found and sends nothing, so the
  lookup can be checked without ending anyone's session.

.PARAMETER TargetPid
  The Electron main process that owns the window, i.e. the process to notify.

.PARAMETER Mode
  `probe` reports the windows; `quit` also posts the messages.

.PARAMETER LogPath
  File to append diagnostics to. Without it the lines go to the console.

.EXAMPLE
  powershell -NoProfile -File graceful-quit.ps1 -TargetPid 1234 -Mode probe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 4294967295)]
  [int]$TargetPid,

  [ValidateSet('probe', 'quit')]
  [string]$Mode = 'probe',

  [string]$LogPath
)

$ErrorActionPreference = 'Stop'

# $Pid is a read-only automatic variable in PowerShell, hence $TargetPid.

function Write-GraceLine {
  param([string]$Message)
  $line = '[' + (Get-Date).ToUniversalTime().ToString('o') + '] [grace] ' + $Message
  if ([string]::IsNullOrWhiteSpace($LogPath)) {
    Write-Output $line
    return
  }
  try {
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # Diagnostics must never decide whether a restart happens.
  }
}

$definition = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWindowProbe
{
    public const uint WmClose = 0x0010;
    public const uint WmQueryEndSession = 0x0011;
    public const uint WmEndSession = 0x0016;
    public const uint SmtoAbortIfHung = 0x0002;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int capacity);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint message, IntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    public static IntPtr[] TopLevelWindows(uint processId)
    {
        var found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr handle, IntPtr state)
        {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner == processId) found.Add(handle);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }

    public static string ClassName(IntPtr handle)
    {
        var buffer = new StringBuilder(256);
        GetClassName(handle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static bool QueryEndSession(IntPtr handle, out long answer)
    {
        IntPtr result;
        IntPtr delivery = SendMessageTimeout(handle, WmQueryEndSession, IntPtr.Zero, IntPtr.Zero,
            SmtoAbortIfHung, 1000, out result);
        answer = result.ToInt64();
        return delivery != IntPtr.Zero;
    }

    public static bool PostEndSession(IntPtr handle)
    {
        return PostMessage(handle, WmEndSession, new IntPtr(1), IntPtr.Zero);
    }

    public static bool PostClose(IntPtr handle)
    {
        return PostMessage(handle, WmClose, IntPtr.Zero, IntPtr.Zero);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct NotifyIconData
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    public const uint NimDelete = 0x00000002;

    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Shell_NotifyIcon(uint message, ref NotifyIconData data);

    /**
     * Take one notification-area icon out of the tray.
     * The shell identifies an icon by the window and the id that added it, so the
     * icon can be removed from here even though the shell process owns it.
     */
    public static bool DeleteTrayIcon(IntPtr window, uint id)
    {
        var data = new NotifyIconData();
        data.cbSize = (uint)Marshal.SizeOf(typeof(NotifyIconData));
        data.hWnd = window;
        data.uID = id;
        return Shell_NotifyIcon(NimDelete, ref data);
    }

    /** Every top-level window of that process as "0xHWND:class", for before/after diffing. */
    public static string WindowClasses(uint processId)
    {
        var parts = new List<string>();
        EnumWindows(delegate(IntPtr handle, IntPtr state)
        {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner == processId)
                parts.Add("0x" + handle.ToInt64().ToString("X") + ":" + ClassName(handle));
            return true;
        }, IntPtr.Zero);
        return string.Join(", ", parts.ToArray());
    }

    /** Whether a window of that class still belongs to the process. */
    public static bool ClassPresent(uint processId, string className)
    {
        bool found = false;
        EnumWindows(delegate(IntPtr handle, IntPtr state)
        {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner == processId && ClassName(handle) == className) found = true;
            return true;
        }, IntPtr.Zero);
        return found;
    }
}

public static class DshProcessState
{
    public const uint Synchronize = 0x00100000;
    public const uint QueryLimitedInformation = 0x1000;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    /** Hold the process so its exit and exit code can be observed later. */
    public static IntPtr Open(uint processId)
    {
        return OpenProcess(Synchronize | QueryLimitedInformation, false, processId);
    }

    /** True when the process ended within the wait. */
    public static bool Wait(IntPtr handle, uint milliseconds)
    {
        return WaitForSingleObject(handle, milliseconds) == 0;
    }

    public static string ExitCode(IntPtr handle)
    {
        uint code;
        return GetExitCodeProcess(handle, out code) ? code.ToString() : "unknown";
    }

    public static void Release(IntPtr handle)
    {
        if (handle != IntPtr.Zero) CloseHandle(handle);
    }
}
'@

try {
  Add-Type -TypeDefinition $definition -ErrorAction Stop
} catch {
  Write-GraceLine ('cannot declare the Win32 helpers: ' + $_.Exception.Message)
  exit 1
}

$windows = [DshWindowProbe]::TopLevelWindows([uint32]$TargetPid)
Write-GraceLine ('top-level windows of pid ' + $TargetPid + ': ' + $windows.Length)

# Only Chromium widget windows carry a BrowserWindow: they are the ones with the
# shell's `session-end` and `close` listeners. The rest of a process's top-level
# windows are helpers (tray host, IME, power monitor) that must be left alone.
$targets = New-Object 'System.Collections.Generic.List[System.IntPtr]'
foreach ($window in $windows) {
  $class = [DshWindowProbe]::ClassName($window)
  $visible = [DshWindowProbe]::IsWindowVisible($window)
  if ($class -eq 'Chrome_WidgetWin_1') {
    $targets.Add($window)
    $role = 'target '
  } else {
    $role = 'skipped'
  }
  Write-GraceLine ('  ' + $role + ' hwnd=0x' + $window.ToInt64().ToString('X') + ' class=' + $class + ' visible=' + $visible)
}

if ($Mode -eq 'probe') {
  Write-GraceLine ('probe mode: ' + $targets.Count + ' window(s) would be asked to end the session; nothing was sent')
  exit 0
}

if ($targets.Count -eq 0) {
  Write-GraceLine 'no BrowserWindow belongs to that pid; nothing was sent'
  exit 2
}

# Take the notification icon out first. The shell unregisters it from its own
# quit path, but the session-end notification tears the helper windows down
# before that path can run, and Electron never gets to call `tray.destroy()`:
# Explorer then keeps a dead icon that only goes away when it is hovered. The
# shell identifies an icon by (window, id), so it can be removed from here.
#
# Every id the shell accepts is reported, not just the first one: the count
# tells whether the app had a single icon or several were left behind.
function Remove-TrayIcon {
  param([IntPtr]$Window, [string]$When)
  if ($Window -eq [IntPtr]::Zero) {
    Write-GraceLine ('  no tray host window ' + $When)
    return
  }
  $removed = New-Object 'System.Collections.Generic.List[int]'
  foreach ($id in 0, 1, 2, 3, 4, 5) {
    $ok = $false
    try {
      $ok = [DshWindowProbe]::DeleteTrayIcon($Window, [uint32]$id)
    } catch {
      $ok = $false
    }
    if ($ok) { $removed.Add($id) }
  }
  $label = 'hwnd=0x' + $Window.ToInt64().ToString('X')
  if ($removed.Count -eq 0) {
    Write-GraceLine ('  no tray icon to remove ' + $When + ' (' + $label + ')')
  } else {
    Write-GraceLine ('  removed tray icon id=' + ($removed -join ',') + ' ' + $When + ' (' + $label + ')')
  }
}

$trayHost = [IntPtr]::Zero
foreach ($window in $windows) {
  if ([DshWindowProbe]::ClassName($window) -eq 'Electron_NotifyIconHostWindow') {
    $trayHost = $window
  }
}

Remove-TrayIcon -Window $trayHost -When 'before the session-end notification'
# If an icon comes back, something re-added it while the shell was still
# running; the second sweep a moment later says so.
Start-Sleep -Milliseconds 150
Remove-TrayIcon -Window $trayHost -When '150ms after the first removal'

# Ask each window first: Windows only sends the end-session notification to a
# window that answered the query, and Chromium records that answer.
foreach ($window in $targets) {
  [long]$answer = 0
  try {
    $delivered = [DshWindowProbe]::QueryEndSession($window, [ref]$answer)
  } catch {
    $delivered = 'failed: ' + $_.Exception.Message
  }
  Write-GraceLine ('  asked hwnd=0x' + $window.ToInt64().ToString('X') + ' to end the session: delivered=' + $delivered + ' answer=' + $answer)
}

# Session-end next: the shell flips to "ending" in that handler, and only then
# does a close get past the window's own hide-to-tray guard.
#
# The handle is opened before the notifications so the process itself can be
# watched afterwards: its exit code and the moment it ends are the only direct
# evidence of whether the shell ran its own quit path or was taken down by the
# window teardown.
$watched = [DshProcessState]::Open([uint32]$TargetPid)
if ($watched -eq [IntPtr]::Zero) {
  Write-GraceLine ('cannot open pid ' + $TargetPid + ' for observation; continuing without it')
}

$processId = [uint32]$TargetPid
foreach ($window in $targets) {
  [void][DshWindowProbe]::PostEndSession($window)
}
Write-GraceLine 'posted WM_ENDSESSION; waiting for the shell to mark the session as ending'

# The tray icon is unregistered by the shell's quit path, which runs after the
# close. If the notification makes Chromium tear its helper windows down first,
# that unregister has no window left to talk to, and Explorer keeps a stale icon
# until it is hovered. Sample the helper window across the gap to see which way
# it goes.
Start-Sleep -Milliseconds 100
Write-GraceLine ('  after WM_ENDSESSION +100ms: tray host window present=' + [DshWindowProbe]::ClassPresent($processId, 'Electron_NotifyIconHostWindow'))
Write-GraceLine ('  windows now: ' + [DshWindowProbe]::WindowClasses($processId))
Start-Sleep -Milliseconds 180
Write-GraceLine ('  after WM_ENDSESSION +280ms: tray host window present=' + [DshWindowProbe]::ClassPresent($processId, 'Electron_NotifyIconHostWindow'))

foreach ($window in $targets) {
  [void][DshWindowProbe]::PostClose($window)
}
Write-GraceLine ('posted WM_CLOSE to ' + $targets.Count + ' window(s)')

if ($watched -ne [IntPtr]::Zero) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  if ([DshProcessState]::Wait($watched, 4000)) {
    Write-GraceLine ('main process exited ' + $clock.ElapsedMilliseconds + 'ms after WM_CLOSE, exit code ' + [DshProcessState]::ExitCode($watched))
  } else {
    Write-GraceLine 'main process still running 4000ms after WM_CLOSE'
  }
  [DshProcessState]::Release($watched)
}
exit 0
