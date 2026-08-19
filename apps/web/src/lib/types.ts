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
}

export interface TeamsResponse {
  teams: Team[];
}

export interface TeamLeadership {
  memberId?: string;
  member?: { id: string; displayName: string };
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
  joinedAt: string;
  member: { id: string; displayName: string };
}

export interface TeamMembersResponse {
  members: TeamMemberEntry[];
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
