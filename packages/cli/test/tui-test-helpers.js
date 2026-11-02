import stripAnsi from 'strip-ansi';

// Ink emits cursor-forward sequences for spaces in its incremental terminal
// renderer. strip-ansi removes those sequences, so restore their visual width
// before matching user-visible TUI text in PTY tests.
export function normalizeTuiOutput(output) {
  const withCursorSpaces = String(output ?? '').replace(
    /\x1b\[(\d*)C/g,
    (_sequence, count) => ' '.repeat(Number(count || 1)),
  );
  return stripAnsi(withCursorSpaces);
}

// Normalize text for assertions where terminal layout is irrelevant. Ink's
// incremental renderer can insert cursor-forward sequences next to existing
// spaces, so exact single-space matching is not reliable.
export function normalizeTuiText(output) {
  return normalizeTuiOutput(output).replace(/\s+/g, ' ').trim();
}

function compactTuiText(value) {
  return normalizeTuiOutput(value).replace(/\s+/g, '');
}

// Ink's incremental renderer uses cursor-forward to skip unchanged cells.
// A raw stream therefore contains cursor jumps between fragments of a word;
// replacing those jumps with spaces can turn "Bash" into "B ash". For
// semantic text assertions, compare the cumulative rendered characters while
// ignoring layout whitespace. Keep createTerminalScreen for tests that need
// exact viewport/cursor placement.
export async function waitForTuiText(getOutput, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const compactExpected = String(expected ?? '').replace(/\s+/g, '');
  let lastOutput = '';
  let visibleText = '';
  while (Date.now() < deadline) {
    lastOutput = String(getOutput() ?? '');
    visibleText = compactTuiText(lastOutput);
    if (visibleText.includes(compactExpected)) return lastOutput;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(
    'Timed out waiting for TUI text "' + expected + '":\n' + lastOutput,
  );
}

export async function waitForTuiTextAfter(
  getOutput,
  precedingText,
  expectedText,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastOutput = '';
  const compactPreceding = String(precedingText ?? '').replace(/\s+/g, '');
  const compactExpected = String(expectedText ?? '').replace(/\s+/g, '');
  while (Date.now() < deadline) {
    lastOutput = compactTuiText(getOutput());
    const precedingIndex = lastOutput.lastIndexOf(compactPreceding);
    const expectedIndex = lastOutput.lastIndexOf(compactExpected);
    if (precedingIndex >= 0 && expectedIndex > precedingIndex) return lastOutput;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(
    'Timed out waiting for TUI text "' + expectedText +
    '" after "' + precedingText + '":\n' + lastOutput,
  );
}

// Minimal VT screen for PTY assertions. Unlike stripAnsi(), this applies
// cursor movement and erase operations, so assertions inspect what a user
// actually sees instead of searching the renderer's incremental byte stream.
export function createTerminalScreen(columns, rows) {
  if (!Number.isInteger(columns) || columns < 1 ||
      !Number.isInteger(rows) || rows < 1) {
    throw new TypeError('Terminal dimensions must be positive integers.');
  }

  const blankLine = () => Array(columns).fill(' ');
  const cells = Array.from({ length: rows }, blankLine);
  let row = 0;
  let column = 0;
  let savedCursor = [0, 0];
  let scrollTop = 0;
  let scrollBottom = rows - 1;
  let pending = '';
  let wrapPending = false;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const parameter = value => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  function clearWrap() {
    wrapPending = false;
  }

  function scrollUp(count = 1) {
    for (let i = 0; i < count; i += 1) {
      for (let y = scrollTop; y < scrollBottom; y += 1) {
        cells[y] = cells[y + 1];
      }
      cells[scrollBottom] = blankLine();
    }
  }

  function scrollDown(count = 1) {
    for (let i = 0; i < count; i += 1) {
      for (let y = scrollBottom; y > scrollTop; y -= 1) {
        cells[y] = cells[y - 1];
      }
      cells[scrollTop] = blankLine();
    }
  }

  function lineFeed() {
    clearWrap();
    if (row === scrollBottom) {
      scrollUp(1);
    } else {
      row = Math.min(rows - 1, row + 1);
    }
  }

  function reverseIndex() {
    clearWrap();
    if (row === scrollTop) {
      scrollDown(1);
    } else {
      row = Math.max(0, row - 1);
    }
  }

  function eraseLine(mode) {
    if (mode === 0) {
      for (let x = column; x < columns; x += 1) cells[row][x] = ' ';
    } else if (mode === 1) {
      for (let x = 0; x <= column; x += 1) cells[row][x] = ' ';
    } else if (mode === 2) {
      cells[row] = blankLine();
    }
  }

  function eraseDisplay(mode) {
    if (mode === 0) {
      eraseLine(0);
      for (let y = row + 1; y < rows; y += 1) cells[y] = blankLine();
    } else if (mode === 1) {
      for (let y = 0; y < row; y += 1) cells[y] = blankLine();
      eraseLine(1);
    } else if (mode === 2) {
      for (let y = 0; y < rows; y += 1) cells[y] = blankLine();
    }
    // ED 3 clears terminal scrollback, which is outside this visible screen.
  }

  function insertLines(count) {
    if (row < scrollTop || row > scrollBottom) return;
    for (let i = 0; i < count; i += 1) {
      for (let y = scrollBottom; y > row; y -= 1) cells[y] = cells[y - 1];
      cells[row] = blankLine();
    }
  }

  function deleteLines(count) {
    if (row < scrollTop || row > scrollBottom) return;
    for (let i = 0; i < count; i += 1) {
      for (let y = row; y < scrollBottom; y += 1) cells[y] = cells[y + 1];
      cells[scrollBottom] = blankLine();
    }
  }

  function handleCsi(rawParameters, final) {
    const parameters = rawParameters.replace(/^[?>!]/, '').split(';').map(parameter);
    const first = parameters[0] || 0;
    const count = first || 1;

    switch (final) {
      case 'A':
        row = clamp(row - count, scrollTop, scrollBottom);
        clearWrap();
        break;
      case 'B':
        row = clamp(row + count, scrollTop, scrollBottom);
        clearWrap();
        break;
      case 'C':
        column = clamp(column + count, 0, columns - 1);
        clearWrap();
        break;
      case 'D':
        column = clamp(column - count, 0, columns - 1);
        clearWrap();
        break;
      case 'E':
        row = clamp(row + count, scrollTop, scrollBottom);
        column = 0;
        clearWrap();
        break;
      case 'F':
        row = clamp(row - count, scrollTop, scrollBottom);
        column = 0;
        clearWrap();
        break;
      case 'G':
        column = clamp(count - 1, 0, columns - 1);
        clearWrap();
        break;
      case 'd':
        row = clamp(count - 1, scrollTop, scrollBottom);
        clearWrap();
        break;
      case 'H':
      case 'f':
        row = clamp((parameters[0] || 1) - 1, scrollTop, scrollBottom);
        column = clamp((parameters[1] || 1) - 1, 0, columns - 1);
        clearWrap();
        break;
      case 'J':
        eraseDisplay(first);
        break;
      case 'K':
        eraseLine(first);
        break;
      case 'L':
        insertLines(count);
        break;
      case 'M':
        deleteLines(count);
        break;
      case 'S':
        scrollUp(count);
        break;
      case 'T':
        scrollDown(count);
        break;
      case '@':
        for (let i = 0; i < count; i += 1) {
          cells[row].splice(column, 0, ' ');
          cells[row].pop();
        }
        clearWrap();
        break;
      case 'P':
        for (let i = 0; i < count; i += 1) {
          cells[row].splice(column, 1);
          cells[row].push(' ');
        }
        clearWrap();
        break;
      case 'X':
        for (let x = column; x < Math.min(columns, column + count); x += 1) {
          cells[row][x] = ' ';
        }
        break;
      case 'I':
        column = clamp((Math.floor(column / 8) + count) * 8, 0, columns - 1);
        clearWrap();
        break;
      case 'Z':
        column = clamp((Math.floor(Math.max(0, column - 1) / 8) - count + 1) * 8, 0, columns - 1);
        clearWrap();
        break;
      case 'r':
        scrollTop = clamp((parameters[0] || 1) - 1, 0, rows - 1);
        scrollBottom = clamp((parameters[1] || rows) - 1, scrollTop, rows - 1);
        row = scrollTop;
        column = 0;
        clearWrap();
        break;
      case 's':
        savedCursor = [row, column];
        break;
      case 'u':
        row = clamp(savedCursor[0], 0, rows - 1);
        column = clamp(savedCursor[1], 0, columns - 1);
        clearWrap();
        break;
      // SGR, device reports, private modes and keyboard-mode controls do not
      // alter the visible character grid.
      case 'm':
      case 'h':
      case 'l':
      case 'q':
      case 'c':
      case 'n':
      case 't':
      case 'g':
      case 'p':
        break;
      default:
        break;
    }
  }

  function writeCharacter(character) {
    if (wrapPending) {
      column = 0;
      lineFeed();
    }
    cells[row][column] = character;
    if (column === columns - 1) {
      wrapPending = true;
    } else {
      column += 1;
    }
  }

  function write(chunk) {
    pending += String(chunk ?? '');
    let index = 0;

    while (index < pending.length) {
      const character = pending[index];

      if (character === '\x1b') {
        if (index + 1 >= pending.length) break;
        const introducer = pending[index + 1];

        if (introducer === '[') {
          let end = index + 2;
          while (end < pending.length &&
              !(pending.charCodeAt(end) >= 0x40 && pending.charCodeAt(end) <= 0x7e)) {
            end += 1;
          }
          if (end >= pending.length) break;
          handleCsi(pending.slice(index + 2, end), pending[end]);
          index = end + 1;
          continue;
        }

        if (introducer === ']' || introducer === 'P' ||
            introducer === '_' || introducer === '^' || introducer === 'X') {
          let end = index + 2;
          let terminated = false;
          while (end < pending.length) {
            if (pending[end] === '\x07') {
              end += 1;
              terminated = true;
              break;
            }
            if (pending[end] === '\x1b' && pending[end + 1] === '\\') {
              end += 2;
              terminated = true;
              break;
            }
            end += 1;
          }
          if (!terminated) break;
          index = end;
          continue;
        }

        if (introducer === '7') {
          savedCursor = [row, column];
        } else if (introducer === '8') {
          row = clamp(savedCursor[0], 0, rows - 1);
          column = clamp(savedCursor[1], 0, columns - 1);
          clearWrap();
        } else if (introducer === 'D') {
          lineFeed();
        } else if (introducer === 'E') {
          lineFeed();
          column = 0;
        } else if (introducer === 'M') {
          reverseIndex();
        } else if (introducer === 'c') {
          for (let y = 0; y < rows; y += 1) cells[y] = blankLine();
          row = 0;
          column = 0;
          scrollTop = 0;
          scrollBottom = rows - 1;
          clearWrap();
        }
        index += 2;
        continue;
      }

      if (character === '\r') {
        column = 0;
        clearWrap();
        index += 1;
        continue;
      }
      if (character === '\n') {
        lineFeed();
        index += 1;
        continue;
      }
      if (character === '\b') {
        column = Math.max(0, column - 1);
        clearWrap();
        index += 1;
        continue;
      }
      if (character === '\t') {
        column = clamp((Math.floor(column / 8) + 1) * 8, 0, columns - 1);
        clearWrap();
        index += 1;
        continue;
      }
      if (character >= ' ' && character !== '\x7f') {
        const codePoint = pending.codePointAt(index);
        const glyph = String.fromCodePoint(codePoint);
        writeCharacter(glyph);
        index += glyph.length;
        continue;
      }

      index += 1;
    }

    pending = pending.slice(index);
  }

  return {
    write,
    toString() {
      return cells.map(line => line.join('')).join('\n');
    },
    getCursor() {
      return { row, column };
    },
  };
}
