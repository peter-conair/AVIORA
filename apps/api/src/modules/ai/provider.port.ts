/**
 * Provider-agnostic AI port (docs/12 §gateway). Domain code depends on this
 * interface only — never on a vendor SDK — so swapping or adding a provider is
 * an infrastructure change.
 */
export interface AiCompletionRequest {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
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
