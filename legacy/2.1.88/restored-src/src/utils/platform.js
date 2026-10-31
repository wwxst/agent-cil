export function getPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    return process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP
      ? 'wsl'
      : 'linux';
  }
  return 'unknown';
}
