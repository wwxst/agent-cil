// Node compatibility boundary for the original 2.1.88 Ink ThemeProvider.
// agent-cil currently exposes a fixed dark TUI palette; persistence remains
// owned by the agent-cil settings layer rather than the restored REPL config.
const DEFAULT_CONFIG = Object.freeze({ theme: 'dark' });

export function getGlobalConfig() {
  return DEFAULT_CONFIG;
}

export function saveGlobalConfig(update) {
  return update(DEFAULT_CONFIG);
}
