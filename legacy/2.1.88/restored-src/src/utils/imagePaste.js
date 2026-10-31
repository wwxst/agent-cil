// The original usePasteHandler imports this module even when no image callback
// is supplied. Text paste and image-path recognition are supported by this
// Node adapter. Image transport will be enabled when the AgentLoop message
// adapter accepts image content blocks; fail explicitly if called prematurely.
export const PASTE_THRESHOLD = 800;
export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i;

function removeOuterQuotes(text) {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function stripBackslashEscapes(path) {
  if (process.platform === 'win32') return path;
  return path.replace(/\\(.)/g, '$1');
}

export function isImageFilePath(text) {
  return IMAGE_EXTENSION_REGEX.test(
    stripBackslashEscapes(removeOuterQuotes(String(text).trim())),
  );
}

export async function getImageFromClipboard() {
  throw new Error('Clipboard image transport is not connected to the AgentLoop message schema.');
}

export async function tryReadImageFromPath() {
  throw new Error('Image-file transport is not connected to the AgentLoop message schema.');
}
