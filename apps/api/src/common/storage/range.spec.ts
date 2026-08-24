import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from './range';

/** 48,000 bytes — indices 0…47,999. */
const TOTAL = 48_000;

describe('parseRangeHeader', () => {
  it('serves the whole object when nothing was asked for', () => {
    expect(parseRangeHeader(undefined, TOTAL)).toEqual({ kind: 'whole' });
    expect(parseRangeHeader('', TOTAL)).toEqual({ kind: 'whole' });
  });

  it('reads a closed range, with an inclusive end', () => {
    expect(parseRangeHeader('bytes=0-1023', TOTAL)).toEqual({
      kind: 'range',
      range: { start: 0, end: 1023 },
    });
  });

  it('runs an open range to the last byte', () => {
    // Safari opens a video with exactly this, and gets it wrong at the last
    // byte if `end` is treated as exclusive anywhere.
    expect(parseRangeHeader('bytes=0-', TOTAL)).toEqual({
      kind: 'range',
      range: { start: 0, end: TOTAL - 1 },
    });
  });

  it('reads a suffix range as the LAST n bytes', () => {
    expect(parseRangeHeader('bytes=-500', TOTAL)).toEqual({
      kind: 'range',
      range: { start: TOTAL - 500, end: TOTAL - 1 },
    });
  });

  it('treats a suffix longer than the object as the whole object', () => {
    expect(parseRangeHeader('bytes=-90000', TOTAL)).toEqual({
      kind: 'range',
      range: { start: 0, end: TOTAL - 1 },
    });
  });

  it('clamps an end past the end of the object rather than refusing it', () => {
    expect(parseRangeHeader('bytes=47000-99999', TOTAL)).toEqual({
      kind: 'range',
      range: { start: 47_000, end: TOTAL - 1 },
    });
  });

  it('refuses a start that is past the end', () => {
    expect(parseRangeHeader(`bytes=${TOTAL}-`, TOTAL)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=99999-100000', TOTAL)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuses a backwards range', () => {
    expect(parseRangeHeader('bytes=2000-1000', TOTAL)).toEqual({ kind: 'unsatisfiable' });
  });

  it('can satisfy no range against an empty object', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a malformed header rather than rejecting the request', () => {
    // RFC 9110: an unparsable Range MUST be ignored. It is also the kinder
    // answer — the player gets its video instead of a 416 it cannot handle.
    for (const bad of ['bytes=abc-def', 'items=0-10', 'bytes=', 'bytes=-', 'nonsense']) {
      expect(parseRangeHeader(bad, TOTAL), bad).toEqual({ kind: 'whole' });
    }
  });

  it('answers a multi-range request whole rather than half-implementing it', () => {
    expect(parseRangeHeader('bytes=0-99,200-299', TOTAL)).toEqual({ kind: 'whole' });
  });

  it('reads the last byte on its own', () => {
    expect(parseRangeHeader(`bytes=${TOTAL - 1}-${TOTAL - 1}`, TOTAL)).toEqual({
      kind: 'range',
      range: { start: TOTAL - 1, end: TOTAL - 1 },
    });
  });
});
