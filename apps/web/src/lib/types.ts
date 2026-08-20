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

// ---- Commerce (docs/24) ----

export const OFFERING_KINDS = ['one_time', 'subscription'] as const;
export type OfferingKind = (typeof OFFERING_KINDS)[number];

export const INTERVAL_UNITS = ['day', 'week', 'month'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export const COUPON_KINDS = ['percent', 'fixed'] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

export const ORDER_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Every priced field is an integer in MINOR units of its own row's `currency`.
 * There is no tenant-wide currency to fall back on, so the code always travels
 * with the amount.
 */
export interface Offering {
  id: string;
  code: string;
  name: string;
  description: string | null;
  productId: string | null;
  kind: string;
  currency: string;
  /** The catalogue price before membership pricing is applied. */
  listPriceMinor: number;
  /** What THIS caller would pay — the resolved price (docs/24 §1). */
  priceMinor: number;
  intervalUnit: string | null;
  intervalCount: number | null;
}

export interface OfferingsResponse {
  offerings: Offering[];
}

/** The raw row a write returns — it carries `status`, which the list never does. */
export interface OfferingRow extends Omit<Offering, 'listPriceMinor' | 'priceMinor'> {
  priceMinor: number;
  status: string;
}

export interface OfferingResponse {
  offering: OfferingRow;
}

export interface CartItem {
  id: string;
  offeringId: string;
  name: string;
  kind: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface Cart {
  id: string;
  status: string;
  currency: string;
  items: CartItem[];
  coupon: { code: string; kind: string; value: number } | null;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
}

export interface CartResponse {
  cart: Cart;
}

export interface OrderItem {
  id: string;
  offeringId: string;
  /** Snapshotted at purchase — a later rename must not rewrite history. */
  name: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface Order {
  id: string;
  number: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  placedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  items?: OrderItem[];
}

export interface OrdersResponse {
  orders: Order[];
}

/** `POST /cart/checkout` answers with the order and any subscriptions it started. */
export interface CheckoutResponse {
  order: Order;
  subscriptions: Subscription[];
}

export interface Subscription {
  id: string;
  offeringId: string;
  status: string;
  intervalUnit: string;
  intervalCount: number;
  quantity: number;
  currency: string;
  priceMinor: number;
  startedAt: string;
  nextRunOn: string;
  pausedAt: string | null;
  cancelledAt: string | null;
  autoRenew: boolean;
  offering?: { code: string; name: string };
}

export interface SubscriptionsResponse {
  subscriptions: Subscription[];
}

export interface SubscriptionResponse {
  subscription: Subscription;
}

export interface Coupon {
  id: string;
  code: string;
  kind: string;
  value: number;
  currency: string | null;
  minSubtotalMinor: number | null;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  status: string;
}

export interface CouponsResponse {
  coupons: Coupon[];
}

/**
 * `orders.status*` message key for an order status, or null when the API sends
 * a status this build has no wording for — the caller then shows it verbatim
 * rather than mislabelling it.
 */
export function orderStatusKey(status: string): string | null {
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) return null;
  return `status${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

/** `shop.unit*` message key for a billing interval unit, or null if unknown. */
export function intervalUnitKey(unit: string): string | null {
  if (!(INTERVAL_UNITS as readonly string[]).includes(unit)) return null;
  return `unit${unit.charAt(0).toUpperCase()}${unit.slice(1)}`;
}

// ---- Growth: ranks & referrals (docs/25) ----

export const RANK_METRICS = [
  'personal_volume',
  'referral_downline_volume',
  'direct_referrals',
  'qualified_legs',
  'courses_completed',
] as const;
export type RankMetric = (typeof RANK_METRICS)[number];

export const RANK_WINDOWS = ['lifetime', 'rolling_30', 'rolling_90', 'calendar_month'] as const;
export type RankWindow = (typeof RANK_WINDOWS)[number];

export const RANK_COMPARATORS = ['gte', 'gt', 'lte', 'lt', 'eq'] as const;
export type RankComparator = (typeof RANK_COMPARATORS)[number];

export const REFERRAL_TYPES = [
  'referral',
  'sponsor',
  'introducer',
  'affiliate',
  'mentor_referral',
] as const;
export type ReferralType = (typeof REFERRAL_TYPES)[number];

/**
 * The metrics whose values are integer MINOR units of money. Everything else is
 * a plain count and must never be divided — a member with 3 direct referrals
 * has 3, not 0.03.
 *
 * `downline_volume` is the graph-parameterised spelling introduced by the
 * compensation engine (docs/26 §3). It measures the same money as its Sprint 9
 * alias, so it has to be here too — a volume that missed this list would be
 * rendered as a count and read a hundred times too large.
 */
const MONEY_METRICS: readonly string[] = [
  'personal_volume',
  'downline_volume',
  'referral_downline_volume',
];

export function isMoneyMetric(metric: string): boolean {
  return MONEY_METRICS.includes(metric);
}

const RANK_METRIC_KEYS: Record<string, string> = {
  personal_volume: 'metricPersonalVolume',
  /** Pinned to the referral graph by its name — worded that way (docs/26 §3). */
  referral_downline_volume: 'metricDownlineVolume',
  /** Takes its line from the requirement's graph, so its wording names none. */
  downline_volume: 'metricDownlineVolumeAny',
  direct_referrals: 'metricDirectReferrals',
  qualified_legs: 'metricQualifiedLegs',
  courses_completed: 'metricCoursesCompleted',
};

const RANK_WINDOW_KEYS: Record<string, string> = {
  lifetime: 'windowLifetime',
  rolling_30: 'windowRolling30',
  rolling_90: 'windowRolling90',
  calendar_month: 'windowCalendarMonth',
  period: 'windowPeriod',
};

const METRIC_GRAPH_KEYS: Record<string, string> = {
  compensation: 'graphCompensation',
  referral: 'graphReferral',
};

const REFERRAL_TYPE_KEYS: Record<string, string> = {
  referral: 'typeReferral',
  sponsor: 'typeSponsor',
  introducer: 'typeIntroducer',
  affiliate: 'typeAffiliate',
  mentor_referral: 'typeMentorReferral',
};

/** `growth.*` message key, or null when this build has no wording for the value. */
export function rankMetricKey(metric: string): string | null {
  return RANK_METRIC_KEYS[metric] ?? null;
}

export function rankWindowKey(window: string): string | null {
  return RANK_WINDOW_KEYS[window] ?? null;
}

export function referralTypeKey(type: string): string | null {
  return REFERRAL_TYPE_KEYS[type] ?? null;
}

/** `growth.*` message key naming the graph a requirement walks (docs/26 §2). */
export function metricGraphKey(graph: string): string | null {
  return METRIC_GRAPH_KEYS[graph] ?? null;
}

/**
 * Whether a metric walks a graph at all. Personal volume and completed courses
 * are about one member, so naming a graph beside them tells the reader
 * something that is not true of the calculation.
 */
const GRAPH_DEPENDENT_METRICS = new Set([
  'downline_volume',
  'referral_downline_volume',
  'direct_referrals',
  'qualified_legs',
]);

export function metricWalksAGraph(metric: string): boolean {
  return GRAPH_DEPENDENT_METRICS.has(metric);
}

export interface RankQualification {
  id?: string;
  metric: string;
  comparator: string;
  threshold: number;
  window: string;
  params?: Record<string, unknown> | null;
}

export interface RankDefinition {
  id: string;
  code: string;
  name: string;
  level: number;
  status?: string;
  requalifyWindowDays?: number | null;
  qualifications: RankQualification[];
}

/**
 * The ladder names its own currency, as `/ranks/me` does: every money-valued
 * threshold below is minor units of THIS code, and nothing has to infer one.
 */
export interface RanksResponse {
  ranks: RankDefinition[];
  currency: string;
}

export interface RankResponse {
  rank: RankDefinition;
}

export interface RankRef {
  id: string;
  code: string;
  name: string;
  level: number;
}

/** The rank qualified RIGHT NOW, with the moment that was last decided. */
export interface CurrentRank extends RankRef {
  evaluatedAt: string | null;
}

/**
 * One unmet rule: what is measured, over what window, what it must reach, and
 * where the member stands. `remaining` is already the difference — it is not
 * recomputed here.
 */
export interface RankRequirementGap {
  metric: string;
  comparator: string;
  window: string;
  threshold: number;
  current: number;
  remaining: number;
  met?: boolean;
}

/**
 * `current` is qualification, `highest` is recognition. They answer different
 * questions and are never merged into one number (docs/25 §3).
 */
export interface RankMeResponse {
  memberId: string;
  /** ISO-4217 code for every money-valued metric in `missing`. */
  currency: string;
  current: CurrentRank | null;
  highest: RankRef | null;
  next: RankRef | null;
  missing: RankRequirementGap[];
}

export interface ReferralEdge {
  id: string;
  referrerMemberId?: string;
  referredMemberId?: string;
  relationshipType: string;
  effectiveFrom: string;
  /** Set when the edge was ended — the row is closed, never deleted. */
  effectiveTo?: string | null;
  /** The member-facing rows name only the OTHER end of the edge. */
  displayName?: string | null;
  /** The tenant-wide list names both ends. */
  referrerDisplayName?: string | null;
  referredDisplayName?: string | null;
}

export interface ReferralsResponse {
  referrals: ReferralEdge[];
}

export interface ReferralMeResponse {
  memberId: string;
  /** The sponsor edge — the one answer to "who referred me". */
  referrer: ReferralEdge | null;
  /** Every active edge, since a member can have a sponsor and a mentor at once. */
  referrers: ReferralEdge[];
  directReferrals: ReferralEdge[];
}

export interface ReferralResponse {
  referral: ReferralEdge;
}

export interface RankEvaluateResponse {
  asOf: string;
  evaluated: number;
  changed: number;
}

// ---- Compensation (docs/26) ----

/**
 * The metric vocabulary a compensation rule may use. It is the rank vocabulary
 * plus `downline_volume`, whose line comes from the requirement's `graph`;
 * `referral_downline_volume` survives as the Sprint 9 alias pinned to the
 * referral graph (docs/26 §3).
 */
export const COMPENSATION_METRICS = [
  'personal_volume',
  'downline_volume',
  'referral_downline_volume',
  'direct_referrals',
  'qualified_legs',
  'courses_completed',
] as const;
export type CompensationMetric = (typeof COMPENSATION_METRICS)[number];

/**
 * The rank windows plus `period`, which resolves against the run being
 * computed. It is deliberately NOT added to `RANK_WINDOWS`: a rank evaluation
 * has no period and degrades to lifetime, so offering it on the ladder form
 * would offer a window that does not mean what it says.
 */
export const COMPENSATION_WINDOWS = [
  'period',
  'lifetime',
  'rolling_30',
  'rolling_90',
  'calendar_month',
] as const;
export type CompensationWindow = (typeof COMPENSATION_WINDOWS)[number];

/** Which line a requirement walks. Never a default — always said out loud. */
export const METRIC_GRAPHS = ['compensation', 'referral'] as const;
export type MetricGraph = (typeof METRIC_GRAPHS)[number];

export const PAYOUT_KINDS = ['fixed', 'percent'] as const;
export type PayoutKind = (typeof PAYOUT_KINDS)[number];

/**
 * The eleven bonuses of spec §43 are labels, not code paths, so `bonusType` is
 * a free string the tenant chooses. These are the ones this build has wording
 * for; anything else is shown as a bonus with its own code beside it, never
 * mislabelled as one of these.
 */
const BONUS_TYPE_KEYS: Record<string, string> = {
  fixed_cash: 'bonusFixedCash',
  percentage: 'bonusPercentage',
  rank: 'bonusRank',
  referral: 'bonusReferral',
  milestone: 'bonusMilestone',
  team: 'bonusTeam',
};

/** `earnings.bonus*` message key for a bonus label, or null when unknown. */
export function bonusTypeKey(bonusType: string): string | null {
  return BONUS_TYPE_KEYS[bonusType] ?? null;
}

export interface RuleCondition {
  metric: string;
  comparator: string;
  threshold: number;
  window: string;
  graph?: string;
  params?: Record<string, unknown> | null;
}

/**
 * `percent` pays `round(basis × percent / 100)`, then caps. The basis is a
 * metric name computed by the same calculator as the conditions, so a rule
 * cannot mean one number in its condition and another in its payout.
 */
export type RulePayout =
  | { kind: 'fixed'; amountMinor: number }
  | {
      kind: 'percent';
      percent: number;
      basis: string;
      basisWindow?: string;
      basisGraph?: string;
      capMinor?: number | null;
    };

export interface CompensationRule {
  id: string;
  planId: string;
  code: string;
  name: string;
  /** A reporting label. Nothing branches on it (docs/26 §1). */
  bonusType: string;
  priority: number;
  status: string;
  /** JSON columns — narrow with `toConditions()` / `toPayout()` before use. */
  conditions: unknown;
  payout: unknown;
  createdAt?: string;
}

export interface CompensationPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** Every amount in this plan is minor units of THIS code. */
  currency: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt?: string;
  rules: CompensationRule[];
}

export interface CompensationPlansResponse {
  plans: CompensationPlan[];
}

export interface CompensationPlanResponse {
  plan: CompensationPlan;
}

export interface CompensationRuleResponse {
  rule: CompensationRule;
}

export interface CommissionRun {
  id: string;
  planId: string;
  periodStart: string;
  periodEnd: string;
  /** draft | approved. Draft is recomputable; approved is frozen (docs/26 §4). */
  status: string;
  currency: string;
  totalMinor: number;
  entryCount: number;
  computedAt: string;
  approvedAt: string | null;
  plan?: { code: string; name: string };
}

export interface CommissionRunsResponse {
  runs: CommissionRun[];
}

export interface CommissionRunResponse {
  run: CommissionRun;
}

/**
 * `POST /compensation/runs` answers with the run AND whether this call made it.
 * Asking twice for the same period returns the first run, because the second
 * row would be a second payout (docs/26 §4).
 */
export interface CreateRunResponse {
  run: CommissionRun;
  created: boolean;
}

export interface CommissionEntry {
  id: string;
  runId: string;
  memberId: string;
  ruleId: string;
  bonusType: string;
  amountMinor: number;
  /** Minor units of this code — the amount never travels without it. */
  currency: string;
  /** The exact numbers that produced the amount — narrow with `toEntryBasis()`. */
  basis: unknown;
  rule?: { code: string; name: string };
  member?: { displayName: string };
  run?: { id: string; periodStart: string; periodEnd: string; approvedAt: string | null };
}

export interface RunEntriesResponse {
  run: CommissionRun;
  entries: CommissionEntry[];
}

/**
 * `GET /compensation/me`. Approved entries only — a member should never see a
 * number that has not been signed off. `currency` is null when there are none.
 */
export interface EarningsResponse {
  memberId: string;
  currency: string | null;
  totalMinor: number;
  entries: CommissionEntry[];
}

export interface Placement {
  id: string;
  uplineMemberId: string;
  downlineMemberId: string;
  effectiveFrom: string;
  /** Set when the placement ended — the row is closed, never deleted. */
  effectiveTo: string | null;
  uplineDisplayName?: string | null;
  downlineDisplayName?: string | null;
}

export interface PlacementsResponse {
  placements: Placement[];
}

export interface PlacementResponse {
  placement: Placement;
}

/** One condition as it stood when the entry was computed: rule and reality. */
export interface EntryBasisCondition {
  metric: string;
  comparator: string;
  window: string;
  graph?: string;
  threshold: number;
  value: number;
}

export interface EntryBasis {
  ruleCode: string | null;
  asOf: string | null;
  conditions: EntryBasisCondition[];
  payout: RulePayout | null;
  /** The metric value a percentage was taken OF; null for a fixed payout. */
  basisValue: number | null;
  /** What the percentage came to before the cap. */
  uncappedMinor: number | null;
  capApplied: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Narrow a rule's stored `conditions` column to something renderable. */
export function toConditions(value: unknown): RuleCondition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RuleCondition[] => {
    const row = asRecord(item);
    if (!row || typeof row.metric !== 'string') return [];
    return [
      {
        metric: row.metric,
        comparator: asString(row.comparator, 'gte'),
        threshold: asNumber(row.threshold) ?? 0,
        window: asString(row.window, 'lifetime'),
        graph: typeof row.graph === 'string' ? row.graph : undefined,
      },
    ];
  });
}

/** Narrow a rule's stored `payout` column; null when it is not one of the two kinds. */
export function toPayout(value: unknown): RulePayout | null {
  const row = asRecord(value);
  if (!row) return null;
  if (row.kind === 'fixed') {
    const amountMinor = asNumber(row.amountMinor);
    return amountMinor === null ? null : { kind: 'fixed', amountMinor };
  }
  if (row.kind === 'percent') {
    const percent = asNumber(row.percent);
    if (percent === null || typeof row.basis !== 'string') return null;
    return {
      kind: 'percent',
      percent,
      basis: row.basis,
      basisWindow: typeof row.basisWindow === 'string' ? row.basisWindow : undefined,
      basisGraph: typeof row.basisGraph === 'string' ? row.basisGraph : undefined,
      capMinor: asNumber(row.capMinor),
    };
  }
  return null;
}

/**
 * Narrow an entry's `basis` column. It is written once at computation time and
 * never recomputed, so this only reads — it must never derive a number the run
 * did not store, or the explanation stops being the explanation.
 */
export function toEntryBasis(value: unknown): EntryBasis {
  const row = asRecord(value);
  const payoutRow = asRecord(row?.payout);
  const conditions = Array.isArray(row?.conditions) ? row.conditions : [];
  return {
    ruleCode: typeof row?.ruleCode === 'string' ? row.ruleCode : null,
    asOf: typeof row?.asOf === 'string' ? row.asOf : null,
    conditions: conditions.flatMap((item): EntryBasisCondition[] => {
      const condition = asRecord(item);
      if (!condition || typeof condition.metric !== 'string') return [];
      return [
        {
          metric: condition.metric,
          comparator: asString(condition.comparator, 'gte'),
          window: asString(condition.window, 'lifetime'),
          graph: typeof condition.graph === 'string' ? condition.graph : undefined,
          threshold: asNumber(condition.threshold) ?? 0,
          value: asNumber(condition.value) ?? 0,
        },
      ];
    }),
    payout: toPayout(payoutRow),
    basisValue: asNumber(payoutRow?.basisValue),
    uncappedMinor: asNumber(payoutRow?.uncappedMinor),
    capApplied: payoutRow?.capApplied === true,
  };
}

// ---- Automation & rewards (docs/27) ----

/**
 * The events a rule may name, mirroring the shared `EVENTS` catalog. A rule
 * naming anything else is refused at creation, so the picker offers exactly
 * this list and nothing else (docs/27 §1).
 *
 * `RewardGranted` and `RewardRevoked` are legal triggers, but an event PRODUCED
 * by an automation action never triggers a rule — that is what stops a rule
 * granting a reward on `RewardGranted` from chaining for ever (docs/27 §1).
 */
export const TRIGGER_EVENTS = [
  'TenantCreated',
  'MemberRegistered',
  'MemberInvited',
  'MembershipActivated',
  'MembershipExpiring',
  'MembershipExpired',
  'TeamCreated',
  'TeamMoved',
  'TeamArchived',
  'LeaderAssigned',
  'MemberJoinedTeam',
  'GoalCreated',
  'GoalCompleted',
  'CourseStarted',
  'CourseCompleted',
  'CustomerConverted',
  'LeadCreated',
  'LeadStageChanged',
  'FollowUpDue',
  'HabitLogged',
  'ChallengeJoined',
  'ChallengeCompleted',
  'PostPublished',
  'OrderPlaced',
  'OrderCompleted',
  'SubscriptionCreated',
  'SubscriptionRenewed',
  'SubscriptionPaused',
  'SubscriptionResumed',
  'SubscriptionCancelled',
  'ReferralCreated',
  'ReferralEnded',
  'RankAchieved',
  'RankLost',
  'CompensationPlacementCreated',
  'CompensationPlacementEnded',
  'CommissionRunCreated',
  'CommissionRunApproved',
  'CommissionEarned',
  'RewardGranted',
  'RewardRevoked',
] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

const TRIGGER_EVENT_SET: ReadonlySet<string> = new Set(TRIGGER_EVENTS);

/** `admin.automation.events.*` key, or null for an event this build cannot name. */
export function triggerEventKey(eventName: string): string | null {
  return TRIGGER_EVENT_SET.has(eventName) ? `events.${eventName}` : null;
}

/**
 * The four actions with a real adapter. The rest of spec §51's list —
 * `send_email`, `send_line`, `run_ai`, `assign_coach`, `update_segment`,
 * `create_task`, `trigger_workflow` — is refused by the API at creation, so
 * offering any of them here would be offering a rule that cannot be saved.
 */
export const AUTOMATION_ACTION_TYPES = [
  'send_notification',
  'grant_reward',
  'create_followup',
  'assign_course',
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export function isAutomationActionType(type: string): type is AutomationActionType {
  return (AUTOMATION_ACTION_TYPES as readonly string[]).includes(type);
}

/** Enable, disable, reprioritise — the only edits a saved rule allows. */
export const AUTOMATION_RULE_STATUSES = ['active', 'disabled', 'archived'] as const;
export type AutomationRuleStatus = (typeof AUTOMATION_RULE_STATUSES)[number];

/** `running` is a row still settling; the other three are final. */
export const AUTOMATION_EXECUTION_STATUSES = ['success', 'failed', 'skipped', 'running'] as const;
export type AutomationExecutionStatus = (typeof AUTOMATION_EXECUTION_STATUSES)[number];

export interface AutomationMetricCondition {
  metric: string;
  comparator: string;
  threshold: number;
  window: string;
  graph?: string;
}

/**
 * A matcher on the OCCURRENCE rather than the member: the value at `payloadPath`
 * in the event body equals `value`. Equality only — ordering arbitrary JSON is a
 * meaning this contract does not have (docs/27 §1).
 */
export interface AutomationPayloadCondition {
  payloadPath: string;
  comparator: 'eq';
  value: string | number | boolean | null;
}

export type AutomationCondition = AutomationMetricCondition | AutomationPayloadCondition;

export function isAutomationPayloadCondition(
  condition: AutomationCondition,
): condition is AutomationPayloadCondition {
  return 'payloadPath' in condition;
}

/** An action is `{ type, ...config }`, exactly as the API stores it. */
export interface AutomationAction {
  type: string;
  [key: string]: unknown;
}

/** Narrow a rule's stored `conditions` column to something renderable. */
export function toAutomationConditions(value: unknown): AutomationCondition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AutomationCondition[] => {
    const row = asRecord(item);
    if (!row) return [];
    if (typeof row.payloadPath === 'string') {
      const raw = row.value;
      const literal =
        typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? raw : null;
      return [{ payloadPath: row.payloadPath, comparator: 'eq', value: literal }];
    }
    if (typeof row.metric !== 'string') return [];
    return [
      {
        metric: row.metric,
        comparator: asString(row.comparator, 'gte'),
        threshold: asNumber(row.threshold) ?? 0,
        window: asString(row.window, 'lifetime'),
        graph: typeof row.graph === 'string' ? row.graph : undefined,
      },
    ];
  });
}

/** Narrow a rule's stored `actions` column; rows without a type are dropped. */
export function toAutomationActions(value: unknown): AutomationAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AutomationAction[] => {
    const row = asRecord(item);
    if (!row || typeof row.type !== 'string') return [];
    return [{ ...row, type: row.type }];
  });
}

export interface AutomationRule {
  id: string;
  code: string;
  name: string;
  triggerEvent: string;
  /** JSON columns — narrow with `toAutomationConditions()` / `toAutomationActions()`. */
  conditions: unknown;
  actions: unknown;
  priority: number;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The rules, with the currency their money-valued thresholds are quoted in —
 * the same shape `/ranks` uses, so nothing has to infer one from elsewhere.
 */
export interface AutomationRulesResponse {
  rules: AutomationRule[];
  currency: string;
}

export interface AutomationRuleResponse {
  rule: AutomationRule;
}

export interface AutomationExecution {
  id: string;
  ruleId: string;
  /** The outbox event that fired it; `(ruleId, eventId)` is unique. */
  eventId: string;
  memberId: string | null;
  status: string;
  result: unknown;
  error: string | null;
  createdAt: string;
  rule?: { code: string; name: string; triggerEvent: string };
}

export interface AutomationExecutionsResponse {
  executions: AutomationExecution[];
}

/** One action as the execution recorded it. */
export interface ExecutionActionOutcome {
  type: string;
  status: string;
  error: string | null;
}

export interface ExecutionResult {
  eventName: string | null;
  /** Why a matching rule did not run; only set on a skipped execution. */
  skippedBecause: string | null;
  actions: ExecutionActionOutcome[];
}

/**
 * Narrow an execution's `result` column. It is written when the execution
 * settles and never recomputed, so this only reads — an explanation derived
 * here would be an explanation of nothing.
 */
export function toExecutionResult(value: unknown): ExecutionResult {
  const row = asRecord(value);
  const actions = Array.isArray(row?.actions) ? row.actions : [];
  return {
    eventName: typeof row?.eventName === 'string' ? row.eventName : null,
    skippedBecause: typeof row?.skippedBecause === 'string' ? row.skippedBecause : null,
    actions: actions.flatMap((item): ExecutionActionOutcome[] => {
      const action = asRecord(item);
      if (!action || typeof action.type !== 'string') return [];
      return [
        {
          type: action.type,
          status: asString(action.status, 'success'),
          error: typeof action.error === 'string' ? action.error : null,
        },
      ];
    }),
  };
}

/**
 * Reward types (docs/27 §2). `cash` is on the list and is still only ever
 * RECORDED — paying is compensation's job, so every screen that shows one says
 * so beside it.
 */
export const REWARD_TYPES = [
  'points',
  'badge',
  'course_access',
  'coupon',
  'membership_upgrade',
  'product',
  'event_ticket',
  'recognition',
  'certificate',
  'cash',
] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

/** The types that DO something on the platform; the rest are recorded grants. */
const FULFILLED_REWARD_TYPES: readonly string[] = ['points', 'badge', 'course_access', 'coupon'];

export function isFulfilledRewardType(type: string): boolean {
  return FULFILLED_REWARD_TYPES.includes(type);
}

const REWARD_TYPE_KEYS: Record<string, string> = {
  points: 'typePoints',
  badge: 'typeBadge',
  course_access: 'typeCourseAccess',
  coupon: 'typeCoupon',
  membership_upgrade: 'typeMembershipUpgrade',
  product: 'typeProduct',
  event_ticket: 'typeEventTicket',
  recognition: 'typeRecognition',
  certificate: 'typeCertificate',
  cash: 'typeCash',
};

/** `myRewards.type*` message key, or null when this build has no wording for it. */
export function rewardTypeKey(type: string): string | null {
  return REWARD_TYPE_KEYS[type] ?? null;
}

export interface RewardDefinition {
  id: string;
  code: string;
  name: string;
  type: string;
  /** Type-specific JSON — narrow with `toRewardConfig()`. */
  config: unknown;
  status: string;
  createdAt?: string;
}

export interface RewardDefinitionsResponse {
  definitions: RewardDefinition[];
}

export interface RewardDefinitionResponse {
  definition: RewardDefinition;
}

/**
 * A reward definition's config, read for display. `coupon.value` is a
 * percentage when the kind is `percent` and MINOR units of `currency` when it
 * is `fixed`; `points` is a count and is never divided.
 */
export interface RewardConfigView {
  points: number | null;
  badgeCode: string | null;
  courseId: string | null;
  coupon: {
    kind: string;
    value: number;
    currency: string | null;
    minSubtotalMinor: number | null;
  } | null;
}

export function toRewardConfig(value: unknown): RewardConfigView {
  const row = asRecord(value);
  const kind = typeof row?.kind === 'string' ? row.kind : null;
  const couponValue = asNumber(row?.value);
  return {
    points: asNumber(row?.points),
    badgeCode: typeof row?.badgeCode === 'string' ? row.badgeCode : null,
    courseId: typeof row?.courseId === 'string' ? row.courseId : null,
    coupon:
      kind && couponValue !== null
        ? {
            kind,
            value: couponValue,
            currency: typeof row?.currency === 'string' ? row.currency : null,
            minSubtotalMinor: asNumber(row?.minSubtotalMinor),
          }
        : null,
  };
}

/**
 * A grant is revocable and never deleted: `status = 'revoked'` keeps the history
 * of what was given and taken back (docs/27 §2).
 */
export interface RewardGrant {
  id: string;
  rewardId: string;
  memberId: string;
  /** `automation` | `manual`. */
  sourceType: string;
  /** The rule code for an automated grant; the actor for a manual one. */
  sourceRef: string | null;
  status: string;
  grantedAt: string;
  revokedAt: string | null;
  metadata?: unknown;
  reward: { code: string; name: string; type: string };
  /** Named on the tenant-wide list; a member's own grants do not repeat them. */
  member?: { displayName: string };
}

export interface RewardGrantsResponse {
  grants: RewardGrant[];
}

export interface RewardGrantResponse {
  grant: RewardGrant;
}
