param(
  [Parameter(Mandatory=$true)][string]$CommandEnvironmentName,
  [Parameter(Mandatory=$true)][string]$CwdEnvironmentName,
  [Parameter(Mandatory=$true)][string]$StatusEnvironmentName,
  [Parameter(Mandatory=$true)][string]$ShellEnvironmentName,
  [Parameter(Mandatory=$true)][string]$PipeName
)
$ErrorActionPreference = 'Stop'
$command = [System.Environment]::GetEnvironmentVariable($CommandEnvironmentName)
$cwd = [System.Environment]::GetEnvironmentVariable($CwdEnvironmentName)
$statusPath = [System.Environment]::GetEnvironmentVariable($StatusEnvironmentName)
$shellPath = [System.Environment]::GetEnvironmentVariable($ShellEnvironmentName)
$payload = $null
try {
  if ([string]::IsNullOrEmpty($command)) { throw 'Windows Bash command was not supplied to its owner.' }
  if ([string]::IsNullOrEmpty($cwd)) { throw 'Windows Bash working directory was not supplied to its owner.' }
  if ([string]::IsNullOrEmpty($statusPath)) { throw 'Windows Bash cleanup witness path was not supplied to its owner.' }

  # Keep a separate, non-authoritative startup-stage witness. The Node owner
  # uses it only to diagnose a failed READY handshake; only the final status
  # receipt below can authorize successful process-tree cleanup.
  $stagePath = $statusPath + '.stage'
  function Write-Stage([string]$value) {
    try { [System.IO.File]::AppendAllText($stagePath, $value + [Environment]::NewLine) } catch { }
  }
  Write-Stage 'script-entered'

  $source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AgentCliWindowsJobSupervisor {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint TerminationCode = 0xC000013A;
    private static readonly object JobLock = new object();

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass,
        IntPtr info, uint infoLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string applicationName,
        StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment,
        string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass,
        IntPtr info, uint infoLength, out uint returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int handle);

    private static IntPtr BuildEnvironmentBlock(string[] excludedNames) {
        HashSet<string> excluded = new HashSet<string>(
            excludedNames ?? new string[0], StringComparer.OrdinalIgnoreCase);
        // Keep the per-supervisor command-source variable from the PowerShell
        // environment block. Bash removes its export attribute before eval,
        // so arbitrary shell source is not inherited by user child processes.
        IDictionary values = Environment.GetEnvironmentVariables();
        List<string> entries = new List<string>();
        foreach (DictionaryEntry item in values) {
            string key = Convert.ToString(item.Key);
            if (excluded.Contains(key)) continue;
            entries.Add(key + "=" + Convert.ToString(item.Value));
        }
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        // StringToHGlobalUni adds the final NUL; the explicit NUL below
        // produces the required double-NUL-terminated Windows environment.
        string block = String.Join("\0", entries.ToArray()) + "\0";
        return Marshal.StringToHGlobalUni(block);
    }

    private static uint ActiveProcesses(IntPtr job) {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr memory = Marshal.AllocHGlobal(size);
        try {
            uint returned;
            if (!QueryInformationJobObject(job,
                    JobObjectBasicAccountingInformation, memory,
                    (uint)size, out returned))
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "QueryInformationJobObject failed while confirming Bash descendants.");
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info =
                (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                    memory, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return info.ActiveProcesses;
        } finally {
            Marshal.FreeHGlobal(memory);
        }
    }

    private static string QuoteWindowsArgument(string value) {
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') {
                backslashes++;
                continue;
            }
            if (ch == '"') {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0) {
                result.Append('\\', backslashes);
                backslashes = 0;
            }
            result.Append(ch);
        }
        if (backslashes > 0) result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void WriteLine(StreamWriter writer, object writerLock, string line) {
        lock (writerLock) {
            writer.WriteLine(line);
            writer.Flush();
        }
    }

    // Diagnostic only: this file never proves ownership or cleanup. The Node
    // caller reports the last completed native setup stage if READY is absent.
    private static void WriteStage(string statusPath, string stage) {
        try { File.AppendAllText(statusPath + ".stage", stage + Environment.NewLine,
            new UTF8Encoding(false)); }
        catch { }
    }

    private static void TerminateAndWaitForEmptyJob(IntPtr job, int timeoutMs,
            string statusPath) {
        WriteStage(statusPath, "job-cleanup-enter:" + timeoutMs.ToString());
        lock (JobLock) {
            WriteStage(statusPath, "job-cleanup-before-accounting");
            uint active = ActiveProcesses(job);
            WriteStage(statusPath, "job-cleanup-active:" + active.ToString());
            if (active == 0) return;
            WriteStage(statusPath, "job-cleanup-terminate-start");
            if (!TerminateJobObject(job, TerminationCode)) {
                int error = Marshal.GetLastWin32Error();
                if (ActiveProcesses(job) == 0) {
                    WriteStage(statusPath, "job-cleanup-empty-after-terminate-error");
                    return;
                }
                throw new Win32Exception(error,
                    "TerminateJobObject failed; Windows Bash descendants remain unconfirmed.");
            }
            WriteStage(statusPath, "job-cleanup-terminate-returned");
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            bool reportedActive = false;
            while (true) {
                active = ActiveProcesses(job);
                if (active == 0) {
                    WriteStage(statusPath, "job-cleanup-empty");
                    return;
                }
                if (!reportedActive) {
                    WriteStage(statusPath, "job-cleanup-still-active:" + active.ToString());
                    reportedActive = true;
                }
                if (DateTime.UtcNow >= deadline)
                    throw new TimeoutException(
                        "Windows Bash Job Object still had active processes after termination.");
                Thread.Sleep(10);
            }
        }
    }

    private static bool IsEnvironmentIdentifier(string value) {
        if (String.IsNullOrEmpty(value)) return false;
        for (int i = 0; i < value.Length; i++) {
            char ch = value[i];
            bool letter = (ch >= 'A' && ch <= 'Z') ||
                (ch >= 'a' && ch <= 'z');
            bool digit = ch >= '0' && ch <= '9';
            if (!(letter || ch == '_' || (i > 0 && digit))) return false;
        }
        return true;
    }

    public static int Run(string commandEnvironmentName, string cwd,
            string[] excludedEnvironmentNames, string pipeName,
            string statusPath, string shellPath) {
        IntPtr job = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        NamedPipeClientStream pipe = null;
        StreamReader reader = null;
        StreamWriter writer = null;
        Thread controlThread = null;
        int controlMessageReceived = 0;
        // The Node CLI is the lifetime owner of this supervisor. A broken
        // control pipe while Run is active means the owner disappeared; do
        // not leave a detached Bash tree waiting on this PowerShell process.
        // The Run finalizer sets this before its own authoritative Job cleanup
        // so the normal post-receipt pipe close is not mistaken for a crash.
        int ownerShutdownExpected = 0;
        object writerLock = new object();
        Exception controlFailure = null;
        try {
            WriteStage(statusPath, "native-entered");
            if (!IsEnvironmentIdentifier(commandEnvironmentName) ||
                    !commandEnvironmentName.StartsWith("AGENT_CIL_", StringComparison.Ordinal) ||
                    !commandEnvironmentName.EndsWith("_COMMAND", StringComparison.Ordinal))
                throw new ArgumentException("Invalid Windows Bash command environment name.");
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "CreateJobObject failed before Windows Bash launch.");
            WriteStage(statusPath, "job-created");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitMemory = Marshal.AllocHGlobal(limitSize);
            try {
                Marshal.StructureToPtr(limits, limitMemory, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                        limitMemory, (uint)limitSize))
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "SetInformationJobObject failed before Windows Bash launch.");
            } finally {
                Marshal.FreeHGlobal(limitMemory);
            }
            WriteStage(statusPath, "job-configured");

            if (String.IsNullOrEmpty(shellPath) || !File.Exists(shellPath))
                throw new InvalidOperationException(
                    "A valid POSIX Bash executable was not supplied to the Windows supervisor.");
            WriteStage(statusPath, "shell-path:" + Path.GetFullPath(shellPath));
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            string[] excluded = new List<string>(
                excludedEnvironmentNames ?? new string[0]).ToArray();
            environment = BuildEnvironmentBlock(excluded);
            // Do not pass user shell source as a Windows argv element: the
            // MSYS runtime may rewrite path-looking arguments. The unique
            // source value is unexported before eval, so child processes see
            // the original environment and the command's true final status.
            string bashProgram = "export -n " + commandEnvironmentName +
                "; eval \"$" + commandEnvironmentName + "\"";
            StringBuilder line = new StringBuilder(
                QuoteWindowsArgument(shellPath) + " -c " + QuoteWindowsArgument(bashProgram));
            if (!CreateProcessW(shellPath, line, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, environment,
                    cwd, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "CreateProcessW failed before Windows Bash launch.");
            WriteStage(statusPath, "process-created-suspended");
            if (!AssignProcessToJobObject(job, process.hProcess)) {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, 5000);
                throw new Win32Exception(error,
                    "AssignProcessToJobObject failed; Bash was not resumed.");
            }
            WriteStage(statusPath, "process-assigned");

            pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
                PipeOptions.None);
            WriteStage(statusPath, "pipe-connecting");
            pipe.Connect(15000);
            WriteStage(statusPath, "pipe-connected");
            UTF8Encoding encoding = new UTF8Encoding(false);
            reader = new StreamReader(pipe, encoding, false, 1024, true);
            writer = new StreamWriter(pipe, encoding, 1024, true);
            controlThread = new Thread(delegate() {
                try {
                    string message = reader.ReadLine();
                    Interlocked.Exchange(ref controlMessageReceived, 1);
                    WriteStage(statusPath, "control-reader-line:" + (message ?? "<null>"));
                    if (message == null) {
                        // Node was killed/crashed or lost its only control
                        // connection. Terminate the entire owned Job Object,
                        // including detached grandchildren, before allowing
                        // this supervisor to remain blocked on the root PID.
                        if (Interlocked.CompareExchange(ref ownerShutdownExpected, 0, 0) == 0) {
                            WriteStage(statusPath, "control-owner-disconnected");
                            try {
                                TerminateAndWaitForEmptyJob(job, 5000, statusPath);
                                Interlocked.CompareExchange(ref controlFailure,
                                    new IOException("Windows Bash owner disconnected before command completion."),
                                    null);
                                WriteStage(statusPath, "control-owner-disconnect-cleanup-complete");
                            } catch (Exception cleanupError) {
                                Interlocked.CompareExchange(ref controlFailure, cleanupError, null);
                                WriteStage(statusPath, "control-owner-disconnect-cleanup-failed");
                                // No Node owner remains to receive ERROR or
                                // terminate this supervisor. Exit now so the
                                // OS closes the last Job handle and enforces
                                // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE even when
                                // explicit TerminateJobObject could not verify
                                // an empty tree. Never remain blocked forever
                                // while retaining descendants.
                                Environment.Exit(197);
                                return;
                            }
                        }
                        return;
                    }
                    if (message == "KILL") {
                        TerminateAndWaitForEmptyJob(job, 5000, statusPath);
                        WriteLine(writer, writerLock, "KILLED");
                    } else {
                        throw new InvalidDataException("Unexpected Windows Bash control message.");
                    }
                } catch (Exception error) {
                    Interlocked.CompareExchange(ref controlFailure, error, null);
                    try {
                        WriteLine(writer, writerLock, "ERROR " +
                            Convert.ToBase64String(Encoding.UTF8.GetBytes(error.ToString())));
                    } catch { }
                }
            });
            controlThread.IsBackground = true;

            // READY is emitted only after the suspended cmd.exe is assigned
            // to a kill-on-close Job Object and the control pipe is connected.
            // Start the blocking reader immediately after flushing READY: the
            // peer cannot send KILL before READY, and pipe buffering preserves
            // a KILL that races with the reader thread starting. Keeping a
            // blocked ReadLine off the pipe during the first READY write also
            // avoids coupling startup publication to the control-reader path.
            uint resumed = ResumeThread(process.hThread);
            if (resumed == 0xFFFFFFFF)
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "ResumeThread failed after Windows Bash ownership was established.");
            WriteStage(statusPath, "process-resumed");
            WriteLine(writer, writerLock, "READY");
            WriteStage(statusPath, "ready-sent");
            controlThread.Start();
            WriteStage(statusPath, "control-thread-started");

            WriteStage(statusPath, "root-process-wait-start");
            uint wait = WaitForSingleObject(process.hProcess, INFINITE);
            WriteStage(statusPath, "root-process-wait-complete");
            if (wait == WAIT_FAILED || wait != WAIT_OBJECT_0)
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "WaitForSingleObject failed for the owned Windows Bash process.");
            uint rawExitCode;
            if (!GetExitCodeProcess(process.hProcess, out rawExitCode))
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "GetExitCodeProcess failed for the owned Windows Bash process.");

            // cmd.exe may exit while detached descendants are still running.
            // Terminate and wait for every process in the pinned Job Object
            // before the TaskOutput FD can be finalized by the Node caller.
            TerminateAndWaitForEmptyJob(job, 5000, statusPath);
            Exception observedControlFailure =
                Interlocked.CompareExchange(ref controlFailure, null, null);
            if (observedControlFailure != null)
                throw new InvalidOperationException(
                    "Windows Bash control-channel cleanup failed.", observedControlFailure);
            // Completion is persisted by the PowerShell wrapper after this
            // method returns. Do not send DONE over the duplex control pipe:
            // a blocked control read can serialize the write on Windows. The
            // durable status receipt plus process exit is the completion ACK.
            return unchecked((int)rawExitCode);
        } finally {
            // From this point onward the Run finalizer itself owns the last
            // cleanup attempt. A pipe EOF racing with normal supervisor exit
            // must not be mistaken for an unexpected Node-owner disappearance.
            Interlocked.Exchange(ref ownerShutdownExpected, 1);
            // If any setup/cleanup stage fails, closing the last Job Object
            // handle still applies KILL_ON_JOB_CLOSE to any remaining member.
            if (job != IntPtr.Zero) {
                try { TerminateAndWaitForEmptyJob(job, 5000, statusPath); } catch { }
            }

            // A normal DONE is acknowledged by Node, and KILL consumes the
            // one-shot native reader, so both paths should stop it before this
            // cleanup. If a broken pipe/host prevents it from stopping, leave
            // the pipe handle for OS process teardown rather than blocking
            // shutdown behind a read that can no longer make progress.
            bool controlStopped = controlThread == null || !controlThread.IsAlive;
            if (controlThread != null &&
                    Interlocked.CompareExchange(ref controlMessageReceived, 0, 0) != 0) {
                try {
                    controlThread.Join(1000);
                    controlStopped = !controlThread.IsAlive;
                } catch { controlStopped = !controlThread.IsAlive; }
            }
            if (controlStopped) {
                lock (writerLock) {
                    if (writer != null) { try { writer.Dispose(); } catch { } }
                    if (reader != null) { try { reader.Dispose(); } catch { } }
                    if (pipe != null) { try { pipe.Dispose(); } catch { } }
                }
            }
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }
}
'@

  Write-Stage 'source-loaded'
  $cacheRoot = $env:LOCALAPPDATA
  Write-Stage 'cache-root-read'
  if ([string]::IsNullOrEmpty($cacheRoot)) { $cacheRoot = [System.IO.Path]::GetTempPath() }
  $cacheRoot = Join-Path $cacheRoot 'agent-cil\windows-job-supervisor'
  [System.IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
  Write-Stage 'cache-directory-created'
  $sourceHash = [BitConverter]::ToString(
    ([Security.Cryptography.SHA256]::Create()).ComputeHash(
      [Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').ToLowerInvariant()
  Write-Stage 'source-hash-computed'
  $assemblyPath = Join-Path $cacheRoot ('supervisor-' + $sourceHash + '.dll')
  $lockPath = $assemblyPath + '.lock'
  Write-Stage 'cache-ready'

  # A valid cached assembly is immutable. Load it without the compile lock so
  # concurrent Bash commands do not serialize their startup on Add-Type.
  $loaded = $false
  if (Test-Path -LiteralPath $assemblyPath -PathType Leaf) {
    try {
      Add-Type -Path $assemblyPath -ErrorAction Stop | Out-Null
      $loaded = $true
    } catch {
      # Repair is serialized below after waiting for any in-flight compiler.
      $loaded = $false
    }
  }

  if (-not $loaded) {
    $lock = $null
    $lockDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($null -eq $lock) {
      try {
        $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
          [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      } catch [System.IO.IOException] {
        if ([DateTime]::UtcNow -ge $lockDeadline) { throw }
        Start-Sleep -Milliseconds 50
      }
    }
    try {
      # The lock protects only file creation/repair. Loading the resulting DLL
      # happens after release, so a cold start with many parallel tool calls
      # incurs one compilation rather than one serialized load per caller.
      if (-not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)) {
        Write-Stage 'compiling-supervisor'
        Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $assemblyPath -ErrorAction Stop | Out-Null
      }
    } finally {
      $lock.Dispose()
    }

    Write-Stage 'loading-supervisor-assembly'
    try {
      Add-Type -Path $assemblyPath -ErrorAction Stop | Out-Null
      $loaded = $true
    } catch {
      # A stale or interrupted cache artifact can survive a killed compiler.
      # Recheck while holding the lock; if another process repaired it, reuse
      # that complete assembly. Otherwise replace it and load after release.
      $lock = $null
      $lockDeadline = [DateTime]::UtcNow.AddSeconds(30)
      while ($null -eq $lock) {
        try {
          $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch [System.IO.IOException] {
          if ([DateTime]::UtcNow -ge $lockDeadline) { throw }
          Start-Sleep -Milliseconds 50
        }
      }
      $recompile = $false
      try {
        $loaded = $false
        if (Test-Path -LiteralPath $assemblyPath -PathType Leaf) {
          try {
            Add-Type -Path $assemblyPath -ErrorAction Stop | Out-Null
            $loaded = $true
          } catch {
            Remove-Item -LiteralPath $assemblyPath -Force -ErrorAction SilentlyContinue
          }
        }
        if (-not $loaded) {
          Write-Stage 'repairing-supervisor-assembly'
          Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $assemblyPath -ErrorAction Stop | Out-Null
          $recompile = $true
        }
      } finally {
        $lock.Dispose()
      }
      if ($recompile) {
        Add-Type -Path $assemblyPath -ErrorAction Stop | Out-Null
      }
    }
  }

  Write-Stage 'assembly-ready'
  Write-Stage 'native-job-start'
  $exitCode = [AgentCliWindowsJobSupervisor]::Run(
    $CommandEnvironmentName, $cwd,
    @($CwdEnvironmentName, $StatusEnvironmentName, $ShellEnvironmentName),
    $PipeName, $statusPath, $shellPath)
  Write-Stage 'native-job-complete'
  $payload = @{ ok = $true; exitCode = [int]$exitCode; cleanupConfirmed = $true }
} catch {
  Write-Stage ('error: ' + [string]$_.Exception.ToString())
  $payload = @{ ok = $false; cleanupConfirmed = $false; error = [string]$_.Exception.ToString() }
}

try {
  Write-Stage 'status-json-start'
  $json = ConvertTo-Json -InputObject $payload -Compress
  Write-Stage 'status-json-built'
  $encoding = New-Object System.Text.UTF8Encoding($false)
  $stream = [System.IO.File]::Open($statusPath, [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
  Write-Stage 'status-file-opened'
  try {
    $bytes = $encoding.GetBytes($json)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    Write-Stage 'status-file-flushed'
  } finally {
    $stream.Dispose()
  }
  Write-Stage 'status-file-closed'
} catch {
  Write-Stage ('status-file-error: ' + [string]$_.Exception.ToString())
  exit 198
}
if ($payload.ok) { Write-Stage 'exit-zero'; exit 0 } else { Write-Stage 'exit-nonzero'; exit 197 }
