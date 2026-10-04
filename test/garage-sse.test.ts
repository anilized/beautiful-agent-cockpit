import { describe, expect, it } from 'vitest';
import { createSseParser, isResync, type SseFrame } from '../packages/garage/src/sse';

const parseAll = (chunks: string[]): SseFrame[] => {
  const p = createSseParser();
  return chunks.flatMap((c) => p.push(c));
};

const wire = 'id: 7\nevent: run.started\ndata: {"a":1}\n\n';
const frame7: SseFrame = { event: 'run.started', data: '{"a":1}', id: '7' };

describe('createSseParser', () => {
  it('parses a whole frame in one chunk', () => {
    expect(parseAll([wire])).toEqual([frame7]);
  });

  it('parses several frames in one chunk, in order', () => {
    expect(parseAll(['id: 1\ndata: a\n\nid: 2\ndata: b\n\n'])).toEqual([
      { event: 'message', data: 'a', id: '1' },
      { event: 'message', data: 'b', id: '2' },
    ]);
  });

  it('gives the same frames however the stream is split, down to one character per chunk', () => {
    const stream = `: hi\n\n${wire}id: 8\r\nevent: x\r\ndata: one\r\ndata: two\r\n\r\nevent: resync\ndata: {}\n\n`;
    const expected = parseAll([stream]);
    expect(expected).toHaveLength(3);
    expect(parseAll([...stream])).toEqual(expected);
    for (let i = 0; i <= stream.length; i++) expect(parseAll([stream.slice(0, i), stream.slice(i)])).toEqual(expected);
  });

  it('holds a chunk that ends mid-line until the line is finished', () => {
    const p = createSseParser();
    expect(p.push('id: 7\nevent: run.sta')).toEqual([]);
    expect(p.push('rted\ndata: {"a"')).toEqual([]);
    expect(p.push(':1}\n')).toEqual([]);
    expect(p.push('\n')).toEqual([frame7]);
  });

  it('does not dispatch until the blank line arrives', () => {
    const p = createSseParser();
    expect(p.push('data: x\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ event: 'message', data: 'x', id: null }]);
  });

  it('ignores comments, including keep-alives between frames and inside one', () => {
    expect(parseAll([': keep-alive\n\n'])).toEqual([]);
    expect(parseAll(['data: a\n: note\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb', id: null }]);
    expect(parseAll([':\n', 'id: 1\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x', id: '1' }]);
  });

  it('joins multi-line data with newlines and keeps empty data lines', () => {
    expect(parseAll(['data: a\ndata:\ndata: c\n\n'])[0]!.data).toBe('a\n\nc');
  });

  it('strips exactly one leading space from a value', () => {
    expect(parseAll(['data:  two\n\n'])[0]!.data).toBe(' two');
    expect(parseAll(['data:none\n\n'])[0]!.data).toBe('none');
  });

  it('keeps colons inside values', () => {
    expect(parseAll(['data: {"t":"a:b"}\n\n'])[0]!.data).toBe('{"t":"a:b"}');
  });

  it('defaults the event name to message and reads named events', () => {
    expect(parseAll(['data: x\n\n'])[0]!.event).toBe('message');
    expect(parseAll(['event: plan.created\ndata: x\n\n'])[0]!.event).toBe('plan.created');
  });

  it('does not carry an id or event name into the next frame', () => {
    expect(parseAll(['id: 3\nevent: a\ndata: 1\n\ndata: 2\n\n'])).toEqual([
      { event: 'a', data: '1', id: '3' },
      { event: 'message', data: '2', id: null },
    ]);
  });

  it('drops a frame that has no data', () => {
    expect(parseAll(['id: 5\nevent: x\n\n'])).toEqual([]);
    expect(parseAll(['id: 5\nevent: x\n\ndata: y\n\n'])).toEqual([{ event: 'message', data: 'y', id: null }]);
  });

  it('ignores retry and unknown fields, and an id holding NUL', () => {
    expect(parseAll(['retry: 1000\nfoo: bar\nid: a\0b\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x', id: null }]);
  });

  it('treats a field with no colon as an empty value', () => {
    expect(parseAll(['data\n\n'])).toEqual([{ event: 'message', data: '', id: null }]);
  });

  it('handles CRLF, CR and LF line endings, including a CRLF split between chunks', () => {
    expect(parseAll(['id: 1\r\ndata: a\r\n\r\n'])).toEqual([{ event: 'message', data: 'a', id: '1' }]);
    expect(parseAll(['id: 1\rdata: a\r\r'])).toEqual([{ event: 'message', data: 'a', id: '1' }]);
    expect(parseAll(['data: a\r', '\ndata: b\r\n', '\r', '\n'])).toEqual([{ event: 'message', data: 'a\nb', id: null }]);
  });

  it('strips a leading byte-order mark', () => {
    expect(parseAll(['﻿data: x\n\n'])).toEqual([{ event: 'message', data: 'x', id: null }]);
  });

  it('discards an unfinished frame at the end of the stream', () => {
    expect(parseAll(['data: x\n'])).toEqual([]);
  });

  it('tolerates empty chunks', () => {
    expect(parseAll(['', 'data: x\n', '', '\n', ''])).toEqual([{ event: 'message', data: 'x', id: null }]);
  });
});

describe('resync', () => {
  const resync = 'event: resync\ndata: {}\n\n';

  it('comes through as a frame with no id that isResync recognises', () => {
    const [f] = parseAll([resync]);
    expect(f).toEqual({ event: 'resync', data: '{}', id: null });
    expect(isResync(f!)).toBe(true);
  });

  it('is recognised when split mid-line, and after ordinary frames', () => {
    const frames = parseAll([wire, 'event: res', 'ync\nda', 'ta: {}\n\n']);
    expect(frames.map(isResync)).toEqual([false, true]);
    expect(frames[1]!.id).toBeNull();
  });

  it('is not claimed by ordinary events', () => {
    expect(isResync(frame7)).toBe(false);
    expect(isResync({ event: 'message', data: 'resync', id: null })).toBe(false);
  });
});
