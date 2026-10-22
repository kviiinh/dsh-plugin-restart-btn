<#
.SYNOPSIS
  Ask the DSH desktop shell to quit the way the tray menu does.

.DESCRIPTION
  The Electron main process is the only place that can run `app.quit()`, and a
  plugin (which lives in the Host child process) has no channel to it. What it
  does have is a window: the shell keeps a `session-end` listener on Windows,
  and when the window receives a session-end notification the shell marks that
  the session is ending and lets the next close through instead of hiding to
  the tray. A real close then raises `window-all-closed`, which calls
  `app.quit()`, and the shell runs its normal quit path: no confirmation
  dialog, tray icon removed, Host shut down gracefully.

  So this script does three things to each top-level window owned by the shell:

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
foreach ($window in $targets) {
  [void][DshWindowProbe]::PostEndSession($window)
}
Write-GraceLine 'posted WM_ENDSESSION; waiting for the shell to mark the session as ending'
Start-Sleep -Milliseconds 300

foreach ($window in $targets) {
  [void][DshWindowProbe]::PostClose($window)
}
Write-GraceLine ('posted WM_CLOSE to ' + $targets.Count + ' window(s)')
exit 0
