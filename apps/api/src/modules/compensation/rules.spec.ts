import { describe, expect, it } from 'vitest';
import {
  differentialAmount,
  payoutAmount,
  tierPercent,
  type DifferentialPayout,
  type DifferentialTier,
} from './rules';

/**
 * The differential payout (docs/69 §3, §5). Arithmetic only — no database, no
 * graph — because this is where a stairstep plan is either right or quietly
 * wrong by a few satang per line, and that question deserves an instrument
 * faster than a commission run.
 *
 * The ladder below is shaped like a real one and belongs to nobody: the rungs
 * are the tenant's numbers everywhere in this codebase, and these exist to be
 * arithmetic rather than to be a plan.
 */
const LADDER: DifferentialTier[] = [
  { atLeastMinor: 200_00, percent: 3 },
  { atLeastMinor: 600_00, percent: 6 },
  { atLeastMinor: 1_200_00, percent: 9 },
  { atLeastMinor: 2_400_00, percent: 12 },
  { atLeastMinor: 4_000_00, percent: 15 },
  { atLeastMinor: 7_000_00, percent: 18 },
  { atLeastMinor: 10_000_00, percent: 21 },
];

const ladderPayout = (over: Partial<DifferentialPayout> = {}): DifferentialPayout => ({
  kind: 'differential',
  tiers: LADDER,
  basis: 'downline_volume',
  basisWindow: 'period',
  basisGraph: 'compensation',
  basisParams: null,
  capMinor: null,
  ...over,
});

describe('tierPercent', () => {
  it('is zero below the first rung', () => {
    expect(tierPercent(LADDER, 0)).toBe(0);
    expect(tierPercent(LADDER, 199_99)).toBe(0);
  });

  it('reaches a rung at exactly its threshold', () => {
    expect(tierPercent(LADDER, 200_00)).toBe(3);
    expect(tierPercent(LADDER, 10_000_00)).toBe(21);
  });

  it('stays on the rung below until the next is reached', () => {
    expect(tierPercent(LADDER, 9_999_99)).toBe(18);
  });

  it('does not exceed the top rung', () => {
    expect(tierPercent(LADDER, 900_000_00)).toBe(21);
  });

  it('does not depend on the order the rungs are stored in', () => {
    const shuffled = [...LADDER].reverse();
    expect(tierPercent(shuffled, 5_000_00)).toBe(tierPercent(LADDER, 5_000_00));
  });
});

describe('differentialAmount', () => {
  it('pays the step between the member and each leg', () => {
    // Mara is at 10,000_00 → 21%. Two legs:
    //   nils  4,000_00 → 15%  →  21 − 15 =  6%  of 4,000_00 =   240_00
    //   orla  1,200_00 →  9%  →  21 −  9 = 12%  of 1,200_00 =   144_00
    //                                                total =   384_00
    const result = differentialAmount(ladderPayout(), 10_000_00, [
      { memberId: 'nils', volumeMinor: 4_000_00, basisMinor: 4_000_00 },
      { memberId: 'orla', volumeMinor: 1_200_00, basisMinor: 1_200_00 },
    ]);

    expect(result.ratePercent).toBe(21);
    expect(result.legs.map((l) => l.differentialPercent)).toEqual([6, 12]);
    expect(result.legs.map((l) => l.amountMinor)).toEqual([240_00, 144_00]);
    expect(result.amountMinor).toBe(384_00);
    expect(result.capApplied).toBe(false);
  });

  it('pays nothing on a leg that reached the top rung — breakaway, without a branch', () => {
    // Both at 21%: the step between them is flat, so the differential is nil.
    // Nothing in the code says the word "breakaway"; the subtraction says it.
    const result = differentialAmount(ladderPayout(), 12_000_00, [
      { memberId: 'gone', volumeMinor: 40_000_00, basisMinor: 11_000_00 },
      { memberId: 'here', volumeMinor: 600_00, basisMinor: 600_00 },
    ]);

    const gone = result.legs.find((l) => l.memberId === 'gone');
    expect(gone?.ratePercent).toBe(21);
    expect(gone?.differentialPercent).toBe(0);
    expect(gone?.amountMinor).toBe(0);
    // …and it is still reported, so the entry can answer "why nothing for that
    // line?" as well as "why this much?".
    expect(result.legs).toHaveLength(2);
    expect(result.amountMinor).toBe(90_00); // 21 − 6 = 15% of 600_00
  });

  it('never pays a negative when a leg is above the member', () => {
    const result = differentialAmount(ladderPayout(), 600_00, [
      { memberId: 'bigger', volumeMinor: 8_000_00, basisMinor: 8_000_00 },
    ]);

    expect(result.legs[0]?.ratePercent).toBe(18);
    expect(result.legs[0]?.differentialPercent).toBe(0);
    expect(result.amountMinor).toBe(0);
  });

  it('rounds per leg, so the printed lines add up to the printed total', () => {
    // 1% of 50 rounds to 1 twice → 2. Rounding the sum instead gives
    // round(100 × 1%) = 1, and an itemisation that does not add up.
    const oneStep: DifferentialTier[] = [
      { atLeastMinor: 0, percent: 3 },
      { atLeastMinor: 1_000_00, percent: 4 },
    ];
    const result = differentialAmount(ladderPayout({ tiers: oneStep }), 1_000_00, [
      { memberId: 'a', volumeMinor: 50, basisMinor: 0 },
      { memberId: 'b', volumeMinor: 50, basisMinor: 0 },
    ]);

    expect(result.legs.map((l) => l.amountMinor)).toEqual([1, 1]);
    expect(result.amountMinor).toBe(2);
    expect(result.legs.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(result.amountMinor);
  });

  it('caps the total and keeps what it would have been', () => {
    const result = differentialAmount(ladderPayout({ capMinor: 100_00 }), 10_000_00, [
      { memberId: 'nils', volumeMinor: 4_000_00, basisMinor: 4_000_00 },
    ]);

    expect(result.uncappedMinor).toBe(240_00);
    expect(result.amountMinor).toBe(100_00);
    expect(result.capApplied).toBe(true);
  });

  it('pays nothing to a member who reached no rung', () => {
    const result = differentialAmount(ladderPayout(), 100_00, [
      { memberId: 'nils', volumeMinor: 4_000_00, basisMinor: 4_000_00 },
    ]);

    expect(result.ratePercent).toBe(0);
    expect(result.amountMinor).toBe(0);
  });

  it('pays nothing when there are no legs', () => {
    const result = differentialAmount(ladderPayout(), 10_000_00, []);
    expect(result.amountMinor).toBe(0);
    expect(result.legs).toEqual([]);
  });
});

describe('payoutAmount', () => {
  it('refuses a differential rather than computing one from the payee alone', () => {
    expect(() => payoutAmount(ladderPayout(), 10_000_00)).toThrow(/differentialAmount/);
  });
});
