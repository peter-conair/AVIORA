/**
 * Provider-agnostic AI port (docs/12 §gateway). Domain code depends on this
 * interface only — never on a vendor SDK — so swapping or adding a provider is
 * an infrastructure change.
 */
/**
 * What the retrieved lines under `CONTEXT_MARKER` are. A model provider needs
 * no such hint, but the local fallback composes its own wrapper text, and
 * "here is what the knowledge base says" is the wrong sentence to wrap a set
 * of team measures in — as is a health disclaimer on a growth number.
 */
export type AiPurpose = 'knowledge' | 'measures';

/** Where the gateway puts retrieved lines in the system prompt, one per `- `. */
export const CONTEXT_MARKER = 'CONTEXT:';

export interface AiCompletionRequest {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
  /** The member's UI language; providers answer in it. */
  locale: string;
  purpose?: AiPurpose;
}

export interface AiCompletionResult {
  content: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}
