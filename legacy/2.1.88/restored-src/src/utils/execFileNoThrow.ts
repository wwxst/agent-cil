// Portable child-process adapter for the original Ink clipboard fallback.
// Arguments are always passed as argv; no shell interpolation is used.
import { spawn } from 'node:child_process';
export type ExecFileNoThrowOptions = { input?: string | Buffer; timeout?: number; useCwd?: boolean };
export function execFileNoThrow(file: string, args: string[] = [], options: ExecFileNoThrowOptions = {}): Promise<{code:number;stdout:string;stderr:string;signal:NodeJS.Signals|null}> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, signal });
    };
    let child;
    try {
      child = spawn(file, args, { cwd: process.cwd(), windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      finish(1, null);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { stderr += (stderr ? '\\n' : '') + error.message; finish(1, null); });
    child.once('close', code => finish(code ?? (timedOut ? 124 : 1), null));
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeout);
      timer.unref?.();
    }
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
