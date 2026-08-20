import { Injectable } from '@nestjs/common';
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

const QUESTION_TEXT: Record<CoachQuestion, string> = {
  fastest_growing_team: 'Which of my teams is growing fastest?',
  team_needs_support: 'Which of my teams needs support?',
  leader_needs_coaching: 'Which leader needs coaching?',
  inactive_member: 'Which members are inactive?',
  close_to_milestone: 'Who is close to their next milestone?',
  next_course: 'Which course should the team take next?',
  team_focus: 'What should this team focus on?',
  growth_correlation: 'What activities correlate with growth?',
};

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
    input: { question: CoachQuestion; window: AnalyticsWindow; locale?: string },
  ) {
    const scoped = await this.analytics.team(actor, input.window);
    const finding = findings[input.question](scoped);
    const envelope = {
      question: input.question,
      questionText: QUESTION_TEXT[input.question],
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
      question: QUESTION_TEXT[input.question],
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
        b.measures.growth.change - a.measures.growth.change ||
        (b.measures.growth.changeRate ?? 0) - (a.measures.growth.changeRate ?? 0),
    );
    return {
      facts: [
        ...ranked
          .slice(0, LIST_LIMIT)
          .map(
            (t) =>
              `${t.team.name}: ${signed(t.measures.growth.change)} active members ` +
              `(${t.measures.growth.active} now vs ${t.measures.growth.previousActive} in the previous window).`,
          ),
        ...(ranked.length ? [] : ['No team is in scope for this leader.']),
      ],
      citations: ranked.slice(0, LIST_LIMIT).map((t) => cite('growth', t)),
      data: ranked.map((t) => ({ team: t.team, growth: t.measures.growth })),
    };
  },

  team_needs_support(scoped) {
    const ranked = [...scoped.teams].sort(
      (a, b) =>
        a.measures.growth.change - b.measures.growth.change ||
        (a.measures.members.activeShare ?? 1) - (b.measures.members.activeShare ?? 1),
    );
    return {
      facts: ranked
        .slice(0, LIST_LIMIT)
        .map(
          (t) =>
            `${t.team.name}: growth ${signed(t.measures.growth.change)} active members, ` +
            `${t.measures.members.active} of ${t.measures.members.total} members active ` +
            `(${percent(t.measures.members.activeShare)}).`,
        ),
      citations: ranked.slice(0, LIST_LIMIT).map((t) => cite('growth', t)),
      data: ranked.map((t) => ({
        team: t.team,
        growth: t.measures.growth,
        members: t.measures.members,
      })),
    };
  },

  leader_needs_coaching(scoped) {
    // A measure that fell, never a judgement about a person (docs/28 §6).
    const fell = scoped.teams
      .filter((t) => (t.measures.engagement.change ?? 0) < 0)
      .sort((a, b) => (a.measures.engagement.change ?? 0) - (b.measures.engagement.change ?? 0));
    return {
      facts: fell.length
        ? fell
            .slice(0, LIST_LIMIT)
            .map(
              (t) =>
                `${t.team.name} (led by ${names(t.leaders)}): engagement per active member fell from ` +
                `${round(t.measures.engagement.previousPerActiveMember)} to ${round(t.measures.engagement.perActiveMember)}.`,
            )
        : ['Engagement per active member did not fall in any team in scope.'],
      citations: fell.slice(0, LIST_LIMIT).map((t) => cite('engagement', t)),
      data: fell.map((t) => ({
        team: t.team,
        leaders: t.leaders,
        engagement: t.measures.engagement,
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
    const ranked = [...scoped.measures.learning.courses].sort(
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
      growthChange: t.measures.growth.change,
      engagementPerActiveMember: t.measures.engagement.perActiveMember,
      learningCompletions: t.measures.learning.completedInWindow,
      paidOrders: t.measures.commerce.paidOrders,
      volumeMinor: t.measures.commerce.volumeMinor,
      currency: t.measures.commerce.currency,
      activeShare: t.measures.members.activeShare,
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
          `${s.team.name}: growth ${signed(s.growthChange)}, engagement per active member ${round(s.engagementPerActiveMember)}, ` +
          `${s.learningCompletions} course completions, ${s.paidOrders} paid orders totalling ${s.volumeMinor} ${s.currency} minor units.`,
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

  if (m.members.activeShare !== null) {
    rows.push({
      code: 'members.activeShare',
      label: 'share of members active',
      value: `${m.members.active} of ${m.members.total} (${percent(m.members.activeShare)})`,
      concern: 1 - m.members.activeShare,
    });
  }
  rows.push({
    code: 'growth.change',
    label: 'growth in active members',
    value: `${signed(m.growth.change)} vs the previous window`,
    concern:
      m.growth.change < 0
        ? Math.min(1, -m.growth.change / Math.max(1, m.growth.previousActive))
        : 0,
  });
  if (m.engagement.change !== null) {
    rows.push({
      code: 'engagement.perActiveMember',
      label: 'engagement per active member',
      value: `${round(m.engagement.perActiveMember)} vs ${round(m.engagement.previousPerActiveMember)}`,
      concern:
        m.engagement.change < 0
          ? Math.min(
              1,
              -m.engagement.change / Math.max(1, m.engagement.previousPerActiveMember ?? 1),
            )
          : 0,
    });
  }
  if (m.churn.rate !== null) {
    rows.push({
      code: 'churn.rate',
      label: 'churn',
      value: `${m.churn.ended} of ${m.churn.activeAtStart} memberships ended (${percent(m.churn.rate)})`,
      concern: m.churn.rate,
    });
  }
  rows.push({
    code: 'learning.completedInWindow',
    label: 'course completions',
    value: `${m.learning.completedInWindow} in the window`,
    concern: m.learning.completedInWindow === 0 && m.members.active > 0 ? 0.5 : 0,
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
