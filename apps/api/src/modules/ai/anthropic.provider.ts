import { Injectable, Logger } from '@nestjs/common';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './provider.port';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Anthropic adapter (docs/12 ADR-009). Uses fetch directly rather than the SDK
 * so the provider boundary stays a single small file; swapping models is config.
 */
@Injectable()
export class AnthropicProvider implements AiProvider {
  private readonly logger = new Logger(AnthropicProvider.name);
  readonly name = 'anthropic';
  readonly model = process.env.AVIORA_AI_MODEL ?? 'claude-sonnet-5';

  static isConfigured(): boolean {
    return !!process.env.AVIORA_AI_ANTHROPIC_KEY;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const apiKey = process.env.AVIORA_AI_ANTHROPIC_KEY;
    if (!apiKey) throw new Error('AVIORA_AI_ANTHROPIC_KEY is not configured');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: request.messages,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      this.logger.error(`anthropic ${res.status}: ${detail.slice(0, 300)}`);
      throw new Error(`AI provider returned ${res.status}`);
    }

    const body = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content = body.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
      .trim();

    return {
      content,
      provider: this.name,
      model: this.model,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  }
}
