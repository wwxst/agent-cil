import React, { useMemo } from 'react';
import { Ansi } from '../../../../legacy/2.1.88/restored-src/src/ink/Ansi.js';
import { applyMarkdown } from '../../../../legacy/2.1.88/restored-src/src/utils/markdown.js';

export default function MessageContent({ text }) {
  const rendered = useMemo(
    () => applyMarkdown(String(text ?? ''), 'dark'),
    [text],
  );
  return <Ansi>{rendered || ' '}</Ansi>;
}
