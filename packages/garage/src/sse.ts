// A pure, incremental Server-Sent Events parser. Feed it text chunks as they arrive (split anywhere, even mid-line
// or between a CR and its LF) and it returns the frames those chunks completed. No DOM, no node, no I/O.

export interface SseFrame {
  /** The `event:` name; `message` when the frame names none. */
  event: string;
  /** The `data:` lines joined with `\n`. */
  data: string;
  /** The `id:` of this frame, null when it carried none (the daemon's `resync` frame has no id). */
  id: string | null;
}

export interface SseParser {
  /** Consume the next chunk of the stream and return every frame it completed, in order. */
  push(chunk: string): SseFrame[];
}

/** The daemon sends `event: resync` with data `{}` when a catch-up outgrew its cap: the client must run a full sync. */
export const isResync = (frame: SseFrame): boolean => frame.event === 'resync';

export function createSseParser(): SseParser {
  let pending = '';
  let skipLf = false; // the last chunk ended on a CR: a leading LF in the next one belongs to it
  let first = true;
  let event = '';
  let id: string | null = null;
  let data: string[] = [];

  const line = (text: string, out: SseFrame[]): void => {
    if (text === '') {
      // A blank line dispatches; a frame with no data lines is dropped, as the SSE spec says.
      if (data.length) out.push({ event: event || 'message', data: data.join('\n'), id });
      event = '';
      id = null;
      data = [];
      return;
    }
    if (text.startsWith(':')) return; // comment (the daemon's keep-alive)
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
    // `retry` and unknown fields are ignored.
  };

  return {
    push(chunk) {
      if (first && chunk) {
        first = false;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      }
      if (skipLf && chunk) {
        if (chunk.startsWith('\n')) chunk = chunk.slice(1);
        skipLf = false;
      }
      const out: SseFrame[] = [];
      const buf = pending + chunk;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        line(buf.slice(start, i), out);
        if (c === 13) {
          if (i + 1 < buf.length) {
            if (buf.charCodeAt(i + 1) === 10) i++;
          } else {
            skipLf = true;
          }
        }
        start = i + 1;
      }
      pending = buf.slice(start);
      return out;
    },
  };
}
