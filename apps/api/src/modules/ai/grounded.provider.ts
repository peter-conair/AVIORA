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

    const copy = COPY[request.locale] ?? COPY.en!;
    const content = context.length
      ? [
          copy.found(question.trim()),
          '',
          ...context.map((c) => `• ${c}`),
          '',
          copy.disclaimer,
        ].join('\n')
      : [copy.missing(question.trim()), '', copy.tryAgain].join('\n');

    return {
      content,
      provider: this.name,
      model: this.model,
      inputTokens: estimateTokens(request.system + question),
      outputTokens: estimateTokens(content),
    };
  }
}

/**
 * The fallback provider composes its own wrapper text, so that text must exist
 * in every supported language — an English shell around Thai content reads as
 * broken even when the retrieved material is right.
 */
const COPY: Record<
  string,
  {
    found: (q: string) => string;
    missing: (q: string) => string;
    tryAgain: string;
    disclaimer: string;
  }
> = {
  en: {
    found: (q) => `Here is what the knowledge base says about "${q}":`,
    missing: (q) => `I could not find anything in this workspace's knowledge base about "${q}".`,
    tryAgain: 'Try a different wording, or ask your workspace admin to add material on this topic.',
    disclaimer:
      'This is general wellness information, not medical advice. Please speak with a qualified healthcare professional about your own situation.',
  },
  th: {
    found: (q) => `นี่คือสิ่งที่คลังความรู้ระบุไว้เกี่ยวกับ "${q}":`,
    missing: (q) => `ไม่พบข้อมูลเกี่ยวกับ "${q}" ในคลังความรู้ขององค์กรนี้`,
    tryAgain: 'ลองใช้คำอื่น หรือแจ้งผู้ดูแลองค์กรให้เพิ่มเนื้อหาเรื่องนี้',
    disclaimer:
      'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่คำแนะนำทางการแพทย์ กรุณาปรึกษาบุคลากรทางการแพทย์เกี่ยวกับกรณีของคุณ',
  },
};

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
