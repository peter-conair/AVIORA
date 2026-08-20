import { describe, expect, it } from 'vitest';
import { describeTransportFailure } from './webhook.dispatcher';

describe('a delivery error names the actual failure', () => {
  it('unwraps what fetch hid in `cause`', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND hooks.example'), {
      code: 'ENOTFOUND',
    });
    const outer = Object.assign(new TypeError('fetch failed'), { cause });
    const described = describeTransportFailure(outer);
    expect(described).toContain('fetch failed');
    expect(described).toContain('ENOTFOUND');
    expect(described).toContain('hooks.example');
  });

  it('does not loop for ever on a self-referential cause', () => {
    const e = new Error('round');
    (e as { cause?: unknown }).cause = e;
    expect(describeTransportFailure(e)).toBe('round');
  });

  it('survives something that is not an Error at all', () => {
    expect(describeTransportFailure('plain string')).toBe('plain string');
  });
});
