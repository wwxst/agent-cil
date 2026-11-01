// Node compatibility boundary for the original 2.1.88 Markdown formatter.
// This is the exact source stripPromptXMLTags helper; the rest of the original
// messages.ts module depends on the full REPL state graph and is not imported here.
const STRIPPED_TAGS_RE =
  /<(commit_analysis|context|function_analysis|pr_analysis)>.*?<\/\1>\n?/gs;

export function stripPromptXMLTags(content) {
  return content.replace(STRIPPED_TAGS_RE, '').trim();
}
