// Keep the original 2.1.88 MarkdownTable component intact while routing its
// ../ink.js edge to the Node-compatible adapter. From src/components, TSX's
// TypeScript resolver prefers the same-stem src/ink.ts design-system barrel,
// which imports Bun-only ThemeProvider. The full Ink renderer is separate at
// src/ink/ink.tsx and remains untouched.
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
