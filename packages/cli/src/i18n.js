import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const LANGUAGE_PREFERENCES = Object.freeze(['auto', 'zh-CN', 'en']);
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en']);

const MESSAGES = {
  en: {
    errorPrefix: 'agent-cil:', languageInvalid: 'Language must be auto, zh-CN, or en.',
    languageUsage: 'Usage: /language [auto|zh-CN|en]', languageCurrent: 'Interface language: {language}',
    languageSet: 'Interface language set to {language}.',
    languageSaveFailed: 'Could not save the language preference: {reason}',
    modelCurrent: '[model] Current model: {model} (setting: {setting})',
    modelUsage: '[model] Usage: /model [model-name|default]. Anthropic aliases: sonnet, opus, haiku, best, opusplan. Extended [1m] context requires an unported source capability.',
    modelSet: '[model] Set model to {model}.', modelUnchanged: '[model] Model unchanged: {reason}',
    modelConfigFailed: 'Model configuration failed: {reason}', modelIdentifierEmpty: 'Model identifier cannot be empty.',
    permissionModeInvalid: '--permission-mode must be default, acceptEdits, or plan.',
    permissionModeConflict: '--allow-edits cannot be combined with a different --permission-mode.',
    languageNameZh: 'Simplified Chinese', languageNameEn: 'English',
    languageNameAuto: 'Automatic ({language})',
    interactiveStarted: 'agent-cil interactive mode. Type /exit to quit; use /model to inspect or change model; use /language to change the interface language.',
    userPrompt: 'you> ', assistantPrompt: 'assistant> ',
    permissionDeniedUnavailable: '[permission] denied {tool}: interactive approval is unavailable.',
    permissionRequest: '[permission] {tool}: {reason}', approvalPrompt: 'Approve this tool call? [y/N] ',
    permissionAutoApproved: '[permission] auto-approved {tool} (--allow-edits)',
    toolStarted: '[tool] {tool}', toolFailed: '[tool] {tool} {status}',
    toolDenied: 'denied', toolError: 'failed',
    contextCompacted: '[context] compacted {before} → {after} messages; recent tool turns preserved.',
    interrupted: 'Interrupted.', sessionStarted: '[session] {id} {state}',
    sessionCreated: 'created', sessionResumed: 'resumed',
    sessionStartedToolExecutions: '[session] {count} tool execution(s) were recorded as started; verify side effects before resuming.',
    sessionMappedResults: '[session] {count} mapped tool result(s) were saved before PostToolUse; Hook completion still requires reconciliation.',
    sessionNeedsReview: 'Session contains completed tool results but failed Hook/native context normalization. Inspect the preserved results and Hook side effects before continuing; automatic replay is unsafe.',
    sessionUnfinishedBatch: 'Session contains an unfinished tool batch. Inspect side effects and reconcile the session before continuing; automatic replay is unsafe.',
    sessionNoPendingPrompt: 'Session has no committed pending user prompt or tool result. Supply a new prompt to continue.',
    interruptedByUser: 'Interrupted by user.', terminatedBySignal: 'Terminated by SIGTERM.',
    invalidArgv: 'argv must be an array of strings.', promptTooLarge: 'Prompt from stdin exceeds the 1 MiB limit.',
    recoveryNeedsReview: '[recovery] Completed tool results were saved, but post-tool context needs manual review. Automatic replay is blocked.',
    recoveryToolResults: '[recovery] Completed tool results were retained. Continue the conversation without re-running previous tools.',
    recoveryPrompt: '[recovery] The unanswered prompt was saved. It can be retried with --resume after restart.',
    noPromptPrint: 'No prompt provided. Pass a prompt or pipe stdin.',
    noPrompt: 'No prompt provided. Pass a prompt, pipe stdin, or start an interactive session.',
    credentialRequired: '{name} is required. Supply it via the environment, not CLI arguments.',
    workspaceUnavailable: 'Workspace directory is unavailable: {path} ({reason})',
    notDirectory: 'Path is not a directory.',
    compactThresholdInvalid: 'AGENT_CIL_COMPACT_THRESHOLD must be an integer from 0 to 2000000.',
    maxTokensReached: 'Model output reached --max-tokens before finishing. Increase --max-tokens or continue the conversation.',
    maxTurnsReached: 'Agent reached --max-turns ({count}) without a final response. Increase --max-turns or continue the conversation.',
    argumentRequiresValue: '{option} requires a value.', unknownOption: 'Unknown option: {option}',
    sessionInitFailed: 'Session initialization failed: {reason}',
    taskRecoveryFailed: 'Task output recovery failed: {reason}',
    hookConfigFailed: 'Tool Hook configuration failed: {reason}',
    helpUsage: 'Usage:', helpOptions: 'Options:', helpEnvironment: 'Environment:',
    helpTools: 'Built-in tools:',
    helpDescription: 'This CLI uses the repository AgentLoop and Messages API adapter.',
    helpResume: 'Resume uses a versioned committed-checkpoint JSONL subset; full original sessionStorage is pending.',
    helpLimitations: 'The full official CLI configuration, OAuth and MCP contract is not implemented.',
  },
  'zh-CN': {
    errorPrefix: 'agent-cil：', languageInvalid: '语言必须是 auto、zh-CN 或 en。',
    languageUsage: '用法：/language [auto|zh-CN|en]', languageCurrent: '当前界面语言：{language}',
    languageSet: '界面语言已切换为 {language}。', languageSaveFailed: '无法保存语言设置：{reason}',
    modelCurrent: '[模型] 当前模型：{model}（设置：{setting}）',
    modelUsage: '[模型] 用法：/model [模型名称|default]。Anthropic 别名：sonnet、opus、haiku、best、opusplan。扩展 [1m] 上下文需要尚未移植的原版能力。',
    modelSet: '[模型] 已切换到 {model}。', modelUnchanged: '[模型] 模型未更改：{reason}',
    modelConfigFailed: '模型配置失败：{reason}', modelIdentifierEmpty: '模型标识不能为空。',
    permissionModeInvalid: '--permission-mode 必须是 default、acceptEdits 或 plan。',
    permissionModeConflict: '--allow-edits 不能与其他 --permission-mode 同时使用。',
    languageNameZh: '简体中文', languageNameEn: '英语',
    languageNameAuto: '自动检测（当前：{language}）',
    interactiveStarted: 'agent-cil 交互模式。输入 /exit 退出，使用 /model 查看或切换模型，使用 /language 切换界面语言。',
    userPrompt: '你> ', assistantPrompt: '助手> ',
    permissionDeniedUnavailable: '[权限] 已拒绝 {tool}：当前无法进行交互式审批。',
    permissionRequest: '[权限] {tool}：{reason}', approvalPrompt: '是否批准此工具调用？[y/N] ',
    permissionAutoApproved: '[权限] 已自动批准 {tool}（--allow-edits）',
    toolStarted: '[工具] {tool}', toolFailed: '[工具] {tool} {status}',
    toolDenied: '已拒绝', toolError: '执行失败',
    contextCompacted: '[上下文] 已将消息从 {before} 条压缩至 {after} 条；最近的工具调用记录已保留。',
    interrupted: '已中断。', sessionStarted: '[会话] {id} {state}',
    sessionCreated: '已创建', sessionResumed: '已恢复',
    sessionStartedToolExecutions: '[会话] 已记录 {count} 个已启动但尚未确认结果的工具调用；恢复前请检查其副作用。',
    sessionMappedResults: '[会话] 已在 PostToolUse 之前保存 {count} 个工具结果；仍需核对 Hook 是否完成。',
    sessionNeedsReview: '会话包含已完成的工具结果，但 Hook 或原生上下文规范化失败。继续前请检查已保存的结果和 Hook 副作用；已阻止自动重放。',
    sessionUnfinishedBatch: '会话包含未完成的工具批次。继续前请检查副作用并核对会话；已阻止自动重放。',
    sessionNoPendingPrompt: '会话中没有已提交且待处理的提示词或工具结果。请提供新的提示词继续。',
    interruptedByUser: '用户已中断。', terminatedBySignal: '进程收到 SIGTERM，已终止。',
    invalidArgv: 'argv 必须是字符串数组。', promptTooLarge: '标准输入中的提示词超过 1 MiB 限制。',
    recoveryNeedsReview: '[恢复] 已保存已完成的工具结果，但工具执行后的上下文需要人工检查。已阻止自动重放。',
    recoveryToolResults: '[恢复] 已保留已完成的工具结果。可以继续对话，不会重复执行之前的工具。',
    recoveryPrompt: '[恢复] 尚未得到回答的提示词已保存。重启后可使用 --resume 重试。',
    noPromptPrint: '未提供提示词。请传入提示词或通过标准输入传入内容。',
    noPrompt: '未提供提示词。请传入提示词、通过标准输入传入内容，或启动交互会话。',
    credentialRequired: '缺少 {name}。请通过环境变量提供凭证，不要将凭证写入命令行参数。',
    workspaceUnavailable: '工作区目录不可用：{path}（{reason}）',
    notDirectory: '指定路径不是目录。',
    compactThresholdInvalid: 'AGENT_CIL_COMPACT_THRESHOLD 必须是 0 到 2000000 之间的整数。',
    maxTokensReached: '模型输出达到 --max-tokens 上限，尚未完成。请提高 --max-tokens 或继续对话。',
    maxTurnsReached: 'Agent 已达到 --max-turns（{count}）上限，尚未生成最终回复。请提高 --max-turns 或继续对话。',
    argumentRequiresValue: '{option} 需要提供参数值。', unknownOption: '未知选项：{option}',
    sessionInitFailed: '会话初始化失败：{reason}', taskRecoveryFailed: '任务输出恢复失败：{reason}',
    hookConfigFailed: '工具 Hook 配置失败：{reason}',
    helpUsage: '用法：', helpOptions: '选项：', helpEnvironment: '环境变量：', helpTools: '内置工具：',
    helpDescription: '此 CLI 使用仓库中的 AgentLoop 和 Messages API 适配器。',
    helpResume: '会话恢复使用带版本号的已提交检查点 JSONL 子集；完整原版 sessionStorage 尚未移植。',
    helpLimitations: '完整官方 CLI 配置、OAuth 和 MCP 契约尚未实现。',
  },
};

const HELP_LINES = {
  en: [
    'agent-cil {version}', '', 'helpUsage',
    '  agent-cil [options] [prompt]', '  agent-cil --print [options] [prompt]', '  agent-cil --version',
    '  Interactive TTY commands: /model [name], /model default, /model --help, /language [auto|zh-CN|en], /exit', '',
    'helpOptions', '  -h, --help              Show help', '  -v, -V, --version       Show version',
    '  -p, --print             Run one prompt and print only the assistant response',
    '      --language <auto|zh-CN|en>  Interface language (persisted)',
    '      --model <name>      Model ID; Anthropic aliases: sonnet, opus, haiku, best, opusplan',
    '      --base-url <url>    API endpoint base URL (defaults to provider URL)',
    '      --provider <name>   anthropic (default), deepseek, or openai',
    '      --max-tokens <n>    Maximum output tokens (default: 4096)',
    '      --max-turns <n>     Maximum model rounds per prompt (default: 8)',
    '      --compact-threshold <n>  Override model-specific auto-compact threshold (0 disables)',
    '      --max-retries <n>   HTTP retries before streaming (default: 2, max: 5)',
    '      --allow-edits       Alias for --permission-mode acceptEdits',
    '      --permission-mode <mode>  default, acceptEdits, or plan (read-only)',
    '      --allowedTools <name>    Allow tool or literal Bash(command), repeatable',
    '      --disallowedTools <name> Deny tool or Bash(command/prefix/wildcard), repeatable',
    '      --askTools <name>        Ask tool or Bash(command/prefix/wildcard), repeatable',
    '      --hooks-file <path> Explicitly trust a tool-hook settings JSON file (Pre/Post/Failure)',
    '      --session-id <uuid> Start a fresh, named persisted CLI session',
    '      --resume <uuid>     Resume a session; omit prompt to finish a committed tool round',
    '      --system <text>     System prompt', '      --cwd <path>        Workspace directory (default: current directory)', '',
    'helpEnvironment', '  ANTHROPIC_API_KEY       Required for model requests',
    '  ANTHROPIC_MODEL         Default model name', '  ANTHROPIC_BASE_URL      Optional Anthropic-compatible endpoint',
    '  DEEPSEEK_API_KEY        DeepSeek key (fallback: ANTHROPIC_API_KEY)',
    '  OPENAI_API_KEY          OpenAI key for --provider openai', '  OPENAI_MODEL            Default OpenAI model ID',
    '  OPENAI_BASE_URL         Optional OpenAI Chat API base URL',
    '  AGENT_CIL_COMPACT_THRESHOLD  Override auto-compact trigger in tokens',
    '  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE  Source 2.1.88 percentage override for known Anthropic 200K models',
    '  DISABLE_AUTO_COMPACT / DISABLE_COMPACT  Disable implicit Anthropic auto-compaction', '',
    'helpTools', '  Read, Glob, Grep       Read-only workspace tools',
    '  Write, Edit, Bash      Require interactive approval before execution', '',
    'helpDescription', 'helpResume', 'helpLimitations',
  ],
  'zh-CN': [
    'agent-cil {version}', '', 'helpUsage',
    '  agent-cil [选项] [提示词]', '  agent-cil --print [选项] [提示词]', '  agent-cil --version',
    '  交互命令：/model [模型名称]、/model default、/model --help、/language [auto|zh-CN|en]、/exit', '',
    'helpOptions', '  -h, --help              显示帮助', '  -v, -V, --version       显示版本',
    '  -p, --print             执行单次请求，仅输出助手回复',
    '      --language <auto|zh-CN|en>  界面语言（自动检测或持久化设置）',
    '      --model <名称>      模型 ID；Anthropic 别名：sonnet、opus、haiku、best、opusplan',
    '      --base-url <URL>    API 端点地址（默认使用服务提供商地址）',
    '      --provider <名称>   anthropic（默认）、deepseek 或 openai',
    '      --max-tokens <数量> 最大输出 Token 数（默认：4096）',
    '      --max-turns <数量> 每次提示词最多执行的模型轮数（默认：8）',
    '      --compact-threshold <数量> 覆盖模型专用的自动压缩阈值（0 表示禁用）',
    '      --max-retries <数量> 开始流式请求前的 HTTP 重试次数（默认：2，最大：5）',
    '      --allow-edits       --permission-mode acceptEdits 的别名',
    '      --permission-mode <模式>  default、acceptEdits 或 plan（只读）',
    '      --allowedTools <名称>    允许指定工具或 Bash(command)，可重复指定',
    '      --disallowedTools <名称> 禁止指定工具或 Bash(command/prefix/wildcard)，可重复指定',
    '      --askTools <名称>        对指定工具或 Bash(command/prefix/wildcard) 询问审批',
    '      --hooks-file <路径> 显式信任工具 Hook 设置文件（Pre/Post/Failure）',
    '      --session-id <UUID> 创建指定 ID 的持久化会话',
    '      --resume <UUID>     恢复会话；不提供提示词时继续已提交的工具轮次',
    '      --system <文本>     系统提示词', '      --cwd <路径>        工作区目录（默认：当前目录）', '',
    'helpEnvironment', '  ANTHROPIC_API_KEY       模型请求所需的 API Key',
    '  ANTHROPIC_MODEL         默认模型名称', '  ANTHROPIC_BASE_URL      可选的 Anthropic 兼容 API 地址',
    '  DEEPSEEK_API_KEY        DeepSeek 密钥（可回退使用 ANTHROPIC_API_KEY）',
    '  OPENAI_API_KEY          OpenAI 服务的 API Key', '  OPENAI_MODEL            默认 OpenAI 模型 ID',
    '  OPENAI_BASE_URL         可选的 OpenAI Chat API 地址',
    '  AGENT_CIL_COMPACT_THRESHOLD  自动压缩的 Token 阈值',
    '  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE  对已知 Anthropic 200K 模型覆盖 2.1.88 自动压缩百分比',
    '  DISABLE_AUTO_COMPACT / DISABLE_COMPACT  禁用 Anthropic 隐式自动压缩', '',
    'helpTools', '  Read、Glob、Grep       只读工作区工具', '  Write、Edit、Bash      执行前需要交互式审批', '',
    'helpDescription', 'helpResume', 'helpLimitations',
  ],
};

function format(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

function normalizeLocaleToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim().replace(/_/g, '-').split('.')[0].split('@')[0].toLowerCase();
  if (!token || token === 'c' || token === 'posix') return null;
  if (/^zh(?:-|$)/.test(token)) {
    if (/^zh-(?:tw|hk|mo|hant)(?:-|$)/.test(token)) return null;
    return 'zh-CN';
  }
  if (/^en(?:-|$)/.test(token)) return 'en';
  return null;
}

export function normalizeLanguagePreference(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (normalized === 'zh-cn' || normalized === 'zh_cn' || normalized === 'zh') return 'zh-CN';
  if (normalized === 'en' || normalized === 'en-us' || normalized === 'en-gb') return 'en';
  return null;
}

export function detectSystemLanguage(env = process.env, intlLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const candidates = [env.LC_ALL, env.LC_MESSAGES, env.LANG,
    typeof env.LANGUAGE === 'string' ? env.LANGUAGE.split(':')[0] : undefined, intlLocale];
  for (const candidate of candidates) {
    const locale = normalizeLocaleToken(candidate);
    if (locale) return locale;
  }
  return 'en';
}

export function resolveLanguage(preference = 'auto', env = process.env, intlLocale) {
  const normalized = normalizeLanguagePreference(preference) ?? 'auto';
  return normalized === 'auto' ? detectSystemLanguage(env, intlLocale) : normalized;
}

export function getLanguageConfigPath(env = process.env, homeDirectory = homedir()) {
  if (typeof env.AGENT_CIL_CONFIG_PATH === 'string' && env.AGENT_CIL_CONFIG_PATH.trim()) {
    return resolve(env.AGENT_CIL_CONFIG_PATH);
  }
  if (typeof env.AGENT_CIL_CONFIG_DIR === 'string' && env.AGENT_CIL_CONFIG_DIR.trim()) {
    return join(resolve(env.AGENT_CIL_CONFIG_DIR), 'config.json');
  }
  if (typeof env.APPDATA === 'string' && env.APPDATA.trim()) return join(env.APPDATA, 'agent-cil', 'config.json');
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()) return join(env.XDG_CONFIG_HOME, 'agent-cil', 'config.json');
  return process.platform === 'win32'
    ? join(homeDirectory, 'AppData', 'Roaming', 'agent-cil', 'config.json')
    : join(homeDirectory, '.config', 'agent-cil', 'config.json');
}

export async function loadLanguagePreference({ env = process.env, homeDirectory = homedir(), intlLocale } = {}) {
  const configPath = getLanguageConfigPath(env, homeDirectory);
  let config = {};
  let configError;
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('The user configuration root must be a JSON object.');
    }
    config = parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') configError = error;
  }
  const preference = normalizeLanguagePreference(config.language) ?? 'auto';
  return { preference, locale: resolveLanguage(preference, env, intlLocale), configPath, config, configError };
}

export async function saveLanguagePreference(language, { env = process.env, homeDirectory = homedir() } = {}) {
  const preference = normalizeLanguagePreference(language);
  if (!preference) throw new TypeError('Language must be auto, zh-CN, or en.');
  const configPath = getLanguageConfigPath(env, homeDirectory);
  let config = {};
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('The user configuration root must be a JSON object.');
    }
    config = parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const nextConfig = { ...config, language: preference };
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = configPath + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, JSON.stringify(nextConfig, null, 2) + '\n', {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { preference, locale: resolveLanguage(preference, env), configPath, config: nextConfig };
}

export function languageLabel(locale, preference = locale) {
  if (preference === 'auto') {
    return translate(locale, 'languageNameAuto', {
      language: locale === 'zh-CN' ? translate(locale, 'languageNameZh') : translate(locale, 'languageNameEn'),
    });
  }
  return translate(locale, locale === 'zh-CN' ? 'languageNameZh' : 'languageNameEn');
}

export function translate(locale, key, values = {}) {
  const language = SUPPORTED_LOCALES.includes(locale) ? locale : 'en';
  return format(MESSAGES[language][key] ?? MESSAGES.en[key] ?? key, values);
}

export function getHelp(locale = 'en', version = '0.1.0') {
  const language = SUPPORTED_LOCALES.includes(locale) ? locale : 'en';
  const headings = new Set(['helpUsage', 'helpOptions', 'helpEnvironment', 'helpTools',
    'helpDescription', 'helpResume', 'helpLimitations']);
  return HELP_LINES[language].map(line => headings.has(line)
    ? translate(language, line)
    : line.replace('{version}', version)).join('\n') + '\n';
}

export function localizeCliMessage(message, locale = 'en') {
  if (locale !== 'zh-CN' || typeof message !== 'string') return message;
  const patterns = [
    [/^([A-Z0-9_]+) is required\. Supply it via the environment, not CLI arguments\.$/, 'credentialRequired', m => ({ name: m[1] })],
    [/^No prompt provided\. Pass a prompt or pipe stdin\.$/, 'noPromptPrint', () => ({})],
    [/^No prompt provided\. Pass a prompt, pipe stdin, or start an interactive session\.$/, 'noPrompt', () => ({})],
    [/^Workspace directory is unavailable: (.+) \((.+)\)$/, 'workspaceUnavailable', m => ({ path: m[1], reason: m[2] })],
    [/^Path is not a directory\.$/, 'notDirectory', () => ({})],
    [/^AGENT_CIL_COMPACT_THRESHOLD must be an integer from 0 to 2000000\.$/, 'compactThresholdInvalid', () => ({})],
    [/^Model output reached --max-tokens before finishing\. Increase --max-tokens or continue the conversation\.$/, 'maxTokensReached', () => ({})],
    [/^Agent reached --max-turns \((\d+)\) without a final response\. Increase --max-turns or continue the conversation\.$/, 'maxTurnsReached', m => ({ count: m[1] })],
    [/^Language must be auto, zh-CN, or en\.$/, 'languageInvalid', () => ({})],
    [/^Model configuration failed: (.+)$/, 'modelConfigFailed', m => ({ reason: m[1] })],
    [/^Model identifier cannot be empty\.$/, 'modelIdentifierEmpty', () => ({})],
    [/^--permission-mode must be default, acceptEdits, or plan\.$/, 'permissionModeInvalid', () => ({})],
    [/^--allow-edits cannot be combined with a different --permission-mode\.$/, 'permissionModeConflict', () => ({})],
    [/^argv must be an array of strings\.$/, 'invalidArgv', () => ({})],
    [/^Prompt from stdin exceeds the 1 MiB limit\.$/, 'promptTooLarge', () => ({})],
    [/^Interrupted by user\.$/, 'interruptedByUser', () => ({})],
    [/^Terminated by SIGTERM\.$/, 'terminatedBySignal', () => ({})],
    [/^Session contains completed tool results but failed Hook\/native context normalization\. Inspect the preserved results and Hook side effects before continuing; automatic replay is unsafe\.$/, 'sessionNeedsReview', () => ({})],
    [/^Session contains an unfinished tool batch\. Inspect side effects and reconcile the session before continuing; automatic replay is unsafe\.$/, 'sessionUnfinishedBatch', () => ({})],
    [/^Session has no committed pending user prompt or tool result\. Supply a new prompt to continue\.$/, 'sessionNoPendingPrompt', () => ({})],
    [/^Unknown option: (.+)$/, 'unknownOption', m => ({ option: m[1] })],
    [/^(.+) requires a value\.$/, 'argumentRequiresValue', m => ({ option: m[1] })],
    [/^Session initialization failed: (.+)$/, 'sessionInitFailed', m => ({ reason: m[1] })],
    [/^Task output recovery failed: (.+)$/, 'taskRecoveryFailed', m => ({ reason: m[1] })],
    [/^Tool Hook configuration failed: (.+)$/, 'hookConfigFailed', m => ({ reason: m[1] })],
  ];
  for (const [pattern, key, values] of patterns) {
    const match = message.match(pattern);
    if (match) return translate(locale, key, values(match));
  }
  return message;
}
