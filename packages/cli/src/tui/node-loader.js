// Keep the original 2.1.88 MarkdownTable component intact while routing
// its Ink barrel edge to the Node-compatible adapter. The original Ink root
// intentionally continues to resolve ../ink.js to ink.ts (the full renderer);
// only MarkdownTable needs the lightweight barrel because it is embedded in
// the agent-cil TUI rather than the original REPL.
const markdownTableUrl = new URL(
  '../../../../legacy/2.1.88/restored-src/src/components/MarkdownTable.tsx',
  import.meta.url,
).href;
const nodeInkBarrelUrl = new URL(
  '../../../../legacy/2.1.88/restored-src/src/ink.js',
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  const parentUrl = context.parentURL?.split('?')[0];
  if (specifier === '../ink.js' && parentUrl === markdownTableUrl) {
    return {
      url: nodeInkBarrelUrl,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
