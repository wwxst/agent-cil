import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let nativeModule;

function getNativeModule() {
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = require('modifiers-napi');
  } catch {
    nativeModule = null;
  }
  return nativeModule;
}

export function prewarmModifiers() {
  if (process.platform !== 'darwin') return;
  getNativeModule()?.prewarm?.();
}

export function isModifierPressed(modifier) {
  if (process.platform !== 'darwin') return false;
  return getNativeModule()?.isModifierPressed?.(modifier) ?? false;
}
