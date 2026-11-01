import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
const { register } = await import('tsx/esm/api');
register();

const ReactModule = await import('react');
const React = ReactModule.default ?? ReactModule;
const { default: render } = await import('../../../legacy/2.1.88/restored-src/src/ink/root.ts');
const { useTerminalSize } = await import('../../../legacy/2.1.88/restored-src/src/hooks/useTerminalSize.ts');
const { default: Text } = await import('../../../legacy/2.1.88/restored-src/src/ink/components/Text.js');

test('original 2.1.88 useTerminalSize follows Ink terminal resize events', {
  timeout: 5000,
}, async () => {
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.getColorDepth = () => 8;
  stdout.hasColors = () => true;

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};

  const stderr = new PassThrough();
  stderr.isTTY = true;

  let observedSize = null;
  function Probe() {
    observedSize = useTerminalSize();
    return React.createElement(Text, null, observedSize.columns + 'x' + observedSize.rows);
  }

  let instance;
  try {
    instance = await render(React.createElement(Probe), {
      stdout,
      stdin,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    assert.deepEqual(observedSize, { columns: 80, rows: 24 });

    stdout.columns = 60;
    stdout.rows = 12;
    stdout.emit('resize');

    const deadline = Date.now() + 1500;
    while ((observedSize?.columns !== 60 || observedSize?.rows !== 12) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(observedSize, { columns: 60, rows: 12 },
      'the original Ink App must publish new dimensions through TerminalSizeContext');
  } finally {
    if (instance) {
      const exitPromise = instance.waitUntilExit();
      instance.unmount();
      await exitPromise;
      instance.cleanup();
    }
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  }
});
