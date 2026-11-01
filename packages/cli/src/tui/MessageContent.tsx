import React, { useMemo } from 'react';
import { marked } from 'marked';
import Box from '../../../../legacy/2.1.88/restored-src/src/ink/components/Box.js';
import { Ansi } from '../../../../legacy/2.1.88/restored-src/src/ink/Ansi.js';
import { MarkdownTable } from '../../../../legacy/2.1.88/restored-src/src/components/MarkdownTable.js';
import {
  configureMarked,
  formatToken,
} from '../../../../legacy/2.1.88/restored-src/src/utils/markdown.js';
import {
  stripPromptXMLTags,
} from '../../../../legacy/2.1.88/restored-src/src/utils/messages.js';

export default function MessageContent({ text }) {
  const elements = useMemo(() => {
    configureMarked();
    const tokens = marked.lexer(stripPromptXMLTags(String(text ?? '')));
    const rendered = [];
    let nonTableContent = '';

    const flushNonTableContent = () => {
      if (nonTableContent) {
        rendered.push(
          <Ansi key={rendered.length}>{nonTableContent.trim()}</Ansi>,
        );
        nonTableContent = '';
      }
    };

    for (const token of tokens) {
      if (token.type === 'table') {
        flushNonTableContent();
        rendered.push(
          <MarkdownTable
            key={rendered.length}
            token={token}
            highlight={null}
          />,
        );
      } else {
        nonTableContent += formatToken(token, 'dark', 0, null, null, null);
      }
    }
    flushNonTableContent();
    return rendered;
  }, [text]);

  return <Box flexDirection="column" gap={1}>{elements}</Box>;
}
