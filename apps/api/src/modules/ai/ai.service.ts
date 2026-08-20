import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { TenantDb } from '../../common/db/tenant-db.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { AnthropicProvider } from './anthropic.provider';
import { GroundedProvider } from './grounded.provider';
import { CONTEXT_MARKER, type AiProvider, type AiPurpose } from './provider.port';

const MAX_OUTPUT_TOKENS = 700;
const HISTORY_TURNS = 10;

/** Daily per-member request cap; tenants may lower it via tenant settings. */
const DEFAULT_DAILY_REQUEST_CAP = 50;

/**
 * Health-safety and scope rules the assistant must obey (docs/12 §safety,
 * spec §27/§50). Retrieval happens BEFORE the model call and only over
 * knowledge the caller's tenant can already read, so the model never sees
 * material the member is not authorised for.
 */
const SYSTEM_RULES = [
  'You are the AVIORA assistant for a membership and healthy-living community.',
  'Answer ONLY from the CONTEXT below. If the context does not cover the question, say so plainly and suggest asking a workspace admin — never invent facts, studies, or product claims.',
  'You are not a clinician. Never diagnose, never claim a product treats, cures, or prevents any disease, and never tell someone to start, stop, or change a medication.',
  'When a question touches health, include a short reminder that this is general wellness information and that a qualified healthcare professional should be consulted.',
  'Present products neutrally: mention them only after the underlying knowledge, and never rank one brand above another.',
  'Reply in the language named by REPLY_LANGUAGE below.',
].join(' ');

/**
 * The AI Team Coach (docs/28 §4, spec §49). The CALLER retrieved the numbers
 * under its own authorization, so this prompt adds no retrieval and forbids
 * arithmetic the leader cannot check: an AI answer a leader cannot verify is
 * an answer they should not act on.
 */
const COACH_RULES = [
  'You are the AVIORA team coach, speaking to a team leader about the teams they lead.',
  'Answer ONLY from the measures listed under CONTEXT below. Quote the exact numbers you used, with the team or member they belong to.',
  'Never estimate, extrapolate, project, or claim a cause. If the measures do not answer the question, say which measure is missing.',
  'Name measures that fell, never judgements about a person. Do not score, rank or predict people.',
  'Say nothing about anyone’s health: none is provided, and none may be inferred.',
  'Be brief — a few sentences, then what the leader could do next.',
  'Reply in the language named by REPLY_LANGUAGE below.',
].join(' ');

/**
 * What an answer cites, so the reader can check it against the dashboard.
 * A type alias, not an interface: it is persisted to a Prisma Json column,
 * which only accepts shapes carrying an implicit index signature.
 */
export type AiCitation = { kind: string; code: string; title: string };

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly knowledge: KnowledgeService,
    private readonly anthropic: AnthropicProvider,
    private readonly grounded: GroundedProvider,
  ) {}

  /** Model router (docs/12): a configured provider, else the local fallback. */
  private provider(): AiProvider {
    return AnthropicProvider.isConfigured() ? this.anthropic : this.grounded;
  }

  private requireMember(memberId: string | null): string {
    if (!memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return memberId;
  }

  conversations(memberId: string | null) {
    const id = this.requireMember(memberId);
    return this.db.tx((tx) =>
      tx.aiConversation.findMany({
        where: { memberId: id },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: { id: true, title: true, agent: true, createdAt: true, updatedAt: true },
      }),
    );
  }

  async conversation(id: string, memberId: string | null) {
    const owner = this.requireMember(memberId);
    return this.db.tx(async (tx) => {
      const conversation = await tx.aiConversation.findFirst({
        where: { id, memberId: owner },
        select: {
          id: true,
          title: true,
          agent: true,
          createdAt: true,
          messages: {
            orderBy: { ordinal: 'asc' },
            select: { id: true, role: true, content: true, citations: true, createdAt: true },
          },
        },
      });
      if (!conversation) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Conversation not found',
        });
      }
      return conversation;
    });
  }

  /** Today's usage for the caller plus the applicable cap. */
  async usage(memberId: string | null) {
    const id = this.requireMember(memberId);
    const cap = await this.dailyCap();
    const row = await this.db.tx((tx) =>
      tx.aiUsage.findFirst({ where: { memberId: id, usageDate: today() } }),
    );
    return {
      date: today().toISOString().slice(0, 10),
      requests: row?.requests ?? 0,
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      dailyRequestCap: cap,
      remaining: Math.max(0, cap - (row?.requests ?? 0)),
      provider: this.provider().name,
    };
  }

  /**
   * Ask the assistant. Order matters (docs/12 §context assembly):
   * quota check → authorised retrieval → prompt assembly → provider call →
   * persist messages + usage.
   */
  async ask(
    memberId: string | null,
    input: { question: string; conversationId?: string; locale?: string },
  ) {
    const owner = this.requireMember(memberId);
    const { cap, used } = await this.assertQuota(owner);

    // Retrieval runs through the tenant-scoped knowledge service, so RLS has
    // already excluded anything this tenant may not read.
    // retrieval in the member's own language — the knowledge base stores every
    // locale's text in one searchable column
    const locale = input.locale ?? 'en';
    const found = await this.knowledge.search(input.question, locale);
    const context = [
      ...found.knowledge.slice(0, 6).map((k) => `${k.title}: ${k.summary ?? ''}`.trim()),
      ...found.products
        .slice(0, 3)
        .map((p) => `${p.name} (${p.brand.name}): ${p.description ?? ''}`.trim()),
    ];
    const citations = found.knowledge.slice(0, 6).map((k) => ({
      kind: k.kind,
      code: k.code,
      title: k.title,
    }));

    const system = [
      SYSTEM_RULES,
      '',
      `REPLY_LANGUAGE: ${locale === 'th' ? 'Thai' : 'English'}`,
      '',
      CONTEXT_MARKER,
      ...context.map((c) => `- ${c}`),
    ].join('\n');

    return await this.runTurn(owner, {
      question: input.question,
      conversationId: input.conversationId,
      system,
      citations,
      locale,
      cap,
      used,
    });
  }

  /**
   * Answer from facts the CALLER already retrieved under its own authorization
   * (spec §50). Nothing here reads a domain table: the AI Team Coach hands in
   * numbers it obtained from the scoped analytics service, so there is no code
   * path by which the model sees a team the caller could not (docs/28 §4).
   *
   * It shares this gateway's quota, provider routing, persistence and
   * citations with `ask` — a second AI path would be a second set of limits.
   */
  async answerGrounded(
    memberId: string | null,
    input: {
      question: string;
      /** One line per number, already scoped and already authorised. */
      facts: string[];
      citations: AiCitation[];
      locale?: string;
      agent?: string;
      conversationId?: string;
    },
  ) {
    const owner = this.requireMember(memberId);
    const { cap, used } = await this.assertQuota(owner);
    const locale = input.locale ?? 'en';
    const system = [
      COACH_RULES,
      '',
      `REPLY_LANGUAGE: ${locale === 'th' ? 'Thai' : 'English'}`,
      '',
      CONTEXT_MARKER,
      ...input.facts.map((f) => `- ${f}`),
    ].join('\n');

    return await this.runTurn(owner, {
      question: input.question,
      conversationId: input.conversationId,
      agent: input.agent,
      system,
      citations: input.citations,
      locale,
      purpose: 'measures',
      cap,
      used,
    });
  }

  /** Quota first, always: retrieval a rate-limited caller cannot use is waste. */
  private async assertQuota(memberId: string) {
    const cap = await this.dailyCap();
    const used = await this.db.tx((tx) =>
      tx.aiUsage.findFirst({ where: { memberId, usageDate: today() } }),
    );
    if ((used?.requests ?? 0) >= cap) {
      throw new ForbiddenException({
        code: ERROR_CODES.RATE_LIMITED,
        message: `Daily AI limit reached (${cap} requests). It resets tomorrow.`,
      });
    }
    return { cap, used };
  }

  /** One turn: history → provider → persist messages and usage. */
  private async runTurn(
    owner: string,
    input: {
      question: string;
      system: string;
      citations: AiCitation[];
      locale: string;
      cap: number;
      used: { requests: number } | null;
      conversationId?: string;
      agent?: string;
      purpose?: AiPurpose;
    },
  ) {
    const { system, citations, locale, cap, used } = input;
    const conversationId = await this.ensureConversation(owner, input);
    const history = await this.db.tx((tx) =>
      tx.aiMessage.findMany({
        where: { conversationId },
        orderBy: { ordinal: 'desc' },
        take: HISTORY_TURNS,
        select: { role: true, content: true },
      }),
    );
    const messages = [
      ...history
        .reverse()
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: input.question },
    ];

    const provider = this.provider();
    const result = await provider.complete({
      system,
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      locale,
      purpose: input.purpose ?? 'knowledge',
    });

    await this.db.tx(async (tx) => {
      // Both rows land in one transaction and therefore share created_at, so
      // the turn's order is stated explicitly rather than inferred from time.
      const last = await tx.aiMessage.findFirst({
        where: { conversationId },
        orderBy: { ordinal: 'desc' },
        select: { ordinal: true },
      });
      const nextOrdinal = (last?.ordinal ?? 0) + 1;
      await tx.aiMessage.create({
        data: {
          tenantId: this.db.tenantId,
          conversationId,
          role: 'user',
          content: input.question,
          ordinal: nextOrdinal,
        },
      });
      await tx.aiMessage.create({
        data: {
          tenantId: this.db.tenantId,
          conversationId,
          role: 'assistant',
          content: result.content,
          citations,
          ordinal: nextOrdinal + 1,
        },
      });
      await tx.aiConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      await tx.aiUsage.upsert({
        where: {
          tenantId_memberId_usageDate: {
            tenantId: this.db.tenantId,
            memberId: owner,
            usageDate: today(),
          },
        },
        create: {
          tenantId: this.db.tenantId,
          memberId: owner,
          usageDate: today(),
          provider: result.provider,
          model: result.model,
          requests: 1,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
        update: {
          requests: { increment: 1 },
          inputTokens: { increment: result.inputTokens },
          outputTokens: { increment: result.outputTokens },
        },
      });
    });

    return {
      conversationId,
      answer: result.content,
      citations,
      provider: result.provider,
      model: result.model,
      remaining: Math.max(0, cap - ((used?.requests ?? 0) + 1)),
    };
  }

  private async ensureConversation(
    memberId: string,
    input: { question: string; conversationId?: string; agent?: string },
  ): Promise<string> {
    return this.db.tx(async (tx) => {
      if (input.conversationId) {
        const existing = await tx.aiConversation.findFirst({
          where: { id: input.conversationId, memberId },
          select: { id: true },
        });
        if (!existing) {
          throw new NotFoundException({
            code: ERROR_CODES.NOT_FOUND,
            message: 'Conversation not found',
          });
        }
        return existing.id;
      }
      const created = await tx.aiConversation.create({
        data: {
          tenantId: this.db.tenantId,
          memberId,
          title: input.question.slice(0, 80),
          ...(input.agent ? { agent: input.agent } : {}),
        },
        select: { id: true },
      });
      return created.id;
    });
  }

  /** Tenant setting `ai.dailyRequestCap` overrides the platform default. */
  private async dailyCap(): Promise<number> {
    const setting = await this.db.tx((tx) =>
      tx.tenantSetting.findFirst({ where: { key: 'ai.dailyRequestCap' } }),
    );
    const value = Number(setting?.value);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAILY_REQUEST_CAP;
  }
}

/** Today at UTC midnight — matches the `date` column used for daily quotas. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
