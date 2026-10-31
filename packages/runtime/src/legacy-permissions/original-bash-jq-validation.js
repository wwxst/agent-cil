/**
 * Bash jq preflight from user-owned CLI 2.1.88
 * restored-src/src/tools/BashTool/bashSecurity.ts:validateJqCommand().
 * The source body below only removes TS annotations and analytics logging.
 *
 * CLI 2.1.304 modules/chunk-jfhbcs0s.js also validates parsed argv for
 * jq include/import and combined -f/-L or long file flags. Its exact
 * positional tests are retained below, after the original source check.
 * This is a security gate, not a new Bash parser or an auto-allow classifier.
 */
function validateJqCommand(context) {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'jq') {
    return { behavior: 'passthrough', message: 'Not jq' }
  }

  if (/\bsystem\s*\(/.test(originalCommand)) {
    return {
      behavior: 'ask',
      message:
        'jq command contains system() function which executes arbitrary commands',
    }
  }

  // File arguments are now allowed - they will be validated by path validation in readOnlyValidation.ts
  // Only block dangerous flags that could read files into jq variables
  const afterJq = originalCommand.substring(3).trim()
  if (
    /(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(
      afterJq,
    )
  ) {
    return {
      behavior: 'ask',
      message:
        'jq command contains dangerous flags that could execute code or read arbitrary files',
    }
  }

  return { behavior: 'passthrough', message: 'jq command is safe' }
}

// CLI 2.1.304 chunk-jfhbcs0s.js: verified jq argv branch.
// The original source AST owns argv parsing; do not split shell text here.
function validateJqParsedArgs21304(argv) {
  if (argv[0] !== 'jq') {
    return {behavior:'passthrough',message:'Not jq'}
  }
  for (const arg of argv) {
    if (/\bsystem\s*\(/.test(arg))
      return {behavior:'ask',message:'jq command contains system() function which executes arbitrary commands'}
    if (/\b(?:include|import)\b/.test(arg))
      return {behavior:'ask',message:'jq command contains include/import — modules can load arbitrary .jq files via {search:"."} and call env or other builtins'}
  }
  if (argv.some(arg=>/^(?:-[A-Za-z]*[fL]|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/.test(arg)))
    return {behavior:'ask',message:'jq command contains dangerous flags that could execute code or read arbitrary files'}
  return {behavior:'passthrough',message:'jq parsed arguments passed original/new validator'}
}

export function checkOriginalJqCommandSecurity(command,argv) {
  if (argv[0] !== 'jq') return {behavior:'passthrough',message:'Not jq'}
  const original=validateJqCommand({
    originalCommand:command,baseCommand:'jq',
  })
  if (original.behavior !== 'passthrough') return original
  return validateJqParsedArgs21304(argv)
}

export {validateJqCommand,validateJqParsedArgs21304}
