import { afterEach, describe, expect, it } from 'vitest';
import { devLoginEnabled } from './dev-login';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

/**
 * The gate on a complete authentication bypass, so the cases are enumerated
 * rather than sampled: every combination that could plausibly occur in a real
 * environment, and the answer must be `false` in all but one of them.
 */
describe('devLoginEnabled', () => {
  const cases: Array<[nodeEnv: string | undefined, flag: string | undefined, expected: boolean]> = [
    ['development', 'true', true],
    ['test', 'true', true],
    [undefined, 'true', true],
    // Production refuses regardless of what the flag says — including the
    // deployment that inherits a developer's .env by accident, which is the
    // whole reason the second condition exists.
    ['production', 'true', false],
    ['production', undefined, false],
    // A flag that is present but not the word `true` is not consent. `1` and
    // `yes` read as agreement to a human and must not to this.
    ['development', undefined, false],
    ['development', '', false],
    ['development', '1', false],
    ['development', 'yes', false],
    ['development', 'TRUE', false],
  ];

  for (const [nodeEnv, flag, expected] of cases) {
    it(`is ${expected} when NODE_ENV=${nodeEnv ?? '(unset)'} and flag=${flag ?? '(unset)'}`, () => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (flag === undefined) delete process.env.AVIORA_DEV_LOGIN;
      else process.env.AVIORA_DEV_LOGIN = flag;

      expect(devLoginEnabled()).toBe(expected);
    });
  }
});
