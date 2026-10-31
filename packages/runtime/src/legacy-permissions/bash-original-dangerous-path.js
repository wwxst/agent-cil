/**
 * Mechanical Node/JavaScript port of user-owned CLI 2.1.88 sources:
 * - utils/permissions/pathValidation.ts: expandTilde() and
 *   isDangerousRemovalPath() (including Windows root/child checks)
 * - tools/BashTool/pathValidation.ts: filterOutFlags(),
 *   checkDangerousRemovalPaths() and PATH_EXTRACTORS.rm/rmdir.
 *
 * Keep the original method names and conservative semantics. This is the
 * dangerous-removal dependency closure, NOT a replacement for the full
 * original checkPathConstraints() or general shell sandbox.
 */
import {homedir} from 'node:os';
import {dirname,isAbsolute,resolve} from 'node:path';

const WINDOWS_DRIVE_ROOT_REGEX=/^[A-Za-z]:\/?$/;
const WINDOWS_DRIVE_CHILD_REGEX=/^[A-Za-z]:\/[^/]+$/;

// Original utils/permissions/pathValidation.ts:80-90
export function expandTilde(path) {
  if(path==='~'||path.startsWith('~/')||
    (process.platform==='win32'&&path.startsWith('~\\'))) {
    return homedir()+path.slice(1);
  }
  return path;
}

// Original utils/permissions/pathValidation.ts:331-367, type erasure only.
export function isDangerousRemovalPath(resolvedPath) {
  const forwardSlashed=resolvedPath.replace(/[\\/]+/g,'/');
  if(forwardSlashed==='*'||forwardSlashed.endsWith('/*')) {
    return true;
  }
  const normalizedPath=forwardSlashed==='/'?forwardSlashed:
    forwardSlashed.replace(/\/$/,'');
  if(normalizedPath==='/')return true;
  if(WINDOWS_DRIVE_ROOT_REGEX.test(normalizedPath))return true;
  const normalizedHome=homedir().replace(/[\\/]+/g,'/');
  if(normalizedPath===normalizedHome)return true;
  const parentDir=dirname(normalizedPath);
  if(parentDir==='/')return true;
  if(WINDOWS_DRIVE_CHILD_REGEX.test(normalizedPath))return true;
  return false;
}

// Original tools/BashTool/pathValidation.ts:126-139, type erasure only.
export function filterOutFlags(args) {
  const result=[];
  let afterDoubleDash=false;
  for(const arg of args){
    if(afterDoubleDash) {
      result.push(arg);
    }else if(arg==='--'){
      afterDoubleDash=true;
    }else if(!arg?.startsWith('-')){
      result.push(arg);
    }
  }
  return result;
}

// Original PATH_EXTRACTORS.rm/rmdir both use filterOutFlags(). This
// adapter works over the trusted argv[] from original parseForSecurity().
export function checkDangerousRemovalPaths(command,args,cwd) {
  const paths=filterOutFlags(args);
  for(const path of paths){
    const cleanPath=expandTilde(path.replace(/^['"]|['"]$/g,''));
    const absolutePath=isAbsolute(cleanPath)
      ?cleanPath:resolve(cwd,cleanPath);
    if(isDangerousRemovalPath(absolutePath)){
      return {
        behavior:'ask',
        message:`Dangerous ${command} operation detected: '${absolutePath}'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
        decisionReason:{
          type:'other',
          reason:`Dangerous ${command} operation on critical path: ${absolutePath}`,
        },
        suggestions:[],
      };
    }
  }
  return {
    behavior:'passthrough',
    message:`No dangerous removals detected for ${command} command`,
  };
}
