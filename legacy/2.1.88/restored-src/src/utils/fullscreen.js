// agent-cil currently uses the normal terminal buffer, not the alternate
// fullscreen screen. The original input hook uses this flag only to decide
// whether PgUp/PgDn should be reserved for message scrolling.
export function isFullscreenEnvEnabled() {
  return false;
}
