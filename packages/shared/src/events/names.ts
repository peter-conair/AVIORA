/**
 * Domain event names — PascalCase, past tense (docs/11-event-architecture.md).
 * MVP catalog; extend here, never inline strings.
 */
export const EVENTS = {
  TenantCreated: 'TenantCreated',
  MemberRegistered: 'MemberRegistered',
  MemberInvited: 'MemberInvited',
  MembershipActivated: 'MembershipActivated',
  MembershipExpiring: 'MembershipExpiring',
  MembershipExpired: 'MembershipExpired',
  TeamCreated: 'TeamCreated',
  TeamMoved: 'TeamMoved',
  TeamArchived: 'TeamArchived',
  LeaderAssigned: 'LeaderAssigned',
  MemberJoinedTeam: 'MemberJoinedTeam',
  GoalCreated: 'GoalCreated',
  GoalCompleted: 'GoalCompleted',
  CourseStarted: 'CourseStarted',
  CourseCompleted: 'CourseCompleted',
  CustomerConverted: 'CustomerConverted',
  LeadCreated: 'LeadCreated',
  LeadStageChanged: 'LeadStageChanged',
  FollowUpDue: 'FollowUpDue',
  HabitLogged: 'HabitLogged',
  ChallengeJoined: 'ChallengeJoined',
  ChallengeCompleted: 'ChallengeCompleted',
  PostPublished: 'PostPublished',
  OrderPlaced: 'OrderPlaced',
  OrderCompleted: 'OrderCompleted',
  SubscriptionCreated: 'SubscriptionCreated',
  SubscriptionRenewed: 'SubscriptionRenewed',
  SubscriptionPaused: 'SubscriptionPaused',
  SubscriptionResumed: 'SubscriptionResumed',
  SubscriptionCancelled: 'SubscriptionCancelled',
  ReferralCreated: 'ReferralCreated',
  ReferralEnded: 'ReferralEnded',
  RankAchieved: 'RankAchieved',
  RankLost: 'RankLost',
  CompensationPlacementCreated: 'CompensationPlacementCreated',
  CompensationPlacementEnded: 'CompensationPlacementEnded',
  CommissionRunCreated: 'CommissionRunCreated',
  CommissionRunApproved: 'CommissionRunApproved',
  CommissionEarned: 'CommissionEarned',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Envelope stored in the domain_events outbox (payload is event-specific). */
export interface DomainEventEnvelope<TPayload = unknown> {
  eventId: string;
  eventName: EventName;
  tenantId: string | null;
  aggregateType: string;
  aggregateId: string;
  actorUserId: string | null;
  payload: TPayload;
  occurredAt: string; // ISO-8601 with offset
  version: number;
}
