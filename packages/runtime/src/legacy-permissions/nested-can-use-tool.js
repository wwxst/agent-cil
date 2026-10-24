/**
 * Headless dependency closure for source 2.1.88 useCanUseTool.tsx:
 * canUseTool(tool, input, toolUseContext, assistantMessage, toolUseID,
 *            forceDecision).
 *
 * Original Tool.call() receives this authorization callback as its THIRD
 * argument. Reuse the same real global+tool-specific policy resolver as the
 * top-level tool path. No implicit allow from the approved parent tool,
 * forced decision, classifier hints, or an unknown tool.
 *
 * This function ONLY decides permission: original child tools execute their
 * own work after receiving an allow; an allow is not a request to run them.
 */
import { isDeepStrictEqual } from 'node:util';

const MAX_REWRITES = 8;
function deny(reason) { return { behavior:'deny', reason }; }
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
     Object.getPrototypeOf(value) === null);
}
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const err=new Error('Nested permission request cancelled.');
  err.name='AbortError';
  throw err;
}
function cloneInput(value) {
  if (!record(value)) throw new TypeError('Nested tool input must be a JSON object.');
  const encoded=JSON.stringify(value);
  if (typeof encoded !== 'string') throw new TypeError('Nested tool input must be JSON serializable.');
  const decoded=JSON.parse(encoded);
  if (!record(decoded)) throw new TypeError('Nested tool input must be a JSON object.');
  return decoded;
}

export async function originalCanUseNestedTool({
  proposedTool, input, toolUseId, toolUseContext, forceDecision,
  getTool, validateInput, requestPermissionDecision, approvalHandler,
  signal, onPermissionRequired,
}={}) {
  if (!proposedTool || typeof proposedTool.name !== 'string' ||
      typeof toolUseId !== 'string' || !toolUseId) {
    return deny('Nested tool identity is invalid.');
  }
  const actual=getTool?.(proposedTool.name);
  if (!actual || actual !== proposedTool) {
    return deny('Nested tool definition is not the registered authorized tool.');
  }
  if (forceDecision !== undefined &&
      (!forceDecision || !['allow','ask','deny'].includes(forceDecision.behavior))) {
    return deny('Nested forced permission decision is invalid.');
  }
  throwIfAborted(signal);
  let originalInput;
  let currentInput;
  try {
    originalInput=cloneInput(input);
    currentInput=originalInput;
  } catch(error) {
    return deny('Invalid nested tool input: '+error.message);
  }
  async function validate(value) {
    throwIfAborted(signal);
    const errors=await validateInput(actual.name,value,toolUseContext,actual);
    throwIfAborted(signal);
    if (!Array.isArray(errors)) return 'Nested tool input validation returned an invalid result.';
    return errors.length ? errors.join(' ') : undefined;
  }
  let invalid=await validate(currentInput);
  if (invalid) return deny('Invalid nested tool input: '+invalid);
  if (forceDecision?.behavior==='deny') {
    return deny(forceDecision.reason || 'Nested permission was explicitly denied.');
  }
  let decision;
  let userModified=false;
  let acceptedFeedback;
  for(let attempts=0;attempts<=MAX_REWRITES;attempts++) {
    throwIfAborted(signal);
    const result=await requestPermissionDecision(
      currentInput, attempts ? 'nested-recheck' : 'nested',
      actual, toolUseId, toolUseContext,
    );
    throwIfAborted(signal);
    if (result?.result) {
      return deny('Nested tool permission check failed.');
    }
    decision=result?.decision;
    if (!decision || !['allow','ask','deny'].includes(decision.behavior)) {
      return deny('Nested tool permission policy returned an invalid decision.');
    }
    if (decision.behavior==='deny') {
      return deny(decision.reason || 'Nested tool request was denied.');
    }
    if (decision.updatedInput!==undefined) {
      let replacement;
      try { replacement=cloneInput(decision.updatedInput); }
      catch(error) { return deny('Invalid nested tool updatedInput: '+error.message); }
      invalid=await validate(replacement);
      if(invalid)return deny('Invalid nested tool updatedInput: '+invalid);
      if (!isDeepStrictEqual(currentInput,replacement)) {
        currentInput=replacement;
        continue;
      }
    }
    // Original forced ask can require a dialog. An untrusted forced allow
    // can never defeat a mandatory explicit/global/tool-specific ask or deny.
    const behavior=forceDecision?.behavior==='ask'?'ask':decision.behavior;
    if (behavior==='ask') {
      const reason=forceDecision?.reason || decision.reason || 'Nested tool requires approval.';
      onPermissionRequired?.({
        toolUseId, toolName:actual.name, input:structuredClone(currentInput),
        reason, nested:true,
      });
      if(typeof approvalHandler!=='function')return deny(reason);
      let approval;
      try{
        approval=await approvalHandler({
          name:actual.name,input:structuredClone(currentInput),
          toolUseId,reason,signal,nested:true,
        });
        throwIfAborted(signal);
      }catch(error){
        throwIfAborted(signal);
        return deny('Nested approval handler failed: '+
          (error instanceof Error?error.message:String(error)));
      }
      if(approval!==true && approval?.approved!==true) {
        return deny(approval?.reason || reason);
      }
      if(approval?.updatedInput!==undefined) {
        let replacement;
        try { replacement=cloneInput(approval.updatedInput); }
        catch(error){return deny('Invalid nested approval updatedInput: '+error.message);}
        invalid=await validate(replacement);
        if(invalid)return deny('Invalid nested approval updatedInput: '+invalid);
        if(!isDeepStrictEqual(currentInput,replacement)) {
          currentInput=replacement;
          userModified=true;
          continue;
        }
      }
      // Recheck after a user dialog to guard an allow that became deny,
      // or a symlink/rule change while the user considered the request.
      const checked=await requestPermissionDecision(
        currentInput,'nested-post-approval',actual,toolUseId,toolUseContext,
      );
      throwIfAborted(signal);
      const fresh=checked?.decision;
      if(checked?.result || !fresh ||
         (fresh.behavior!=='allow' &&
          !(fresh.behavior==='ask' && fresh.reason===decision.reason)) ||
         fresh.updatedInput!==undefined) {
        return deny('Nested tool permission changed during approval.');
      }
      acceptedFeedback=approval && typeof approval==='object' ? approval : undefined;
    }
    const rewritten=!isDeepStrictEqual(currentInput,originalInput);
    return {
      behavior:'allow',
      ...(rewritten?{updatedInput:structuredClone(currentInput)}:{}),
      ...(userModified?{userModified:true}:{}),
      ...(acceptedFeedback?.acceptFeedback!==undefined
        ?{acceptFeedback:acceptedFeedback.acceptFeedback}:{}),
      ...(acceptedFeedback?.contentBlocks!==undefined
        ?{contentBlocks:acceptedFeedback.contentBlocks}:{}),
    };
  }
  return deny('Nested tool permission repeatedly changed the input.');
}
