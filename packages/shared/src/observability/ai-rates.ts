/**
 * What the platform pays a provider, per million tokens, in minor units of
 * `AI_RATE_CURRENCY` (docs/36 §5).
 *
 * A constant rather than a table on purpose: this is a PLATFORM fact — no
 * tenant has their own price for the same model — and a price living in the
 * database is a number anybody can change with no review.
 *
 * Rates taken 2026-08-21 from each provider's published price list. When a
 * provider changes a price, this file changes and the change is reviewed like
 * any other. `takenOn` travels with the number so a cost report can say how
 * old the rate behind it is.
 */
export const AI_RATE_CURRENCY = 'USD';

export interface AiRate {
  readonly provider: string;
  readonly model: string;
  /** Minor units (cents) per 1,000,000 input tokens. */
  readonly inputMinorPerMillion: number;
  /** Minor units (cents) per 1,000,000 output tokens. */
  readonly outputMinorPerMillion: number;
  readonly takenOn: string;
}

export const AI_RATE_CARD: readonly AiRate[] = [
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    inputMinorPerMillion: 300,
    outputMinorPerMillion: 1500,
    takenOn: '2026-08-21',
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    inputMinorPerMillion: 100,
    outputMinorPerMillion: 500,
    takenOn: '2026-08-21',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-5',
    inputMinorPerMillion: 1500,
    outputMinorPerMillion: 7500,
    takenOn: '2026-08-21',
  },
  // The local fallback provider calls nobody, so it costs nothing. Zero here is
  // a measurement, not a missing rate — the one place a 0 is the honest answer.
  // The names are the ones the provider actually records in `ai_usage`; a rate
  // card that prices a model nobody runs prices nothing.
  {
    provider: 'grounded-local',
    model: 'extractive-v1',
    inputMinorPerMillion: 0,
    outputMinorPerMillion: 0,
    takenOn: '2026-08-21',
  },
];

export function findAiRate(provider: string, model: string): AiRate | null {
  return (
    AI_RATE_CARD.find((r) => r.provider === provider && r.model === model) ??
    // A provider that versions its model names ("claude-sonnet-5-20260101")
    // should still cost what that model costs.
    AI_RATE_CARD.find((r) => r.provider === provider && model.startsWith(r.model)) ??
    null
  );
}

export interface AiCost {
  /** Null when no rate is configured — never 0. See docs/36 §5. */
  readonly costMinor: number | null;
  readonly currency: string;
  readonly note?: string;
  readonly rateTakenOn?: string;
}

/**
 * Tokens times the rate, rounded once at the end.
 *
 * An unknown model costs `null` and says so. Zero is a number an operator will
 * budget against; null is a question they will answer.
 */
export function estimateAiCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): AiCost {
  const rate = findAiRate(provider, model);
  if (!rate) {
    return {
      costMinor: null,
      currency: AI_RATE_CURRENCY,
      note: `no rate configured for ${provider}/${model}`,
    };
  }
  const minor =
    (inputTokens * rate.inputMinorPerMillion + outputTokens * rate.outputMinorPerMillion) /
    1_000_000;
  return {
    costMinor: Math.round(minor),
    currency: AI_RATE_CURRENCY,
    rateTakenOn: rate.takenOn,
  };
}
