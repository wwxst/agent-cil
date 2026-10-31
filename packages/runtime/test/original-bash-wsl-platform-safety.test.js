import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  classifyOriginalPlatform,
  hasSuspiciousWindowsPathPattern,
} from '../src/legacy-permissions/original-bash-read-paths.js';

test('pinned 2.1.88 platform detection keeps WSL inside Windows ADS path checks',()=>{
  assert.equal(classifyOriginalPlatform('linux','Linux version 4.4.0-19041-Microsoft'),'wsl');
  assert.equal(classifyOriginalPlatform('linux','Linux version 6.6.87.2-microsoft-standard-WSL2'),'wsl');
  assert.equal(classifyOriginalPlatform('linux','Linux version 6.8.0-generic'),'linux');
  assert.equal(classifyOriginalPlatform('win32',''),'windows');
  assert.equal(classifyOriginalPlatform('darwin',''),'macos');
  assert.equal(classifyOriginalPlatform('freebsd',''),'unknown');

  assert.equal(hasSuspiciousWindowsPathPattern('settings.json:stream','wsl'),true);
  assert.equal(hasSuspiciousWindowsPathPattern('settings.json:stream','windows'),true);
  assert.equal(hasSuspiciousWindowsPathPattern('settings.json:stream','linux'),false);
});
