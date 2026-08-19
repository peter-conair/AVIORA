import { Injectable } from '@nestjs/common';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './provider.port';

/**
 * Deterministic fallback provider used when no model API key is configured
 * (local dev, CI, and any tenant that has not enabled a paid provider).
 *
 * It does not invent content: it answers strictly from the retrieved knowledge
 * that the gateway already placed in the system prompt, which keeps the health
 * safety rules (docs/12 §safety) trivially satisfiable and makes the assistant
 * testable without network access.
 */
@Injectable()
export class GroundedProvider implements AiProvider {
  readonly name = 'grounded-local';
  readonly model = 'extractive-v1';

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const question = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const context = extractContext(request.system);

    const content = context.length
      ? [
          `Here is what the knowledge base says about "${question.trim()}":`,
          '',
          ...context.map((c) => `• ${c}`),
          '',
          'This is general wellness information, not medical advice. Please speak with a qualified healthcare professional about your own situation.',
        ].join('\n')
      : [
          `I could not find anything in this workspace's knowledge base about "${question.trim()}".`,
          '',
          'Try a different wording, or ask your workspace admin to add material on this topic.',
        ].join('\n');

    return {
      content,
      provider: this.name,
      model: this.model,
      inputTokens: estimateTokens(request.system + question),
      outputTokens: estimateTokens(content),
    };
  }
}

/** The gateway marks retrieved passages with a "- " bullet under CONTEXT:. */
function extractContext(system: string): string[] {
  const idx = system.indexOf('CONTEXT:');
  if (idx === -1) return [];
  return system
    .slice(idx + 'CONTEXT:'.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2))
    .slice(0, 6);
}

/** Rough token estimate — good enough for quota accounting without a tokenizer. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
