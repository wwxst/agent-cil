/**
 * CLI 2.1.88 tools/BashTool/commandSemantics.ts
 * Port of DEFAULT_SEMANTIC, COMMAND_SEMANTICS, getCommandSemantic,
 * extractBaseCommand and interpretCommandResult.
 *
 * Source uses splitCommand_DEPRECATED() from utils/bash/commands.ts to
 * heuristically choose the last pipeline segment. That full 2.1.88 Bash
 * parser/AST dependency is not yet runnable in Node. Only classify commands
 * whose leading executable and syntax are unambiguous; fall back to the
 * ORIGINAL default semantic for anything with unsupported shell grammar.
 * This helper is NOT a permission check and never authorizes shell commands.
 */
import { tryParseShellCommand } from '../../runtime/src/legacy-permissions/bash-shell-quote.js';

// Source commandSemantics.ts: the nonzero status is only an actual BashTool
// failure for commands where the exit status convention says so.
const DEFAULT_SEMANTIC = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message: exitCode !== 0
    ? `Command failed with exit code ${exitCode}` : undefined,
});
const COMMAND_SEMANTICS = new Map([
  ['grep', (exitCode, _stdout, _stderr) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? 'No matches found' : undefined,
  })],
  ['rg', (exitCode, _stdout, _stderr) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? 'No matches found' : undefined,
  })],
  ['find', (exitCode, _stdout, _stderr) => ({
    isError: exitCode >= 2,
    message: exitCode === 1
      ? 'Some directories were inaccessible' : undefined,
  })],
  ['diff', (exitCode, _stdout, _stderr) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? 'Files differ' : undefined,
  })],
  ['test', (exitCode, _stdout, _stderr) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? 'Condition is false' : undefined,
  })],
  ['[', (exitCode, _stdout, _stderr) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? 'Condition is false' : undefined,
  })],
]);

function extractBaseCommand(command) {
  return command.trim().split(/\s+/)[0] || '';
}

function heuristicallyExtractBaseCommand(command) {
  // The original utils/bash/commands.ts splitter is not yet available:
  // never apply "grep exit 1 means no match" to an arbitrary pipeline,
  // injection or compound command (whose final process might be different).
  const parse = tryParseShellCommand(command, name => '$' + name);
  if (!parse.success || !parse.tokens?.length ||
      /[\r\n]/.test(command) ||
      parse.tokens.some(t => typeof t !== 'string') ||
      /[;&|<>\x60]/.test(command) ||
      /\$[({]/.test(command)) return '';
  const first = extractBaseCommand(command);
  // The original command semantic map only covers executable names, not
  // env-var assignments, shell wrappers or redirection after arguments.
  if (parse.tokens[0] !== first) return '';
  return first;
}
function getCommandSemantic(command) {
  const baseCommand = heuristicallyExtractBaseCommand(command);
  return COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC;
}
export function interpretCommandResult(command, exitCode, stdout, stderr) {
  const result = getCommandSemantic(command)(exitCode, stdout, stderr);
  return { isError: result.isError, message: result.message };
}
