/**
 * The `Range` request header, parsed (docs/73 §7).
 *
 * Pure, and tested as such, because the failure it guards is not an exception —
 * it is an off-by-one that serves a video one byte short and leaves a player
 * spinning with no error anywhere to read.
 */
export interface ByteRange {
  start: number;
  /** INCLUSIVE, as HTTP means it. */
  end: number;
}

export type RangeRequest =
  /** No range asked for, or one malformed enough to ignore — serve the whole object. */
  | { kind: 'whole' }
  | { kind: 'range'; range: ByteRange }
  /** Asked for bytes that are not there. The answer is 416, not a short read. */
  | { kind: 'unsatisfiable' };

const SINGLE = /^bytes=(\d*)-(\d*)$/;

/**
 * RFC 9110 §14.1, narrowed to what a media player actually sends.
 *
 * **A malformed range is ignored, not rejected.** The RFC says a recipient that
 * cannot parse a Range header MUST ignore it, and that is also the kinder
 * behaviour: a player that sends something odd gets its video rather than a
 * 416 it has no code path for.
 *
 * Multi-range requests (`bytes=0-99,200-299`) are answered whole for the same
 * reason. They would need a multipart/byteranges body, no media player asks for
 * one, and half-implementing it is worse than not offering it.
 */
export function parseRangeHeader(header: string | undefined, totalLength: number): RangeRequest {
  if (!header) return { kind: 'whole' };
  const match = SINGLE.exec(header.trim());
  if (!match) return { kind: 'whole' };

  const [, rawStart, rawEnd] = match;
  // `bytes=-` names neither end and is meaningless.
  if (rawStart === '' && rawEnd === '') return { kind: 'whole' };

  // An empty object can satisfy no range at all, and the arithmetic below would
  // produce -1s if allowed through.
  if (totalLength <= 0) return { kind: 'unsatisfiable' };

  if (rawStart === '') {
    // Suffix: `bytes=-500` is the LAST 500 bytes, not the first 500. Asking for
    // more than exists is legal and means the whole object.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return { kind: 'unsatisfiable' };
    return {
      kind: 'range',
      range: { start: Math.max(0, totalLength - suffix), end: totalLength - 1 },
    };
  }

  const start = Number(rawStart);
  if (start >= totalLength) return { kind: 'unsatisfiable' };
  // An open end (`bytes=1024-`) runs to the last byte. A stated end past the
  // end of the object is clamped rather than refused — that is what the RFC
  // requires, and Safari relies on it when it opens with `bytes=0-`.
  const end = rawEnd === '' ? totalLength - 1 : Math.min(Number(rawEnd), totalLength - 1);
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', range: { start, end } };
}
