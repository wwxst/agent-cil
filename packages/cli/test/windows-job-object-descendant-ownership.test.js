import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBuiltinTools,cleanupLiveShellCommands,getShellLifecycleStatus}
  from '../src/index.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForFile(path,timeoutMs=12000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    try {await stat(path);return;}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    await pause(30);
  }
  throw new Error('Timed out waiting for the real Windows Bash child to start: '+path);
}
async function markerDoesNotAppear(path,waitMs) {
  await pause(waitMs);
  await assert.rejects(stat(path),{code:'ENOENT'},
    'a descendant owned by the Bash Job Object must not survive to write its delayed marker');
}
function parentSource({spawnedPath,pidPath,markerPath,delayMs,keepAlive}) {
  const descendant="const fs=require('node:fs');setTimeout(()=>fs.writeFileSync("+
    JSON.stringify(markerPath)+",'DESCENDANT_SURVIVED'),"+delayMs+");";
  return [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e',"+JSON.stringify(descendant)+"],{detached:true,stdio:'ignore',windowsHide:true});",
    "child.unref();",
    "fs.writeFileSync("+JSON.stringify(pidPath)+",String(child.pid));",
    "fs.writeFileSync("+JSON.stringify(spawnedPath)+",'spawned');",
    "process.stdout.write('ROOT_SHELL_FINISHED');",
    keepAlive ? "setInterval(()=>{},1000);" : "",
  ].filter(Boolean).join('\n');
}
async function setup({delayMs,keepAlive}) {
  const root=await mkdtemp(join(tmpdir(),'agent-cil-win-job-owner-'));
  const sessionId=randomUUID();
  const spawnedPath=join(root,'descendant-started.txt');
  const pidPath=join(root,'descendant.pid');
  const markerPath=join(root,'descendant-escaped.txt');
  const scriptPath=join(root,'parent-shell.cjs');
  await writeFile(scriptPath,parentSource({
    spawnedPath,pidPath,markerPath,delayMs,keepAlive,
  }));
  const tools=await createBuiltinTools({
    workspace:root,taskSession:{workspace:root,sessionId},
  });
  return {root,tools,spawnedPath,pidPath,markerPath,scriptPath};
}
const commandFor=path=>'"'+process.execPath.replaceAll('"','')+'" "'+path.replaceAll('"','')+'"';

test('Windows Bash owns detached descendants after cmd.exe exits and reaps them before TaskOutput finalization',{
  skip:process.platform!=='win32' &&
    'The native Windows Job Object containment contract requires a Windows runner',
  timeout:30000,
},async()=>{
  const x=await setup({delayMs:1800,keepAlive:false});
  try {
    const result=await x.tools.get('Bash').execute({
      command:commandFor(x.scriptPath),timeout_ms:18000,
    });
    assert.equal(result.exit_code,0,result.error);
    assert.match(result.stdout,/ROOT_SHELL_FINISHED/);
    await readFile(x.pidPath,'utf8');
    await assert.rejects(stat(x.markerPath),{code:'ENOENT'},
      'the owned detached child must already be gone before Bash returns');
    await markerDoesNotAppear(x.markerPath,2300);
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    });
  }finally {
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(x.root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});

test('Windows Bash timeout signals the owning Job Object and waits for its detached child to be reaped',{
  skip:process.platform!=='win32' &&
    'The native Windows Job Object cancellation contract requires a Windows runner',
  timeout:30000,
},async()=>{
  const x=await setup({delayMs:8200,keepAlive:true});
  try {
    const pending=x.tools.get('Bash').execute({
      command:commandFor(x.scriptPath),timeout_ms:5200,
    });
    await waitForFile(x.spawnedPath,11000);
    const result=await pending;
    assert.equal(result.exit_code,1,result.stdout);
    assert.match(result.error,/timed out/i);
    await assert.rejects(stat(x.markerPath),{code:'ENOENT'});
    await markerDoesNotAppear(x.markerPath,4200);
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    });
  }finally {
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(x.root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});




test('Windows Bash denies native CREATE_BREAKAWAY_FROM_JOB and cannot leave a delayed descendant outside its Job Object',{
  skip:process.platform!=='win32' &&
    'The native Windows CREATE_BREAKAWAY_FROM_JOB contract requires a Windows runner',
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-win-job-breakaway-'));
  const markerPath=join(root,'breakaway-escaped.txt');
  const childPath=join(root,'breakaway-child.cjs');
  const probePath=join(root,'breakaway-probe.ps1');
  const resultPath=join(root,'breakaway-result.txt');
  const powershellPath=join(process.env.SystemRoot||'C:\\Windows',
    'System32','WindowsPowerShell','v1.0','powershell.exe');
  const toMsysPath=value=>{
    const match=/^([A-Za-z]):\\(.*)$/.exec(value);
    return match?'/'+match[1].toUpperCase()+'/'+match[2].replaceAll('\\','/'):
      value.replaceAll('\\','/');
  };
  const psQuote=value=>"'"+value.replace(/'/g,"''")+"'";
  const csharp="\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\n\npublic static class AgentCilBreakawayProbe {\n    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]\n    private struct STARTUPINFO {\n        public int cb;\n        public IntPtr lpReserved;\n        public IntPtr lpDesktop;\n        public IntPtr lpTitle;\n        public int dwX;\n        public int dwY;\n        public int dwXSize;\n        public int dwYSize;\n        public int dwXCountChars;\n        public int dwYCountChars;\n        public int dwFillAttribute;\n        public int dwFlags;\n        public short wShowWindow;\n        public short cbReserved2;\n        public IntPtr lpReserved2;\n        public IntPtr hStdInput;\n        public IntPtr hStdOutput;\n        public IntPtr hStdError;\n    }\n\n    [StructLayout(LayoutKind.Sequential)]\n    private struct PROCESS_INFORMATION {\n        public IntPtr hProcess;\n        public IntPtr hThread;\n        public uint dwProcessId;\n        public uint dwThreadId;\n    }\n\n    [StructLayout(LayoutKind.Sequential)]\n    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {\n        public long PerProcessUserTimeLimit;\n        public long PerJobUserTimeLimit;\n        public uint LimitFlags;\n        public UIntPtr MinimumWorkingSetSize;\n        public UIntPtr MaximumWorkingSetSize;\n        public uint ActiveProcessLimit;\n        public UIntPtr Affinity;\n        public uint PriorityClass;\n        public uint SchedulingClass;\n    }\n\n    [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]\n    private static extern bool CreateProcessW(\n        string applicationName,\n        StringBuilder commandLine,\n        IntPtr processAttributes,\n        IntPtr threadAttributes,\n        bool inheritHandles,\n        uint creationFlags,\n        IntPtr environment,\n        string currentDirectory,\n        ref STARTUPINFO startupInfo,\n        out PROCESS_INFORMATION processInformation);\n\n    [DllImport(\"kernel32.dll\", SetLastError = true)]\n    private static extern bool QueryInformationJobObject(\n        IntPtr job,\n        int informationClass,\n        IntPtr information,\n        uint informationLength,\n        out uint returnLength);\n\n    [DllImport(\"kernel32.dll\", SetLastError = true)]\n    private static extern bool CloseHandle(IntPtr handle);\n\n    public static string GetCurrentJobLimitFlags() {\n        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION));\n        IntPtr memory = Marshal.AllocHGlobal(size);\n        try {\n            uint returned;\n            if (!QueryInformationJobObject(IntPtr.Zero, 2, memory,\n                    (uint)size, out returned)) {\n                return \"QUERY_ERROR:\" + Marshal.GetLastWin32Error().ToString();\n            }\n            JOBOBJECT_BASIC_LIMIT_INFORMATION info =\n                (JOBOBJECT_BASIC_LIMIT_INFORMATION)Marshal.PtrToStructure(\n                    memory, typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION));\n            return info.LimitFlags.ToString();\n        } finally {\n            Marshal.FreeHGlobal(memory);\n        }\n    }\n\n    private static string Quote(string value) {\n        StringBuilder result = new StringBuilder();\n        result.Append('\"');\n        int backslashes = 0;\n        foreach (char ch in value) {\n            if (ch == '\\\\') {\n                backslashes++;\n                continue;\n            }\n            if (ch == '\"') {\n                result.Append('\\\\', backslashes * 2 + 1);\n                result.Append('\"');\n                backslashes = 0;\n                continue;\n            }\n            if (backslashes > 0) {\n                result.Append('\\\\', backslashes);\n                backslashes = 0;\n            }\n            result.Append(ch);\n        }\n        if (backslashes > 0) result.Append('\\\\', backslashes * 2);\n        result.Append('\"');\n        return result.ToString();\n    }\n\n    public static string TryStart(string application, string script, string cwd) {\n        STARTUPINFO startup = new STARTUPINFO();\n        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));\n        PROCESS_INFORMATION process;\n        string commandLine = Quote(application) + \" \" + Quote(script);\n        const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;\n        if (!CreateProcessW(application, new StringBuilder(commandLine),\n                IntPtr.Zero, IntPtr.Zero, false, CREATE_BREAKAWAY_FROM_JOB,\n                IntPtr.Zero, cwd, ref startup, out process)) {\n            return \"DENIED:\" + Marshal.GetLastWin32Error().ToString();\n        }\n        try {\n            return \"CREATED:\" + process.dwProcessId.ToString();\n        } finally {\n            CloseHandle(process.hThread);\n            CloseHandle(process.hProcess);\n        }\n    }\n}\n";
  try {
    await writeFile(childPath,
      "const fs=require('node:fs');setTimeout(()=>fs.writeFileSync("+
      JSON.stringify(markerPath)+",'BREAKAWAY_DESCENDANT_SURVIVED'),2500);");
    const psSource=
      "$ErrorActionPreference = 'Stop'\n"+
      "$nodePath = "+psQuote(process.execPath)+"\n"+
      "$childPath = "+psQuote(childPath)+"\n"+
      "$cwd = "+psQuote(root)+"\n"+
      "$resultPath = "+psQuote(resultPath)+"\n"+
      "$source = @'\n"+csharp+"\n'@\n"+
      "Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null\n"+
      "$flags = [AgentCilBreakawayProbe]::GetCurrentJobLimitFlags()\n"+
      "$outcome = [AgentCilBreakawayProbe]::TryStart($nodePath,$childPath,$cwd)\n"+
      "$result = 'FLAGS:'+$flags+';'+$outcome\n"+
      "[System.IO.File]::WriteAllText($resultPath,$result)\n"+
      "if ($result -eq 'FLAGS:8192;DENIED:5') { exit 0 }\n"+
      "exit 23\n";
    await writeFile(probePath,psSource,'utf8');
    const tools=await createBuiltinTools({
      workspace:root,taskSession:{workspace:root,sessionId:randomUUID()},
    });
    const command='"'+toMsysPath(powershellPath)+
      '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+
      toMsysPath(probePath)+'"';
    const result=await tools.get('Bash').execute({
      command,timeout_ms:20000,
    });
    const outcome=(await readFile(resultPath,'utf8')).trim();
    if(outcome.includes('CREATED:'))await waitForFile(markerPath,7000);
    assert.equal(result.exit_code,0,
      'PowerShell must report the exact owned Job Object flags and breakaway denial: '+JSON.stringify(result));
    assert.equal(outcome,'FLAGS:8192;DENIED:5',
      'the current Bash Job Object must expose only KILL_ON_JOB_CLOSE and reject CREATE_BREAKAWAY_FROM_JOB with ERROR_ACCESS_DENIED');
    await markerDoesNotAppear(markerPath,4200);
  } finally {
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});


test('Windows Bash rejects a forged cleanup receipt when its supervisor is terminated by a Job Object member',{
  skip:process.platform!=='win32' &&
    'The native Windows supervisor identity and cleanup-receipt contract requires a Windows runner',
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-winjob-forged-receipt-'));
  const probePath=join(root,'forge-receipt-and-kill-supervisor.ps1');
  const resultPath=join(root,'supervisor-kill-result.txt');
  const powershellPath=join(process.env.SystemRoot||'C:\\Windows',
    'System32','WindowsPowerShell','v1.0','powershell.exe');
  const toMsysPath=value=>{
    const match=/^([A-Za-z]):\\(.*)$/.exec(value);
    return match?'/'+match[1].toUpperCase()+'/'+match[2].replaceAll('\\','/'):
      value.replaceAll('\\','/');
  };
  const psQuote=value=>"'"+value.replace(/'/g,"''")+"'";
  const csharp="\nusing System;\nusing System.Runtime.InteropServices;\n\npublic static class AgentCilSupervisorKill {\n    [DllImport(\"kernel32.dll\", SetLastError = true)]\n    private static extern IntPtr OpenProcess(\n        uint desiredAccess, bool inheritHandle, uint processId);\n\n    [DllImport(\"kernel32.dll\", SetLastError = true)]\n    private static extern bool TerminateProcess(IntPtr process, uint exitCode);\n\n    [DllImport(\"kernel32.dll\", SetLastError = true)]\n    private static extern bool CloseHandle(IntPtr handle);\n\n    public static int Kill(uint processId, uint exitCode) {\n        IntPtr process = OpenProcess(0x0001, false, processId);\n        if (process == IntPtr.Zero) return Marshal.GetLastWin32Error();\n        try {\n            if (!TerminateProcess(process, exitCode))\n                return Marshal.GetLastWin32Error();\n            return 0;\n        } finally {\n            CloseHandle(process);\n        }\n    }\n}\n";
  try {
    const psSource=
      "$ErrorActionPreference = 'Stop'\n"+
      "$resultPath = "+psQuote(resultPath)+"\n"+
      "$source = @'\n"+csharp+"\n'@\n"+
      "Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null\n"+
      "$current = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $PID)\n"+
      "$cursor = [uint32]$current.ParentProcessId\n"+
      "$supervisorPid = 0\n"+
      "$id = $null\n"+
      "for($depth=0;$depth -lt 12 -and $cursor -gt 0;$depth++) {\n"+
      "  $candidate = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $cursor)\n"+
      "  if($null -eq $candidate) { break }\n"+
      "  $match = [regex]::Match([string]$candidate.CommandLine,'AGENT_CIL_([0-9a-fA-F]{32})_STATUS')\n"+
      "  if($match.Success) { $supervisorPid=[uint32]$candidate.ProcessId; $id=$match.Groups[1].Value; break }\n"+
      "  $cursor=[uint32]$candidate.ParentProcessId\n"+
      "}\n"+
      "if($null -eq $id) { [IO.File]::WriteAllText($resultPath,'SUPERVISOR_NOT_FOUND'); exit 22 }\n"+
      "$statusName='agent-cil-winjob-'+$id+'.json'\n"+
      "$statusPath=$null\n"+
      "$tempRoots=@($env:TMPDIR,$env:TEMP,$env:TMP,[IO.Path]::GetTempPath()) | Where-Object { $_ } | Select-Object -Unique\n"+
      "foreach($tempRoot in $tempRoots) {\n"+
      "  $stagePath=Join-Path $tempRoot ($statusName+'.stage')\n"+
      "  if(Test-Path -LiteralPath $stagePath) { $statusPath=Join-Path $tempRoot $statusName; break }\n"+
      "}\n"+
      "if($null -eq $statusPath) { [IO.File]::WriteAllText($resultPath,'STATUS_PATH_NOT_FOUND'); exit 22 }\n"+
      "$payload='{\"ok\":true,\"cleanupConfirmed\":true,\"exitCode\":0}'\n"+
      "$stream=[IO.File]::Open($statusPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)\n"+
      "try { $bytes=[Text.Encoding]::UTF8.GetBytes($payload); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }\n"+
      "[IO.File]::WriteAllText($resultPath,'KILL_REQUESTED:'+$supervisorPid)\n"+
      "$killError=[AgentCilSupervisorKill]::Kill($supervisorPid,197)\n"+
      "if($killError -ne 0) { [IO.File]::WriteAllText($resultPath,'TERMINATE_FAILED:'+$killError); exit 23 }\n"+
      "exit 0\n";
    await writeFile(probePath,psSource,'utf8');
    const tools=await createBuiltinTools({
      workspace:root,taskSession:{workspace:root,sessionId:randomUUID()},
    });
    const command='"'+toMsysPath(powershellPath)+
      '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+
      toMsysPath(probePath)+'"';
    const execution=tools.get('Bash').execute({command,timeout_ms:18000});
    const observed=execution.then(value=>({value}),error=>({error}));
    await waitForFile(resultPath,12000);
    const probeResult=(await readFile(resultPath,'utf8')).trim();
    assert.match(probeResult,/^KILL_REQUESTED:\d+$/,
      'the in-Job command must find and terminate its actual supervisor after pre-creating a syntactically valid receipt; got '+probeResult);
    const outcome=await observed;
    assert.ok(outcome.error,
      'a forged cleanup receipt must not turn an unexpectedly terminated supervisor into a successful Bash result: '+JSON.stringify(outcome.value));
    assert.equal(outcome.error.name,'ProcessTreeCleanupError',
      'unexpected native supervisor exit must enter the existing fatal process-tree reconciliation fence');
  } finally {
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
