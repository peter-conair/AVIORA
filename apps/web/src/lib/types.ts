// ---- Auth ----

export const PLATFORM_ROLES = ['PLATFORM_OWNER', 'SUPER_ADMIN'] as const;

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  platformRole: string | null;
}

export interface TenantSummary {
  tenantId: string;
  name: string;
  slug: string;
}

export interface LoginResponse {
  user: AuthUser;
}

export interface MeResponse {
  user: AuthUser;
  tenants: TenantSummary[];
}

export function isPlatformAdmin(user: AuthUser | null | undefined): boolean {
  return !!user?.platformRole && (PLATFORM_ROLES as readonly string[]).includes(user.platformRole);
}

// ---- Platform ----

export interface PlatformTenant {
  id: string;
  code?: string;
  name: string;
  slug: string;
  createdAt?: string;
}

export interface TenantsResponse {
  tenants: PlatformTenant[];
}

export interface CreateTenantResponse {
  tenant: PlatformTenant;
  adminUserId: string;
  adminMemberId: string;
}

// ---- Membership plans ----

export interface MembershipPlan {
  id: string;
  code: string;
  name: string;
  trialDays: number;
  price: string | number | null;
  billingCycle: string | null;
  planEntitlements: { entitlement: { key: string } }[];
}

export interface PlansResponse {
  plans: MembershipPlan[];
}

export interface EntitlementCatalogItem {
  key: string;
  description: string;
}

export interface EntitlementCatalogResponse {
  entitlements: EntitlementCatalogItem[];
}

// ---- Invitations ----

export interface Invitation {
  id: string;
  email: string;
  status: string;
  expiresAt: string;
}

export interface InvitationsResponse {
  invitations: Invitation[];
}

export interface InvitationPublicInfo {
  email: string;
  tenantName: string;
  planName: string;
  trialDays: number;
  expiresAt: string;
}

export interface AcceptInvitationResponse {
  userId: string;
  memberId: string;
  membershipId: string;
  tenantId: string;
}

// ---- Members ----

export type MemberRole =
  string | { name?: string; code?: string; role?: { name?: string; code?: string } };

export interface Member {
  id: string;
  displayName: string;
  email: string;
  status: string;
  roles: MemberRole[];
  joinedAt: string;
}

export interface MembersResponse {
  members: Member[];
}

export function roleLabel(role: MemberRole): string {
  if (typeof role === 'string') return role;
  return role.name ?? role.code ?? role.role?.name ?? role.role?.code ?? '';
}

// ---- Teams ----

export interface Team {
  id: string;
  code: string;
  name: string;
  parentTeamId: string | null;
  description?: string | null;
  createdAt?: string;
}

export interface TeamsResponse {
  teams: Team[];
}

export interface TeamLeadership {
  memberId?: string;
  member?: { id: string; displayName: string };
  leadershipRole?: string;
  isPrimary?: boolean;
  effectiveFrom?: string;
}

export interface TeamDetail extends Team {
  children: Team[];
  memberCount: number;
  teamLeaderships: TeamLeadership[];
}

export interface TeamDetailResponse {
  team: TeamDetail;
}

export interface TeamMemberEntry {
  memberId: string;
  membershipType?: string;
  joinedAt: string;
  member: { id: string; displayName: string; status?: string };
}

export interface TeamMembersResponse {
  members: TeamMemberEntry[];
}

/** Flat subtree rows returned by `GET /teams/:id/descendants` (depth 0 = the team itself). */
export interface TeamDescendant {
  id: string;
  code: string;
  name: string;
  parentTeamId: string | null;
  depth: number;
}

export interface TeamDescendantsResponse {
  teams: TeamDescendant[];
}

export interface TeamMetrics {
  members: number;
  newMembers30d: number;
  goalsCompleted: number;
  coursesCompleted: number;
}

export interface TeamDashboardChild {
  id: string;
  code: string;
  name: string;
  organizationMembers: number;
}

export interface TeamDashboardResponse {
  team: { id: string; code: string; name: string; parentTeamId: string | null };
  direct: TeamMetrics;
  organization: TeamMetrics;
  children: TeamDashboardChild[];
}

export interface LeadershipHistoryEntry {
  memberId: string;
  leadershipRole: string;
  isPrimary: boolean;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface LeadershipHistoryResponse {
  leaderships: LeadershipHistoryEntry[];
}

export interface MoveTeamResponse {
  team: Team;
}

/** One card of `GET /dashboard/leader`. */
export interface LeaderTeamSummary {
  team: { id: string; code: string; name: string };
  leadershipRole: string;
  since: string;
  directMembers: number;
  organizationMembers: number;
  childTeams: number;
}

export interface LeaderDashboardResponse {
  teams: LeaderTeamSummary[];
}

interface TeamTreeNode {
  team: Team;
  children: TeamTreeNode[];
}

export interface TeamTreeRow {
  team: Team;
  depth: number;
}

/**
 * Build an indented tree from a flat, permission-scoped team list.
 * Teams whose parent is not present in `teams` are treated as roots — this is
 * expected when the caller only sees their own subtree.
 */
export function buildTeamTree(teams: Team[]): TeamTreeRow[] {
  const byId = new Map<string, TeamTreeNode>();
  for (const team of teams) byId.set(team.id, { team, children: [] });

  const roots: TeamTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.team.parentTeamId ? byId.get(node.team.parentTeamId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  const sortNodes = (nodes: TeamTreeNode[]): void => {
    nodes.sort((a, b) => a.team.name.localeCompare(b.team.name));
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);

  const rows: TeamTreeRow[] = [];
  const seen = new Set<string>();
  const walk = (nodes: TeamTreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (seen.has(node.team.id)) continue;
      seen.add(node.team.id);
      rows.push({ team: node.team, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

// ---- Goals ----

export interface Goal {
  id: string;
  title: string;
  status: string;
  category: string | null;
  targetDate: string | null;
  createdAt: string;
}

export interface GoalsResponse {
  goals: Goal[];
}

export interface GoalResponse {
  goal: Goal;
}

// ---- Learning ----

export interface Lesson {
  id: string;
  order: number;
  title: string;
}

export interface Course {
  id: string;
  code: string;
  title: string;
  description: string | null;
  lessons: Lesson[];
}

export interface CoursesResponse {
  courses: Course[];
}

export interface CourseProgress {
  courseId: string;
  status: string;
  completedLessonIds: string[];
}

export interface ProgressResponse {
  progress: CourseProgress[];
}

export interface LessonCompleteResponse {
  progress: CourseProgress;
}

// ---- CRM ----

export interface CrmStage {
  id: string;
  code: string;
  name: string;
  order: number;
  isTerminal?: boolean;
  isWon?: boolean;
}

export interface CrmStagesResponse {
  stages: CrmStage[];
}

export interface CrmPipelineStage {
  id: string;
  code: string;
  name: string;
  order: number;
  openLeads: number;
}

export interface CrmPipelineResponse {
  stages: CrmPipelineStage[];
  customers: number;
  openFollowUps: number;
}

export const CRM_LEAD_STATUSES = ['open', 'lost', 'converted'] as const;
export type CrmLeadStatus = (typeof CRM_LEAD_STATUSES)[number];

export const CRM_CHANNELS = ['note', 'call', 'meeting', 'email', 'line', 'chat'] as const;
export type CrmChannel = (typeof CRM_CHANNELS)[number];

export interface CrmLead {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  notes: string | null;
  status: string;
  stageId: string | null;
  ownerMemberId: string | null;
  lastContactAt: string | null;
  convertedCustomerId: string | null;
  createdAt: string;
  stage: { code: string; name: string; order: number } | null;
}

export interface CrmLeadsResponse {
  leads: CrmLead[];
}

export interface CrmLeadResponse {
  lead: CrmLead;
}

export interface CrmFollowUp {
  id: string;
  title: string;
  dueAt: string;
  status: string;
  notes: string | null;
  completedAt: string | null;
}

export interface CrmInteraction {
  id: string;
  summary: string;
  channel: string;
  occurredAt: string;
  actorMemberId: string | null;
}

export interface CrmLeadDetail extends CrmLead {
  followUps: CrmFollowUp[];
  interactions: CrmInteraction[];
}

export interface CrmLeadDetailResponse {
  lead: CrmLeadDetail;
}

export interface CrmCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  convertedFromLeadId: string | null;
  createdAt: string;
}

export interface CrmCustomersResponse {
  customers: CrmCustomer[];
}

/** A follow-up as returned by the standalone list — carries its related record. */
export interface CrmFollowUpEntry extends CrmFollowUp {
  lead: { id: string; name: string } | null;
  customer: { id: string; name: string } | null;
}

export interface CrmFollowUpsResponse {
  followUps: CrmFollowUpEntry[];
}

/** A follow-up is overdue when it is still open and its due date has passed. */
export function isOverdue(followUp: Pick<CrmFollowUp, 'dueAt' | 'status'>): boolean {
  if (followUp.status.toLowerCase() === 'completed') return false;
  const due = new Date(followUp.dueAt);
  return !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
}

// ---- Notifications ----

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: AppNotification[];
  unreadCount: number;
}

export interface NotificationPreference {
  id?: string;
  type: string;
  inApp: boolean;
  email: boolean;
}

export interface NotificationPreferencesResponse {
  preferences: NotificationPreference[];
}

export interface NotificationPreferenceResponse {
  preference: NotificationPreference;
}

/** Types the settings page exposes, with their message key under `notificationSettings.types`. */
export const NOTIFICATION_TYPES: { type: string; messageKey: string }[] = [
  { type: 'membership.activated', messageKey: 'membershipActivated' },
  { type: 'team.joined', messageKey: 'teamJoined' },
  { type: 'team.leader.assigned', messageKey: 'teamLeaderAssigned' },
  { type: 'crm.customer.converted', messageKey: 'crmCustomerConverted' },
];

// ---- Audit ----

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userId: string | null;
  memberId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  createdAt: string;
}

export interface AuditLogsResponse {
  auditLogs: AuditLogEntry[];
  nextCursor: string | null;
}

export interface AuditActionsResponse {
  actions: { action: string; count: number }[];
}

// ---- Dashboard ----

export interface DashboardResponse {
  membership: { planName: string; status: string; trialEndsAt: string | null } | null;
  goals: { recent: Goal[]; counts: Record<string, number> };
  learning: {
    courseId: string;
    courseTitle: string;
    status: string;
    completedLessons: number;
    totalLessons: number;
  }[];
  teams: { teamId: string; name: string; joinedAt: string }[];
}

// ---- Knowledge OS ----

export interface HealthGoal {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** `null` means platform-wide (shared) knowledge rather than tenant-authored. */
  tenantId: string | null;
}

export interface HealthGoalsResponse {
  healthGoals: HealthGoal[];
}

export interface KnowledgeTopic {
  id: string;
  code: string;
  name: string;
  summary: string | null;
}

export interface ArticleSummary {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
}

export interface EvidenceReference {
  title: string;
  source: string | null;
  url: string | null;
  summary: string | null;
  verifiedAt: string | null;
}

export interface ProductBrand {
  id?: string;
  code: string;
  name: string;
}

export interface KnowledgeProduct {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  sourceUrl: string | null;
  lastVerifiedAt?: string | null;
  safetyNotes?: string | null;
  brand: ProductBrand;
}

export interface JourneyIngredient {
  id: string;
  code: string;
  name: string;
  summary: string | null;
  safetyNotes: string | null;
  evidence: EvidenceReference[];
  /** Product ids this ingredient leads to — products stay the last step (§74). */
  productIds: string[];
}

export interface JourneyResponse {
  goal: { id: string; code: string; name: string; description: string | null };
  topics: KnowledgeTopic[];
  articles: ArticleSummary[];
  ingredients: JourneyIngredient[];
  products: KnowledgeProduct[];
  safetyNotice: string;
}

export interface ArticleDetail {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  /** Plain text with blank-line paragraph breaks — never HTML. */
  body: string;
  updatedAt: string;
  topics: { id: string; code: string; name: string }[];
  ingredients: { id: string; code: string; name: string; summary: string | null }[];
}

export interface ArticleResponse {
  article: ArticleDetail;
}

export interface IngredientDetail {
  id: string;
  code: string;
  name: string;
  summary: string | null;
  safetyNotes: string | null;
  evidence: EvidenceReference[];
  products: KnowledgeProduct[];
}

export interface IngredientResponse {
  ingredient: IngredientDetail;
}

export const KNOWLEDGE_KINDS = ['health_goal', 'topic', 'article', 'ingredient'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export interface KnowledgeSearchHit {
  kind: KnowledgeKind;
  id: string;
  /** Slug for articles, code for everything else. */
  code: string;
  title: string;
  summary: string | null;
}

export interface KnowledgeSearchResponse {
  query: string;
  knowledge: KnowledgeSearchHit[];
  products: KnowledgeProduct[];
}

/** Split a plain-text body into paragraphs — blank lines separate them. */
export function toParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ---- AI assistant ----

export interface AiUsage {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  dailyRequestCap: number;
  remaining: number;
  provider: string;
}

export interface AiCitation {
  kind: string;
  code: string;
  title: string;
}

export interface AiConversationSummary {
  id: string;
  title: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationsResponse {
  conversations: AiConversationSummary[];
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Stored as JSON — narrow it with `toCitations()` before rendering. */
  citations: unknown;
  createdAt: string;
}

export interface AiConversationDetail {
  id: string;
  title: string | null;
  agent: string | null;
  createdAt: string;
  messages: AiMessage[];
}

export interface AiConversationResponse {
  conversation: AiConversationDetail;
}

export interface AiAskResponse {
  conversationId: string;
  answer: string;
  citations: AiCitation[];
  provider: string;
  model: string;
  remaining: number;
}

// ---- Healthy living ----

/**
 * Health data is the one domain where no role grants access to another
 * member's records — only that member's own grant does. The UI mirrors that:
 * everything here is self-scoped unless a grant says otherwise.
 */
export interface HealthProfile {
  memberId: string;
  /** Encrypted at rest by the API; plaintext only for readers who passed the access check. */
  lifestyleNotes: string | null;
  focusGoalIds: string[];
  updatedAt: string;
}

export interface HealthProfileResponse {
  profile: HealthProfile | null;
}

export const HABIT_CADENCES = ['daily', 'weekly'] as const;
export type HabitCadence = (typeof HABIT_CADENCES)[number];

export interface Habit {
  id: string;
  code: string;
  name: string;
  cadence: string;
  targetUnit: string | null;
  /** A decimal column — arrives as a string from the API. */
  targetValue: string | number | null;
}

export interface HabitsResponse {
  habits: Habit[];
}

export interface HabitResponse {
  habit: Habit;
}

/** Metrics a member may record. Observational only — never a diagnosis. */
export const TRACKED_METRICS = ['weight_kg', 'sleep_hours', 'water_ml', 'steps'] as const;
export type TrackedMetric = (typeof TRACKED_METRICS)[number];

/** The unit each metric is normally recorded in — a default, not a constraint. */
export const METRIC_DEFAULT_UNITS: Record<TrackedMetric, string> = {
  weight_kg: 'kg',
  sleep_hours: 'h',
  water_ml: 'ml',
  steps: 'steps',
};

export interface HealthSummaryHabit {
  id: string;
  code: string;
  name: string;
  cadence: string;
  targetUnit: string | null;
  /** Distinct days this habit was logged inside the window. */
  daysLogged: number;
}

export interface HealthMetricReading {
  metric: string;
  value: number;
  unit: string;
  measuredOn: string;
}

export interface HealthSummary {
  memberId: string;
  windowDays: number;
  habits: HealthSummaryHabit[];
  latestMetrics: HealthMetricReading[];
  /** The API's own safety note — rendered verbatim, never paraphrased. */
  note: string;
}

/** A grant this member gave away — someone else may read their summary. */
export interface HealthGrantGiven {
  id: string;
  granteeMemberId: string;
  scope: string;
  grantedAt: string;
}

/** A grant this member received — they may read someone else's summary. */
export interface HealthGrantReceived {
  id: string;
  memberId: string;
  scope: string;
  grantedAt: string;
}

export interface HealthGrantsResponse {
  given: HealthGrantGiven[];
  received: HealthGrantReceived[];
}

// ---- Community ----

/** The caller's own member row — needed to tell "my post" from someone else's. */
export interface MemberMeResponse {
  member: { id: string; displayName: string } | null;
}

export interface CommunitySummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  teamId: string;
  postCount: number;
}

export interface CommunitiesResponse {
  communities: CommunitySummary[];
}

/** `GET /community/teams/:teamId` — creates the team's space on first access. */
export interface TeamCommunityResponse {
  community: { id: string; code: string; name: string; teamId: string };
}

/** `displayName` is null when the author's member row is no longer readable. */
export interface PostAuthor {
  id: string;
  displayName: string | null;
}

export interface PostComment {
  id: string;
  body: string;
  createdAt: string;
  author: PostAuthor;
}

export interface CommunityPost {
  id: string;
  body: string;
  kind: string;
  pinned: boolean;
  createdAt: string;
  author: PostAuthor;
  reactionCount: number;
  reactedByMe: boolean;
  comments: PostComment[];
}

export interface CommunityFeedResponse {
  community: { id: string; name: string; teamId: string };
  posts: CommunityPost[];
}

// ---- Challenges ----

export const CHALLENGE_SOURCES = ['habit', 'course', 'goal'] as const;
export type ChallengeSource = (typeof CHALLENGE_SOURCES)[number];

/** Only `habit` and `course` challenges point at a specific record. */
export function needsSourceRef(source: string): boolean {
  return source === 'habit' || source === 'course';
}

export interface Challenge {
  id: string;
  code: string;
  name: string;
  description: string | null;
  source: string;
  sourceRef: string | null;
  targetValue: number;
  startsOn: string;
  endsOn: string;
  joined: boolean;
  completedAt: string | null;
}

export interface ChallengesResponse {
  challenges: Challenge[];
}

export interface ChallengeResponse {
  challenge: Challenge;
}

/**
 * One leaderboard row. Only the derived progress count crosses the boundary —
 * never the habit logs, lessons or goals it was computed from.
 */
export interface ChallengeLeaderboardRow {
  memberId: string;
  displayName: string | null;
  progress: number;
  completedAt: string | null;
  isMe: boolean;
}

export interface ChallengeLeaderboardResponse {
  challenge: {
    id: string;
    code: string;
    name: string;
    source: string;
    targetValue: number;
    startsOn: string;
    endsOn: string;
  };
  participantCount: number;
  leaderboard: ChallengeLeaderboardRow[];
  /** The API's own wording about who appears here — rendered verbatim. */
  privacyNote: string;
}

// ---- Gamification ----

/** Domain events a tenant may attach points to. Anything else earns nothing. */
export const GAMIFICATION_EVENTS = [
  'HabitLogged',
  'GoalCompleted',
  'CourseCompleted',
  'ChallengeCompleted',
  'MemberJoinedTeam',
  'CustomerConverted',
  'PostPublished',
] as const;
export type GamificationEvent = (typeof GAMIFICATION_EVENTS)[number];

export function isKnownGamificationEvent(name: string): name is GamificationEvent {
  return (GAMIFICATION_EVENTS as readonly string[]).includes(name);
}

export interface MemberBadge {
  badgeCode: string;
  badgeName: string;
  awardedAt: string;
}

export interface PointEntry {
  eventName: string;
  points: number;
  createdAt: string;
}

export interface GamificationStanding {
  points: number;
  level: number;
  pointsToNextLevel: number;
  badges: MemberBadge[];
  recent: PointEntry[];
}

export interface GamificationLeaderboardRow {
  rank: number;
  memberId: string;
  displayName: string | null;
  points: number;
}

export interface GamificationLeaderboardResponse {
  leaderboard: GamificationLeaderboardRow[];
}

export interface GamificationRule {
  id: string;
  eventName: string;
  points: number;
  badgeCode: string | null;
  badgeName: string | null;
}

export interface GamificationRulesResponse {
  rules: GamificationRule[];
}

export interface GamificationRuleResponse {
  rule: GamificationRule;
}

/**
 * How much of the current level is already earned, as a 0–100 percentage.
 *
 * The API never sends the level size, but it is recoverable from the three
 * numbers it does send: with a level size `S`, `points + pointsToNextLevel`
 * equals `S * level`. Deriving it keeps the bar correct if the curve changes.
 */
export function levelProgressPercent(
  standing: Pick<GamificationStanding, 'points' | 'level' | 'pointsToNextLevel'>,
): number {
  if (standing.level <= 0) return 0;
  const levelSize = (standing.points + standing.pointsToNextLevel) / standing.level;
  if (!Number.isFinite(levelSize) || levelSize <= 0) return 0;
  const earnedInLevel = levelSize - standing.pointsToNextLevel;
  return Math.max(0, Math.min(100, Math.round((earnedInLevel / levelSize) * 100)));
}

/** Narrow the JSON `citations` column to something renderable. */
export function toCitations(value: unknown): AiCitation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AiCitation =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as AiCitation).title === 'string' &&
      typeof (item as AiCitation).kind === 'string',
  );
}
