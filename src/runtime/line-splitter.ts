// line-splitter.ts — NDJSON framing for a child process' stdout.
//
// A chunk boundary can fall anywhere inside a line, so bytes are buffered until a
// newline arrives. `\r\n` is normalized to `\n` (a Windows CLI commonly emits it).
// A single line that never terminates is force-emitted once it exceeds
// MAX_LINE_CHARS so a runaway stream cannot grow the buffer without bound.
export interface LineSplitter {
  feed(chunk: string): string[];
  /** Emit the unterminated remainder (call once, at end of stream). */
  flush(): string[];
}

export const MAX_LINE_CHARS = 1024 * 1024;

export function createLineSplitter(maxLineChars: number = MAX_LINE_CHARS): LineSplitter {
  let buf = "";
  const take = (): string[] => {
    const out: string[] = [];
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      out.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      idx = buf.indexOf("\n");
    }
    if (buf.length > maxLineChars) {
      out.push(buf);
      buf = "";
    }
    return out;
  };
  return {
    feed(chunk: string): string[] {
      if (typeof chunk !== "string" || !chunk) return [];
      buf += chunk;
      return take();
    },
    flush(): string[] {
      const rest = buf;
      buf = "";
      return rest ? [rest.endsWith("\r") ? rest.slice(0, -1) : rest] : [];
    }
  };
}
