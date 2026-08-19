import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES, EVENTS } from '@aviora/shared';
import { appendEvent, type Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TeamActor } from '../team/team-scope.service';

export const CHALLENGE_SOURCES = ['habit', 'course', 'goal'] as const;

/**
 * The note that explains why the board looks the way it does. Like the health
 * safety note, it is member-facing text about privacy, so it ships in every
 * supported language rather than falling back to English.
 */
const PRIVACY_NOTE: Record<string, string> = {
  en: 'Only members who joined appear here, and only their progress count — never the underlying records.',
  th: 'แสดงเฉพาะสมาชิกที่เข้าร่วมเท่านั้น และแสดงเพียงจำนวนความคืบหน้า ไม่แสดงข้อมูลที่ใช้คำนวณ',
};
export type ChallengeSource = (typeof CHALLENGE_SOURCES)[number];

/**
 * Challenge engine (spec §37).
 *
 * Progress is DERIVED from data the platform already holds — habit logs,
 * learning progress, completed goals — so nothing is tracked twice and a
 * challenge can never disagree with the member's own records.
 *
 * Privacy: a habit-sourced challenge reads health data. Joining is therefore
 * the consent step, and only the derived count is ever shown to others — never
 * the underlying logs, and never for a member who has not joined (spec §59).
 */
@Injectable()
export class ChallengeService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  async create(input: {
    code: string;
    name: string;
    description?: string;
    source: ChallengeSource;
    sourceRef?: string;
    targetValue: number;
    startsOn: Date;
    endsOn: Date;
    communityId?: string;
  }) {
    const challenge = await this.db.tx(async (tx) => {
      const dup = await tx.challenge.findFirst({ where: { code: input.code } });
      if (dup) {
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: 'Challenge code already in use',
        });
      }
      if (input.endsOn < input.startsOn) {
        throw new ConflictException({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'A challenge cannot end before it starts',
        });
      }
      return tx.challenge.create({ data: { ...input, tenantId: this.db.tenantId } });
    });
    await this.audit.record({
      action: 'challenge.create',
      entityType: 'challenge',
      entityId: challenge.id,
      after: { code: challenge.code, source: challenge.source, target: challenge.targetValue },
    });
    return challenge;
  }

  list(actor: TeamActor) {
    const memberId = actor.memberId;
    return this.db.tx(async (tx) => {
      const challenges = await tx.challenge.findMany({
        where: { status: 'open' },
        orderBy: { endsOn: 'asc' },
      });
      const mine = memberId
        ? await tx.challengeParticipant.findMany({
            where: { memberId, leftAt: null },
            select: { challengeId: true, completedAt: true },
          })
        : [];
      const joined = new Map(mine.map((m) => [m.challengeId, m]));
      return challenges.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        description: c.description,
        source: c.source,
        sourceRef: c.sourceRef,
        targetValue: c.targetValue,
        startsOn: c.startsOn,
        endsOn: c.endsOn,
        joined: joined.has(c.id),
        completedAt: joined.get(c.id)?.completedAt ?? null,
      }));
    });
  }

  /** Joining is opt-in and is what allows a member's progress to be shown. */
  async join(challengeId: string, actor: TeamActor, actorUserId: string) {
    const memberId = this.requireMember(actor);
    const participant = await this.db.tx(async (tx) => {
      const challenge = await tx.challenge.findFirst({ where: { id: challengeId } });
      if (!challenge) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Challenge not found',
        });
      }
      const existing = await tx.challengeParticipant.findFirst({
        where: { challengeId, memberId },
      });
      const row = existing
        ? await tx.challengeParticipant.update({
            where: { id: existing.id },
            data: { leftAt: null },
          })
        : await tx.challengeParticipant.create({
            data: { tenantId: this.db.tenantId, challengeId, memberId },
          });
      await appendEvent(tx, {
        eventName: EVENTS.ChallengeJoined,
        tenantId: this.db.tenantId,
        aggregateType: 'challenge',
        aggregateId: challengeId,
        actorUserId,
        payload: { memberId, code: challenge.code },
      });
      return row;
    });
    await this.audit.record({
      action: 'challenge.join',
      entityType: 'challenge_participant',
      entityId: participant.id,
      after: { challengeId },
    });
    return participant;
  }

  /** Leaving stops sharing progress; the record of having joined is kept. */
  async leave(challengeId: string, actor: TeamActor) {
    const memberId = this.requireMember(actor);
    return this.db.tx(async (tx) => {
      const existing = await tx.challengeParticipant.findFirst({
        where: { challengeId, memberId, leftAt: null },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'You are not in this challenge',
        });
      }
      return tx.challengeParticipant.update({
        where: { id: existing.id },
        data: { leftAt: new Date() },
      });
    });
  }

  /**
   * Leaderboard over the members who joined. Non-participants are absent —
   * not zero-scored — because their data was never shared.
   */
  async leaderboard(challengeId: string, actor: TeamActor, locale = 'en') {
    return this.db.tx(async (tx) => {
      const challenge = await tx.challenge.findFirst({ where: { id: challengeId } });
      if (!challenge) {
        throw new NotFoundException({
          code: ERROR_CODES.NOT_FOUND,
          message: 'Challenge not found',
        });
      }
      const participants = await tx.challengeParticipant.findMany({
        where: { challengeId, leftAt: null },
        select: { memberId: true, joinedAt: true, completedAt: true },
      });
      const memberIds = participants.map((p) => p.memberId);
      const [members, progress] = await Promise.all([
        tx.member.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, displayName: true },
        }),
        this.progressFor(tx, challenge, memberIds),
      ]);
      const nameById = new Map(members.map((m) => [m.id, m.displayName]));

      const rows = participants
        .map((p) => ({
          memberId: p.memberId,
          displayName: nameById.get(p.memberId) ?? null,
          // only the derived count crosses the boundary, never the source rows
          progress: progress.get(p.memberId) ?? 0,
          completedAt: p.completedAt,
          isMe: p.memberId === actor.memberId,
        }))
        .sort((a, b) => b.progress - a.progress);

      return {
        challenge: {
          id: challenge.id,
          code: challenge.code,
          name: challenge.name,
          source: challenge.source,
          targetValue: challenge.targetValue,
          startsOn: challenge.startsOn,
          endsOn: challenge.endsOn,
        },
        participantCount: rows.length,
        leaderboard: rows,
        privacyNote: PRIVACY_NOTE[locale] ?? PRIVACY_NOTE.en!,
      };
    });
  }

  /**
   * Recomputes progress and marks completions. Returns the members who newly
   * reached the target so the caller can emit their events.
   */
  async settle(challengeId: string): Promise<Array<{ memberId: string; code: string }>> {
    return this.db.tx(async (tx) => {
      const challenge = await tx.challenge.findFirst({ where: { id: challengeId } });
      if (!challenge) return [];
      const participants = await tx.challengeParticipant.findMany({
        where: { challengeId, leftAt: null, completedAt: null },
        select: { id: true, memberId: true },
      });
      if (participants.length === 0) return [];
      const progress = await this.progressFor(
        tx,
        challenge,
        participants.map((p) => p.memberId),
      );
      const completed: Array<{ memberId: string; code: string }> = [];
      for (const p of participants) {
        if ((progress.get(p.memberId) ?? 0) >= challenge.targetValue) {
          await tx.challengeParticipant.update({
            where: { id: p.id },
            data: { completedAt: new Date() },
          });
          await appendEvent(tx, {
            eventName: EVENTS.ChallengeCompleted,
            tenantId: this.db.tenantId,
            aggregateType: 'challenge',
            aggregateId: challengeId,
            actorUserId: null,
            payload: { memberId: p.memberId, code: challenge.code },
          });
          completed.push({ memberId: p.memberId, code: challenge.code });
        }
      }
      return completed;
    });
  }

  /** Progress per member, derived from the source domain. */
  private async progressFor(
    tx: Tx,
    challenge: { source: string; sourceRef: string | null; startsOn: Date; endsOn: Date },
    memberIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (memberIds.length === 0) return result;

    if (challenge.source === 'habit') {
      const habits = await tx.habit.findMany({
        where: { memberId: { in: memberIds }, code: challenge.sourceRef ?? '' },
        select: { id: true, memberId: true },
      });
      if (habits.length === 0) return result;
      const logs = await tx.habitLog.findMany({
        where: {
          habitId: { in: habits.map((h) => h.id) },
          completed: true,
          logDate: { gte: challenge.startsOn, lte: challenge.endsOn },
        },
        select: { memberId: true, logDate: true },
      });
      const days = new Map<string, Set<string>>();
      for (const log of logs) {
        const set = days.get(log.memberId) ?? new Set<string>();
        set.add(log.logDate.toISOString().slice(0, 10));
        days.set(log.memberId, set);
      }
      for (const [memberId, set] of days) result.set(memberId, set.size);
      return result;
    }

    if (challenge.source === 'course') {
      const rows = await tx.learningProgress.findMany({
        where: {
          memberId: { in: memberIds },
          status: 'completed',
          ...(challenge.sourceRef ? { courseId: challenge.sourceRef } : {}),
        },
        select: { memberId: true },
      });
      for (const r of rows) result.set(r.memberId, (result.get(r.memberId) ?? 0) + 1);
      return result;
    }

    // goal
    const rows = await tx.goal.findMany({
      where: { memberId: { in: memberIds }, status: 'completed' },
      select: { memberId: true },
    });
    for (const r of rows) result.set(r.memberId, (result.get(r.memberId) ?? 0) + 1);
    return result;
  }
}
