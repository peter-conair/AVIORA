import { BadRequestException, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@aviora/shared';
import { AiService, type AiCitation } from '../ai/ai.service';
import type { TeamActor } from '../team/team-scope.service';
import {
  AnalyticsService,
  type Milestone,
  type NamedMember,
  type TeamAnalytics,
  type TeamScopeAnalytics,
} from './analytics.service';
import type { CourseMeasure } from './measures';
import type { AnalyticsWindow } from './window';

/** The eight questions of spec §49, as docs/28 §4 maps them to measures. */
export const COACH_QUESTIONS = [
  'fastest_growing_team',
  'team_needs_support',
  'leader_needs_coaching',
  'inactive_member',
  'close_to_milestone',
  'next_course',
  'team_focus',
  'growth_correlation',
] as const;
export type CoachQuestion = (typeof COACH_QUESTIONS)[number];

/** Verbatim from docs/28 §4 — the wording a caller may send. */
const QUESTION_TEXT: Record<CoachQuestion, string> = {
  fastest_growing_team: 'Which team is growing fastest?',
  team_needs_support: 'Which team needs support?',
  leader_needs_coaching: 'Which leader needs coaching?',
  inactive_member: 'Which member is inactive?',
  close_to_milestone: 'Who is close to the next milestone?',
  next_course: 'Which course should the team take next?',
  team_focus: 'What should this team focus on?',
  growth_correlation: 'What activities correlate with growth?',
};

const BY_NORMALISED = new Map<string, CoachQuestion>([
  ...COACH_QUESTIONS.map((code) => [normalise(code), code] as const),
  ...COACH_QUESTIONS.map((code) => [normalise(QUESTION_TEXT[code]), code] as const),
]);

/**
 * §5 types the body as `{ question }` and §4 lists the eight as English
 * sentences, so a sentence is what a caller sends. The code is accepted too —
 * it is the same eight, and a client that already has one should not have to
 * reconstruct the prose to ask.
 *
 * Free-form questions are refused rather than guessed at: the eight are the
 * questions this module can answer from measures it computes, and answering a
 * ninth would mean inventing the measure behind it.
 */
export function coachQuestionFrom(question: string): CoachQuestion | null {
  return BY_NORMALISED.get(normalise(question)) ?? null;
}

export function coachQuestionList(): string[] {
  return COACH_QUESTIONS.map((code) => QUESTION_TEXT[code]);
}

/** Punctuation, case and spacing are not part of the question. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** How many people or teams a single answer names. Longer is not more useful. */
const LIST_LIMIT = 5;

/**
 * The AI Team Coach (docs/28 §4, spec §49).
 *
 * It has NO database access — its only collaborators are the scoped analytics
 * service and the AI gateway. Authorization therefore happens before retrieval
 * (spec §50): it calls the same `analytics.team(actor, window)` the leader
 * dashboard calls, with the same actor, so there is no code path by which it
 * can see a team the leader cannot, and nothing to filter afterwards.
 */
@Injectable()
export class CoachService {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly ai: AiService,
  ) {}

  async askTeam(
    actor: TeamActor,
    input: { question: string; window: AnalyticsWindow; locale?: string },
  ) {
    const question = coachQuestionFrom(input.question);
    if (!question) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'The coach answers these questions only',
        details: { questions: coachQuestionList() },
      });
    }
    const scoped = await this.analytics.team(actor, input.window);
    const finding = findings[question](scoped);
    const envelope = {
      question,
      questionText: QUESTION_TEXT[question],
      window: scoped.window,
      definitions: scoped.definitions,
      teamsInScope: scoped.teams.length,
      facts: finding.facts,
      citations: finding.citations,
      data: finding.data,
    };

    // docs/28 §6: the correlation question is refused, not modelled. Asking a
    // model to decline invites it to hedge its way into an answer, and the
    // refusal is the point — so it never reaches the gateway, and never costs
    // the leader a request from their daily quota.
    if (finding.refusal) {
      return {
        ...envelope,
        answer: finding.refusal,
        answeredBy: 'policy' as const,
        provider: null,
        model: null,
      };
    }

    const result = await this.ai.answerGrounded(actor.memberId, {
      question: QUESTION_TEXT[question],
      facts: finding.facts,
      citations: finding.citations,
      locale: input.locale,
      agent: 'team-coach',
    });
    return {
      ...envelope,
      answer: result.answer,
      answeredBy: 'model' as const,
      provider: result.provider,
      model: result.model,
      conversationId: result.conversationId,
      remaining: result.remaining,
    };
  }
}

interface Finding {
  facts: string[];
  citations: AiCitation[];
  data: unknown;
  /** Set only where docs/28 §6 refuses to guess. */
  refusal?: string;
}

/**
 * One builder per question. Each reads the scoped analytics and produces the
 * numbers the answer is allowed to use — the coach's answer names the numbers
 * it used, because an AI answer a leader cannot check is an answer they should
 * not act on (docs/28 §4).
 */
const findings: Record<CoachQuestion, (scoped: TeamScopeAnalytics) => Finding> = {
  fastest_growing_team(scoped) {
    const ranked = [...scoped.teams].sort(
      (a, b) =>
        b.measures.growth - a.measures.growth ||
        (b.measures.growthRate ?? 0) - (a.measures.growthRate ?? 0),
    );
    return {
      facts: ranked.length
        ? ranked
            .slice(0, LIST_LIMIT)
            .map(
              (t) =>
                `${t.team.name}: growth ${signed(t.measures.growth)} active members ` +
                `(${t.measures.activeMembers} now vs ${t.measures.previousActiveMembers} in the previous window).`,
            )
        : ['No team is in scope for this leader.'],
      citations: ranked.slice(0, LIST_LIMIT).map((t) => cite('growth', t)),
      data: ranked.map((t) => ({
        team: t.team,
        growth: t.measures.growth,
        activeMembers: t.measures.activeMembers,
        previousActiveMembers: t.measures.previousActiveMembers,
      })),
    };
  },

  team_needs_support(scoped) {
    const ranked = [...scoped.teams].sort(
      (a, b) =>
        a.measures.growth - b.measures.growth ||
        (a.measures.activeShare ?? 1) - (b.measures.activeShare ?? 1),
    );
    return {
      facts: ranked.length
        ? ranked
            .slice(0, LIST_LIMIT)
            .map(
              (t) =>
                `${t.team.name}: growth ${signed(t.measures.growth)} active members, ` +
                `${t.measures.activeMembers} of ${t.measures.totalMembers} members active ` +
                `(${percent(t.measures.activeShare)}).`,
            )
        : ['No team is in scope for this leader.'],
      citations: ranked.slice(0, LIST_LIMIT).map((t) => cite('growth', t)),
      data: ranked.map((t) => ({
        team: t.team,
        growth: t.measures.growth,
        activeMembers: t.measures.activeMembers,
        totalMembers: t.measures.totalMembers,
        activeShare: t.measures.activeShare,
      })),
    };
  },

  leader_needs_coaching(scoped) {
    // A measure that fell, never a judgement about a person (docs/28 §6). Every
    // team's figures are stated either way: "nothing fell" is only checkable if
    // the numbers it is claiming about are in the answer too.
    const fell = scoped.teams
      .filter((t) => (t.measures.engagementChange ?? 0) < 0)
      .sort((a, b) => (a.measures.engagementChange ?? 0) - (b.measures.engagementChange ?? 0));
    const line = (t: TeamAnalytics) =>
      `${t.team.name} (led by ${names(t.leaders)}): engagement per active member ` +
      `${round(t.measures.engagementPerActiveMember)}, previously ` +
      `${round(t.measures.previousEngagementPerActiveMember)}; ` +
      `${t.measures.activeMembers} of ${t.measures.totalMembers} members active.`;
    return {
      facts: [
        fell.length
          ? `Engagement per active member fell in ${fell.length} of ${scoped.teams.length} teams in scope.`
          : `Engagement per active member fell in 0 of ${scoped.teams.length} teams in scope.`,
        ...(fell.length ? fell : scoped.teams).slice(0, LIST_LIMIT).map(line),
      ],
      citations: (fell.length ? fell : scoped.teams)
        .slice(0, LIST_LIMIT)
        .map((t) => cite('engagement', t)),
      data: (fell.length ? fell : scoped.teams).map((t) => ({
        team: t.team,
        leaders: t.leaders,
        engagementPerActiveMember: t.measures.engagementPerActiveMember,
        previousEngagementPerActiveMember: t.measures.previousEngagementPerActiveMember,
        engagementChange: t.measures.engagementChange,
      })),
    };
  },

  inactive_member(scoped) {
    const rows = scoped.teams.flatMap((t) =>
      t.inactiveMembers.map((m) => ({ team: t.team, ...m })),
    );
    return {
      facts: rows.length
        ? [
            `${rows.length} members recorded no action in the window.`,
            ...rows
              .slice(0, LIST_LIMIT)
              .map((r) => `${r.displayName} (${r.team.name}) recorded no action.`),
          ]
        : ['Every member in scope recorded at least one action in the window.'],
      citations: rows.slice(0, LIST_LIMIT).map((r) => ({
        kind: 'measure',
        code: 'members.inactive',
        title: `${r.displayName} — ${r.team.name}`,
      })),
      data: rows,
    };
  },

  close_to_milestone(scoped) {
    const ranked = allMilestones(scoped)
      .filter((m) => m.nextRank && m.largestGapShare !== null)
      .sort((a, b) => (a.largestGapShare ?? 1) - (b.largestGapShare ?? 1))
      .slice(0, LIST_LIMIT);
    return {
      facts: ranked.length
        ? ranked.map(
            (m) =>
              `${m.displayName} is ${m.missing.length ? m.missing.map(gap).join(' and ') : 'already meeting every requirement'} ` +
              `short of ${m.nextRank?.name} (amounts in ${m.currency} minor units).`,
          )
        : ['No rank ladder is configured, or no member in scope has been evaluated against one.'],
      citations: ranked.map((m) => ({
        kind: 'measure',
        code: 'rank.progress',
        title: `${m.displayName} → ${m.nextRank?.name ?? 'no next rank'}`,
      })),
      data: ranked,
    };
  },

  next_course(scoped) {
    const ranked = [...scoped.measures.courses].sort(
      (a, b) =>
        a.completedAllTime - b.completedAllTime || a.completedInWindow - b.completedInWindow,
    );
    return {
      facts: ranked.length
        ? ranked
            .slice(0, LIST_LIMIT)
            .map(
              (c) =>
                `${c.title}: ${c.completedAllTime} completions in total, ` +
                `${c.completedInWindow} in the window, ${c.inProgress} in progress.`,
            )
        : ['This tenant has published no courses.'],
      citations: ranked.slice(0, LIST_LIMIT).map((c: CourseMeasure) => ({
        kind: 'measure',
        code: 'learning.completions',
        title: `${c.title} — ${c.completedAllTime} completions`,
      })),
      data: ranked,
    };
  },

  team_focus(scoped) {
    const ranked = concerns(scoped).sort((a, b) => b.concern - a.concern);
    const weakest = ranked[0];
    return {
      facts: [
        ...ranked.map((c) => `${c.label}: ${c.value}.`),
        weakest
          ? `The weakest of these is ${weakest.label}.`
          : 'No measure has a denominator yet — there is not enough recorded activity to name one.',
      ],
      citations: weakest ? [{ kind: 'measure', code: weakest.code, title: weakest.label }] : [],
      data: { weakest: weakest ?? null, measures: ranked },
    };
  },

  /**
   * docs/28 §6. Correlation over a handful of teams and a few weeks is noise
   * presented as insight, so the series is returned and the inference is not.
   */
  growth_correlation(scoped) {
    const series = scoped.teams.map((t) => ({
      team: t.team,
      growth: t.measures.growth,
      engagementPerActiveMember: t.measures.engagementPerActiveMember,
      courseCompletions: t.measures.courseCompletions,
      paidOrders: t.measures.paidOrders,
      volumeMinor: t.measures.volumeMinor,
      currency: t.measures.currency,
      activeShare: t.measures.activeShare,
    }));
    return {
      refusal: [
        `This platform will not answer that yet. Over ${series.length} team(s) and a ${scoped.window.days}-day window,`,
        'any correlation it produced would be noise presented as insight — and a coaching decision made on noise is worse',
        'than no answer. Below are the underlying series, unaggregated, so you can look at them yourself.',
        'The platform will answer this question once there is enough history for it to mean anything.',
      ].join(' '),
      facts: series.map(
        (s) =>
          `${s.team.name}: growth ${signed(s.growth)}, engagement per active member ${round(s.engagementPerActiveMember)}, ` +
          `${s.courseCompletions} course completions, ${s.paidOrders} paid orders totalling ${s.volumeMinor} ${s.currency} minor units.`,
      ),
      citations: [],
      data: { series },
    };
  },
};

/**
 * The candidate measures for "what should this team focus on". `concern` is a
 * 0–1 comparison key so measures in different units can be ordered at all; it
 * is reported alongside the raw value rather than in place of it, because the
 * ordering is a convenience and the number is the evidence.
 */
function concerns(scoped: TeamScopeAnalytics) {
  const m = scoped.measures;
  const rows: Array<{ code: string; label: string; value: string; concern: number }> = [];

  if (m.activeShare !== null) {
    rows.push({
      code: 'activeShare',
      label: 'share of members active',
      value: `${m.activeMembers} of ${m.totalMembers} (${percent(m.activeShare)})`,
      concern: 1 - m.activeShare,
    });
  }
  rows.push({
    code: 'growth',
    label: 'growth in active members',
    value: `${signed(m.growth)} vs the previous window`,
    concern: m.growth < 0 ? Math.min(1, -m.growth / Math.max(1, m.previousActiveMembers)) : 0,
  });
  if (m.engagementChange !== null) {
    rows.push({
      code: 'engagementPerActiveMember',
      label: 'engagement per active member',
      value: `${round(m.engagementPerActiveMember)} vs ${round(m.previousEngagementPerActiveMember)}`,
      concern:
        m.engagementChange < 0
          ? Math.min(1, -m.engagementChange / Math.max(1, m.previousEngagementPerActiveMember ?? 1))
          : 0,
    });
  }
  if (m.churnRate !== null) {
    rows.push({
      code: 'churnRate',
      label: 'churn',
      value: `${m.churnedMembers} of ${m.membersActiveAtWindowStart} memberships ended (${percent(m.churnRate)})`,
      concern: m.churnRate,
    });
  }
  rows.push({
    code: 'courseCompletions',
    label: 'course completions',
    value: `${m.courseCompletions} in the window`,
    concern: m.courseCompletions === 0 && m.activeMembers > 0 ? 0.5 : 0,
  });
  return rows;
}

function allMilestones(scoped: TeamScopeAnalytics): Milestone[] {
  const seen = new Map<string, Milestone>();
  for (const team of scoped.teams) {
    for (const milestone of team.milestones) seen.set(milestone.memberId, milestone);
  }
  return [...seen.values()];
}

function cite(measure: string, team: TeamAnalytics): AiCitation {
  return { kind: 'measure', code: `${measure}`, title: `${team.team.name} — ${measure}` };
}

function gap(missing: Milestone['missing'][number]): string {
  return `${missing.remaining} short on ${missing.metric} (${missing.current} of ${missing.threshold}, ${missing.window})`;
}

function names(members: NamedMember[]): string {
  return members.length ? members.map((m) => m.displayName).join(', ') : 'no active leader';
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

/** "not measured" rather than 0 wherever there was no denominator. */
function round(value: number | null): string {
  return value === null ? 'not measured' : `${Math.round(value * 100) / 100}`;
}

function percent(value: number | null): string {
  return value === null ? 'not measured' : `${Math.round(value * 1000) / 10}%`;
}
