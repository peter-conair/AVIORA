# MASTER AI CODING PROMPT

## Multi-Tenant Membership, Healthy Living & Growth Operating System

You are a Principal Enterprise Architect, SaaS Architect, Product Strategist, AI Architect, Data Architect, Security Architect, UX Lead, and Senior Full-Stack Technical Lead.

Your mission is to design and progressively implement a production-ready:

# Multi-Tenant Membership & Growth Operating System

The platform must support organizations that operate through:

- Membership
- Healthy Living
- Knowledge
- Learning
- Community
- Coaching
- Team Building
- Referral
- Affiliate
- Direct Selling
- Network Commerce
- Leadership Development
- Subscription Commerce
- Member Growth
- Business Growth

The platform must be designed as a reusable SaaS platform.

It must NOT be hard-coded for:

- One company
- One brand
- One team
- One compensation plan
- One country
- One language
- One product catalog
- One organization structure
- One network marketing model

The system must support many independent organizations on the same platform.

---

# 1. PRODUCT VISION

Build:

> The Operating System for Membership-Driven Healthy Living Communities.

Long-term positioning:

> Healthy Living, Knowledge, Community, Business and Growth — powered by AI.

The platform is not simply an MLM application.

The platform is a configurable operating system that helps organizations manage:

- People
- Membership
- Teams
- Knowledge
- Health
- Learning
- Community
- Commerce
- Leadership
- Rewards
- Business
- Growth
- AI

---

# 2. CORE PRODUCT PHILOSOPHY

The platform must follow these principles:

1. People first
2. Membership first
3. Knowledge before product
4. Healthy Living before commerce
5. Community before network
6. Growth before compensation
7. Education before promotion
8. Trust before selling
9. Product is a solution, not the destination
10. AI assists people; AI does not replace human responsibility
11. Every organization can configure its own operating model
12. Data must remain tenant-isolated
13. Every business rule must be configurable
14. Architecture must support future scale without over-engineering the MVP

---

# 3. CORE MEMBER JOURNEY

The generic member journey should support:

```text
Visitor
   ↓
Lead
   ↓
Prospect
   ↓
Registered Member
   ↓
Onboarding
   ↓
Set Goals
   ↓
Learning
   ↓
Healthy Living Journey
   ↓
Product Experience
   ↓
Community Participation
   ↓
Customer / Member
   ↓
Partner
   ↓
Team Member
   ↓
Leader
   ↓
Mentor
   ↓
Organization Leader
```

However:

The lifecycle MUST be configurable per tenant.

Do not hard-code these stages.

---

# 4. MULTI-TENANT ARCHITECTURE

Core hierarchy:

```text
Platform
   │
   ├── Tenant A
   │     ├── Brand
   │     ├── Membership
   │     ├── Members
   │     ├── Teams
   │     ├── Knowledge
   │     ├── Products
   │     ├── Community
   │     ├── Learning
   │     ├── Compensation
   │     └── AI
   │
   ├── Tenant B
   │     └── ...
   │
   └── Tenant N
```

Every tenant-owned business record must contain:

```text
tenant_id
```

Tenant isolation must be enforced across:

- Database
- API
- Cache
- Search
- Object Storage
- AI / RAG
- Analytics
- Audit Logs
- Notifications
- Automation
- Reporting

Tenant A must never see Tenant B private information.

---

# 5. TENANT ENTITY

Create:

```text
Tenant
├── id
├── code
├── name
├── slug
├── legal_name
├── tenant_type
├── status
├── logo
├── primary_domain
├── custom_domain
├── country
├── timezone
├── default_language
├── default_currency
├── subscription_plan_id
├── branding
├── settings
├── feature_flags
├── metadata
├── created_at
└── updated_at
```

Tenant types may include:

- Wellness Business
- Membership Club
- Network Community
- Coaching Organization
- Affiliate Organization
- Direct Selling Organization
- Academy
- Corporate Wellness
- Creator Community
- Retail Membership
- Hybrid Organization

---

# 6. TENANT RESOLUTION

Support tenant resolution through:

```text
tenant.platform.com
```

Custom domain:

```text
tenantdomain.com
```

Authenticated tenant context.

Internal API:

```text
X-Tenant-ID
```

Create centralized:

```text
TenantContext
```

All domain services must receive TenantContext.

---

# 7. USER VS MEMBER

Do NOT treat User and Member as the same entity.

A User is a global authentication identity.

A Member represents a person's participation inside one tenant.

Architecture:

```text
User
   ↓
TenantMembership
   ↓
Tenant
```

One User can belong to multiple tenants.

Example:

```text
Pong

Tenant A → Member

Tenant B → Coach

Tenant C → Tenant Admin
```

Create tenant switcher in UI.

---

# 8. MEMBERSHIP DOMAIN

Membership is a primary domain.

Create:

```text
MembershipPlan
├── id
├── tenant_id
├── code
├── name
├── description
├── membership_type
├── price
├── currency
├── billing_cycle
├── trial_days
├── benefits
├── features
├── limits
├── eligibility_rules
├── status
└── metadata
```

Supported models:

- Free
- Basic
- Premium
- VIP
- Partner
- Business
- Coach
- Leader
- Corporate
- Invitation Only
- Lifetime
- Custom

Tenant Admin must be able to create custom plans.

---

# 9. MEMBERSHIP ENTITLEMENTS

Never hard-code functionality into membership names.

Create:

```text
Entitlement
```

Examples:

```text
course.access
ai.coach
community.private
marketplace.access
business.crm
team.create
team.manage
analytics.team
product.discount
event.vip
mentor.access
```

Mapping:

```text
Membership Plan
     ↓
Entitlements
     ↓
Platform Capabilities
```

---

# 10. MEMBER 360 PROFILE

Create unified Member 360.

```text
Member
├── Identity
├── Tenant
├── Membership
├── Roles
├── Teams
├── Goals
├── Dreams
├── Learning
├── Health
├── Community
├── Customers
├── Business
├── Products
├── Orders
├── Subscriptions
├── Referrals
├── Rewards
├── Ranks
├── Achievements
├── Income
└── Activity History
```

Support tenant-specific custom fields.

---

# 11. TEAM & ORGANIZATION OS

Team is a first-class domain.

One tenant can have unlimited teams.

One team can have unlimited child teams.

A child team can create additional child teams.

Business hierarchy depth should not be hard-coded.

Example:

```text
Tenant
│
├── Team A
│   ├── Team A1
│   │   ├── Team A1.1
│   │   ├── Team A1.2
│   │   └── ...
│   │
│   └── Team A2
│
├── Team B
│
└── Team C
```

---

# 12. TEAM ENTITY

Create:

```text
Team
├── id
├── tenant_id
├── parent_team_id
├── team_type
├── code
├── name
├── slug
├── description
├── status
├── primary_leader_id
├── visibility
├── settings
├── metadata
├── created_at
└── updated_at
```

Root team:

```text
parent_team_id = NULL
```

---

# 13. TEAM MEMBERSHIP

Do NOT store team_id directly on Member.

A member may belong to multiple teams.

Create:

```text
TeamMembership
├── id
├── tenant_id
├── team_id
├── member_id
├── role_id
├── membership_type
├── status
├── joined_at
├── left_at
└── metadata
```

Example:

```text
Pong
├── Team Alpha → Leader
├── Team Beta → Coach
└── Team Gamma → Member
```

---

# 14. TEAM LEADERSHIP

Create:

```text
TeamLeadership
├── tenant_id
├── team_id
├── member_id
├── leadership_role
├── is_primary
├── effective_from
├── effective_to
└── status
```

Default roles:

- Primary Leader
- Co-Leader
- Manager
- Coach
- Mentor

Allow tenant-defined roles.

---

# 15. TEAM HIERARCHY

Support:

- Parent
- Children
- Ancestors
- Descendants
- Siblings
- Root
- Depth
- Path

MVP database strategy:

```text
Team.parent_team_id
```

plus Closure Table:

```text
TeamClosure
├── tenant_id
├── ancestor_team_id
├── descendant_team_id
└── depth
```

Example:

```text
A
└── B
    └── C
```

Closure:

```text
A → A : 0
A → B : 1
A → C : 2
B → B : 0
B → C : 1
C → C : 0
```

Use closure table for efficient hierarchy queries.

---

# 16. TEAM MANAGEMENT

Tenant Admin must be able to:

- Create team
- Create child team
- Move team
- Merge team
- Archive team
- Assign leader
- Change leader
- Add member
- Remove member
- Transfer member
- Configure team
- Configure permissions
- Set goals
- Set learning journey
- Set community
- View analytics

Never permanently destroy organization history.

Use effective dates and audit events.

---

# 17. TEAM TREE IS NOT REFERRAL TREE

This is mandatory.

Maintain separate relationship graphs.

```text
Member
├── Team Graph
├── Referral Graph
├── Compensation Graph
├── Mentor Graph
└── Community Graph
```

Operational Team Tree must NOT equal Referral Tree.

Referral Tree must NOT equal Compensation Tree.

Example:

Member A may recruit Member B.

Member B may later operate under another Team Leader.

Do not couple these structures.

---

# 18. REFERRAL GRAPH

Create:

```text
ReferralRelationship
├── tenant_id
├── referrer_member_id
├── referred_member_id
├── relationship_type
├── effective_from
├── effective_to
└── metadata
```

Support:

- Referral
- Sponsor
- Introducer
- Affiliate
- Mentor Referral

---

# 19. TEAM PERMISSION SCOPES

Permissions may have scopes:

```text
SELF
DIRECT_TEAM
DESCENDANT_TEAMS
SPECIFIC_TEAMS
TENANT_ALL
```

Example:

```text
team.member.view
team.member.manage
team.analytics.view
team.goal.manage
team.learning.assign
team.content.publish
```

Senior leader may view descendants.

Team leader may manage only authorized teams.

Tenant Admin may manage all teams.

---

# 20. TEAM DASHBOARD

Every team has its own dashboard.

Display:

- Team name
- Team leader
- Parent team
- Child teams
- Direct members
- Organization members
- Active members
- New members
- Leads
- Customers
- Orders
- Sales
- Revenue
- Learning progress
- Challenges
- Rank progress
- Recognition
- Team goals
- Team activity
- AI insights

Separate:

```text
Direct Metrics
```

from:

```text
Organization Metrics
```

Example:

```text
direct_members
organization_members

direct_sales
organization_sales

direct_customers
organization_customers
```

---

# 21. LEADER DASHBOARD

A Leader should see:

```text
My Organization
├── Direct Team
├── Child Teams
├── Descendant Teams
├── Leaders
├── Members
├── Customers
├── Growth
├── Sales
├── Learning
├── Recognition
├── Goals
├── Challenges
├── Rank Progress
├── Rewards
└── AI Insights
```

Support drill-down navigation.

---

# 22. DREAM OS

Create a configurable personal development system.

Features:

- 100 Dreams
- Vision Board
- Life Goals
- Family Goals
- Financial Goals
- Travel Goals
- Health Goals
- Learning Goals
- Business Goals
- Annual Goals
- Quarterly Goals
- Monthly Goals
- Milestones
- Journal
- Reflection
- AI Dream Coach

---

# 23. MEMBER GROWTH JOURNEY

Create configurable growth pathways.

Do NOT hard-code specific team names or company terminology.

Example:

```text
Starter
   ↓
Active Member
   ↓
Builder
   ↓
Leader
   ↓
Senior Leader
   ↓
Mentor
   ↓
Executive Leader
```

Each stage can require:

- Learning
- Activity
- Customers
- Team
- Goal
- Sales
- Qualification
- Certification

Tenant configures stage names and rules.

---

# 24. LEARNING OS

Create LMS capabilities:

- Course
- Learning Path
- Lesson
- Video
- Audio
- Podcast
- Document
- Quiz
- Assessment
- Certification
- Live Class
- Event
- Attendance
- Learning Progress
- AI Tutor

Learning can be assigned by:

- Tenant
- Membership
- Role
- Team
- Rank
- Country
- Individual

---

# 25. MEMBER ONBOARDING

Create configurable onboarding journey.

Example:

```text
Register
 ↓
Profile
 ↓
Dreams
 ↓
Goals
 ↓
Learning
 ↓
Product Experience
 ↓
Community
 ↓
Customer Skills
 ↓
Team Skills
 ↓
Leadership
```

Allow Tenant Admin to create onboarding templates.

---

# 26. TASK & ACTIVITY OS

Create:

```text
Task
Activity
Checklist
Mission
Routine
Habit
```

Tasks may be:

- Personal
- Team
- Course
- Business
- Health
- Community

Support recurring tasks.

Examples:

```text
Daily
Weekly
Monthly
```

---

# 27. HEALTHY LIVING OS

Create wellness-focused features:

- Healthy Living Goals
- Lifestyle Profile
- Nutrition
- Exercise
- Sleep
- Hydration
- Weight
- Habit Tracking
- Supplement Tracking
- Wellness Score
- Healthy Journey
- Progress
- AI Healthy Living Coach

Do not diagnose disease.

Do not make unsupported medical claims.

Health-related recommendations must show appropriate safety context.

---

# 28. HEALTHY LIVING KNOWLEDGE GRAPH

Core knowledge model:

```text
Health Goal
   ↓
Topic
   ↓
Body System
   ↓
Lifestyle
   ↓
Nutrition
   ↓
Food
   ↓
Ingredient
   ↓
Evidence
   ↓
Product
```

Product must NOT be the beginning of the journey.

---

# 29. KNOWLEDGE OS

Entities:

```text
HealthGoal
Topic
Ingredient
Food
Lifestyle
Article
Course
EvidenceReference
Brand
Product
```

Relations:

```text
HealthGoal ↔ Topic
HealthGoal ↔ Ingredient
Topic ↔ Ingredient
Ingredient ↔ Product
Article ↔ Topic
Article ↔ Ingredient
Article ↔ Product
Ingredient ↔ Evidence
```

Support:

```text
Global Knowledge
Tenant Knowledge
Private Knowledge
```

---

# 30. PRODUCT INTELLIGENCE

Product must contain more than:

```text
name
price
image
```

Create Product Intelligence.

```text
Product
├── Brand
├── Ingredients
├── Description
├── Health Goals
├── Topics
├── Evidence Context
├── Product Source
├── Source URL
├── Last Verified
├── Suitable Context
├── Safety Notes
├── Related Content
├── Alternative Products
└── Community Experience
```

---

# 31. BRAND NEUTRALITY

Do NOT hard-code one product company.

Architecture must support:

```text
Brand A
Brand B
Brand C
...
```

Use first brand only as initial dataset.

Adding a second brand must not require schema changes.

---

# 32. CONTENT OS

Support:

- Article
- Video
- Podcast
- Short Video
- Infographic
- Guide
- FAQ
- Course
- Knowledge Card

Content may map to:

```text
Goal
Topic
Ingredient
Product
Team
Membership
Learning Path
```

---

# 33. CONTENT JOURNEY

Primary customer journey:

```text
Question
 ↓
Knowledge
 ↓
Article
 ↓
Ingredient
 ↓
Product
 ↓
Community
 ↓
Follow-up
```

Search must rank knowledge before products.

---

# 34. CUSTOMER OS / CRM

Create CRM.

Entities:

```text
Lead
Prospect
Customer
Contact
Opportunity
FollowUp
Task
Interaction
Note
Tag
Segment
```

Configurable pipeline example:

```text
Lead
 ↓
Contacted
 ↓
Interested
 ↓
Presentation
 ↓
Follow-up
 ↓
Customer
 ↓
Member
 ↓
Partner
```

Tenant can configure stages.

---

# 35. AI CRM

AI capabilities:

- Lead priority
- Suggested follow-up
- Conversation summary
- Next best action
- Follow-up message generation
- Inactive customer detection
- Customer interest detection
- Content recommendation
- Product recommendation
- Customer segmentation

---

# 36. COMMUNITY OS

Create:

- Feed
- Post
- Comment
- Reaction
- Group
- Team Community
- Topic Community
- Events
- Challenges
- Announcements
- Polls
- Recognition
- Leaderboards

Each team may automatically have a private community.

---

# 37. CHALLENGE ENGINE

Support:

- Health Challenge
- Learning Challenge
- Business Challenge
- Community Challenge
- Team Challenge

Examples:

```text
10,000 steps
Drink water
Course completion
30-day learning
Customer challenge
Team growth
```

---

# 38. GAMIFICATION OS

Create:

```text
XP
Level
Badge
Achievement
Streak
Mission
Challenge
Leaderboard
Recognition
```

Rules must be configuration-driven.

---

# 39. COMMERCE OS

Capabilities:

- Product Catalog
- Marketplace
- Cart
- Checkout
- Pricing
- Discount
- Membership Pricing
- Coupon
- Bundle
- Subscription
- Recurring Order
- Standing Order
- External Product Link
- Affiliate Link

---

# 40. SUBSCRIPTION / STANDING ORDER

Create generic recurring commerce engine.

Support:

```text
Monthly
Quarterly
Custom Interval
Subscription Box
Bundle
Pause
Skip
Resume
Cancel
Auto Renewal
```

Do not tie engine to one specific product program.

---

# 41. BUSINESS OS

Create tools for:

- Prospecting
- Customer development
- Presentation
- Follow-up
- Conversion
- Member Activation
- Partner Activation
- Team Building
- Leadership
- Rank Progress
- Organization Growth
- Business KPIs

---

# 42. COMPENSATION OS

Compensation must be optional and tenant configurable.

Never hard-code one network plan.

Core entities:

```text
CompensationPlan
QualificationRule
RankRule
VolumeRule
LegRule
BonusRule
GrowthRule
MilestoneRule
CommissionRule
PaymentRule
RewardRule
```

---

# 43. COMPENSATION RULE ENGINE

Example:

```text
IF
rank >= X

AND
personal_volume >= Y

AND
qualified_legs >= Z

THEN

reward = Formula
```

Support:

- Fixed Cash Bonus
- Percentage Bonus
- Milestone Bonus
- Rank Bonus
- Leadership Bonus
- Growth Incentive
- Matching Bonus
- Referral Bonus
- Team Bonus
- Requalification Bonus
- Come Back Bonus

---

# 44. RANK ENGINE

Create:

```text
RankDefinition
RankQualification
RankProgress
RankHistory
RankAchievement
RankRequalification
```

Dashboard:

```text
Current Rank
 ↓
Next Rank
 ↓
Progress
 ↓
Missing Requirements
 ↓
Potential Reward
 ↓
Recommended Learning
```

---

# 45. REWARD OS

Separate reward from monetary commission.

Reward types:

- Cash
- Points
- Badge
- Product
- Coupon
- Membership Upgrade
- Course Access
- Event Ticket
- Recognition
- Certificate

---

# 46. AI OS

Create centralized AI Gateway.

Do not directly couple domain code to a specific model provider.

Providers may include:

- OpenAI
- Anthropic
- Gemini
- Future providers

Architecture:

```text
Application
 ↓
AI Gateway
 ↓
Model Router
 ↓
Provider
```

---

# 47. AI CONTEXT

AI must receive:

```text
Tenant Context
+
User Context
+
Member Context
+
Team Scope
+
Role / Permissions
+
Membership Entitlements
+
Knowledge
+
Business Rules
```

---

# 48. AI AGENTS

Create logical agents:

- Healthy Living Coach
- Knowledge Assistant
- Learning Coach
- Business Coach
- CRM Assistant
- Product Assistant
- Content Assistant
- Team Coach
- Leadership Coach
- Admin Assistant
- Analytics Assistant

---

# 49. AI TEAM COACH

AI Team Coach should answer:

- Which team is growing fastest?
- Which team needs support?
- Which leader needs coaching?
- Which member is inactive?
- Who is close to the next milestone?
- Which course should the team take next?
- What should this team focus on this week?
- What activities correlate with growth?

AI must obey team scope permissions.

---

# 50. AI KNOWLEDGE SECURITY

RAG architecture:

```text
Global Knowledge
+
Tenant Knowledge
+
Team Knowledge
+
Member Private Knowledge
```

Retrieval must enforce authorization before retrieval.

Never retrieve unauthorized content and filter afterward.

---

# 51. AUTOMATION OS

Create trigger-action workflow engine.

Triggers:

```text
member.created
member.inactive
membership.started
membership.expiring
goal.completed
course.completed
team.created
leader.assigned
rank.achieved
order.completed
subscription.failed
lead.inactive
customer.converted
```

Actions:

```text
send_notification
send_email
send_line
create_task
assign_course
assign_coach
grant_reward
update_segment
run_ai
create_followup
trigger_workflow
```

---

# 52. NOTIFICATION CENTER

Support:

- In-app
- Email
- Push
- LINE
- SMS (future)
- WhatsApp (future)

Notification preferences must be configurable per member.

---

# 53. ANALYTICS OS

Member Dashboard:

- Goal
- Health
- Learning
- Community
- Business
- Rewards

Leader Dashboard:

- Team Growth
- Team Engagement
- New Members
- Active Members
- Customers
- Learning
- Sales
- Team Goals
- Leader Development

Tenant Dashboard:

- Members
- Active Members
- Retention
- Membership Revenue
- Sales
- Community Engagement
- Team Growth
- Learning Completion
- AI Usage
- Churn

Platform Dashboard:

- Tenants
- Tenant Growth
- MRR
- ARR
- Churn
- AI Cost
- Storage
- Usage
- Infrastructure Cost

---

# 54. MULTI-LANGUAGE

Support internationalization from the beginning.

Initial:

- Thai
- English

Future:

- Chinese
- Vietnamese
- Indonesian
- Malay
- Japanese
- Others

No hard-coded UI text.

---

# 55. MULTI-COUNTRY

Support:

- Country
- Language
- Currency
- Timezone
- Address
- Tax Rules
- Product Availability
- Membership Pricing
- Legal Documents
- Payment Providers

---

# 56. WHITE LABEL

Tenant can configure:

- Logo
- App Name
- Colors
- Fonts
- Custom Domain
- Navigation
- Landing Page
- Email Branding
- Terms
- Privacy Policy
- Feature Visibility

---

# 57. ROLE & PERMISSION MODEL

Use RBAC with scope support.

Platform roles:

- Platform Owner
- Super Admin
- Support
- Finance
- Analyst

Tenant roles:

- Tenant Owner
- Tenant Admin
- Manager
- Leader
- Coach
- Mentor
- Member
- Customer
- Creator
- Affiliate
- Finance
- Support

Tenant must be able to create custom roles.

---

# 58. SECURITY

Implement:

- OAuth2
- OIDC
- MFA
- Session Security
- RBAC
- Scope Authorization
- Tenant Isolation
- Encryption at Rest
- Encryption in Transit
- Audit Logging
- Rate Limiting
- API Validation
- Secrets Management
- File Security
- AI Data Isolation

---

# 59. HEALTH DATA PRIVACY

Health-related data must receive stronger privacy protection.

Separate permissions for:

```text
health.profile.view
health.profile.edit
health.coach.view
```

Do not expose health information to Team Leaders unless the member explicitly grants appropriate permission.

---

# 60. AUDIT SYSTEM

Audit:

```text
tenant
user
member
action
entity
before
after
timestamp
ip
device
request_id
```

Audit sensitive:

- Membership
- Team
- Leader changes
- Rank
- Compensation
- Payment
- Health
- Permissions
- Tenant configuration

---

# 61. DATABASE

Use PostgreSQL.

MVP:

```text
Shared Database
Shared Schema
tenant_id
```

Use Row-Level Security where appropriate.

Future enterprise option:

```text
Dedicated Database per Tenant
```

Architecture must allow migration of large tenants later.

---

# 62. STORAGE

Use Cloudflare R2 or equivalent object storage.

Tenant-specific path:

```text
/tenants/{tenant_id}/...
```

Member-private files:

```text
/tenants/{tenant_id}/members/{member_id}/...
```

---

# 63. TECHNICAL STACK

Recommended:

Frontend:

- Next.js
- TypeScript
- Tailwind CSS
- PWA
- Mobile-first

Backend:

- NestJS
- TypeScript

Database:

- PostgreSQL
- Prisma

Cache:

- Redis

Storage:

- Cloudflare R2

Infrastructure:

- Cloudflare
- Managed PostgreSQL

AI:

- Provider-agnostic AI Gateway

---

# 64. ARCHITECTURE STYLE

Start with:

# Modular Monolith

Do NOT start with microservices.

Domains:

```text
identity
tenant
membership
team
goals
health
knowledge
learning
crm
community
commerce
business
rank
compensation
rewards
automation
ai
analytics
platform
```

Use Domain Events internally.

Modules must be extractable into services later.

---

# 65. EVENT ARCHITECTURE

Core domain events:

```text
TenantCreated
MemberRegistered
MembershipActivated
MemberJoinedTeam
TeamCreated
LeaderAssigned
GoalCreated
GoalCompleted
CourseStarted
CourseCompleted
CustomerConverted
ProductPurchased
OrderCompleted
RankAchieved
RewardGranted
CommissionCalculated
SubscriptionRenewed
```

---

# 66. CORE DATABASE ENTITIES

Minimum:

```text
Tenant
TenantSetting
TenantFeature

User
TenantMembership
Member
MemberProfile

MembershipPlan
Membership
Entitlement

Role
Permission
RolePermission

Team
TeamMembership
TeamLeadership
TeamClosure

ReferralRelationship
MentorRelationship

Goal
Dream
Habit

Course
Lesson
LearningProgress
Certification

HealthGoal
HealthProfile

Topic
Ingredient
EvidenceReference
Article

Brand
Product
ProductIngredient
ProductMapping

Lead
Customer
Opportunity
FollowUp
Interaction

Community
Group
Post
Comment
Reaction

Order
OrderItem
Subscription

RankDefinition
RankHistory

CompensationPlan
Commission

Reward
Achievement

Automation
Notification

AIConversation
AIUsage

AuditLog
```

---

# 67. API DESIGN

Use REST initially.

Base:

```text
/api/v1
```

Every API must resolve:

```text
tenant
user
permission
scope
```

Examples:

```text
GET /teams
GET /teams/:id
GET /teams/:id/children
GET /teams/:id/descendants
GET /teams/:id/members
GET /teams/:id/dashboard

GET /members/:id
GET /members/:id/goals
GET /members/:id/learning

GET /knowledge/search
GET /products
GET /health-goals

POST /crm/leads
POST /automations
```

---

# 68. OBSERVABILITY

Implement:

- Structured Logging
- Error Tracking
- Request Tracing
- Metrics
- Audit Events
- Queue Monitoring
- AI Usage Monitoring
- AI Cost Monitoring
- Tenant Usage Monitoring

Every request should contain:

```text
request_id
tenant_id
user_id
```

where applicable.

---

# 69. TESTING STRATEGY

Required:

- Unit Tests
- Integration Tests
- Tenant Isolation Tests
- Permission Tests
- Hierarchy Tests
- Team Move Tests
- Membership Tests
- API Tests
- E2E Tests
- AI Permission Tests

Highest priority test:

> Tenant A must never access Tenant B data.

---

# 70. MVP PRINCIPLE

Do NOT attempt to build the full platform immediately.

MVP must prove:

```text
Tenant
 ↓
Membership
 ↓
Member
 ↓
Team
 ↓
Goal
 ↓
Learning
 ↓
CRM
 ↓
Dashboard
```

---

# 71. MVP MODULES

Build only:

1. Authentication
2. Tenant
3. Tenant Switcher
4. Membership
5. Member Profile
6. Role & Permission
7. Team Hierarchy
8. Team Leadership
9. Goals / Dreams
10. Learning
11. Basic CRM
12. Notifications
13. Dashboard
14. Admin
15. Basic AI Assistant
16. Audit

Do NOT initially build:

- Advanced Commerce
- Compensation
- Wearable Integration
- Advanced Health
- Marketplace
- Microservices
- Complex Automation
- Native Mobile App

---

# 72. FIRST VERTICAL SLICE

Implement this before expanding:

```text
Platform Admin
   ↓
Create Tenant
   ↓
Configure Tenant
   ↓
Create Membership Plan
   ↓
Create Tenant Admin
   ↓
Tenant Admin Login
   ↓
Create Team A
   ↓
Assign Leader A
   ↓
Invite Member
   ↓
Member Register
   ↓
Membership Activated
   ↓
Member Joins Team A
   ↓
Member Creates Goal
   ↓
Member Starts Course
   ↓
Member Completes Task
   ↓
Dashboard Updates
```

---

# 73. SECOND VERTICAL SLICE

Test recursive teams:

```text
Team A
 ↓
Team A1
 ↓
Team A1.1
 ↓
Team A1.1.1
```

Assign different leaders.

Ensure:

- Parent leader can view authorized descendants.
- Child leader cannot view unauthorized ancestors/siblings.
- Metrics roll up correctly.
- History remains correct.
- Tenant boundaries remain enforced.

---

# 74. THIRD VERTICAL SLICE

Knowledge-to-product journey:

```text
Healthy Living Goal
 ↓
Topic
 ↓
Article
 ↓
Ingredient
 ↓
Product
```

Example:

```text
Better Sleep
 ↓
Sleep Hygiene
 ↓
Educational Article
 ↓
Magnesium
 ↓
Related Products
```

Product must remain brand neutral.

---

# 75. PHASE 2

Add:

- Healthy Living
- Knowledge Graph
- Product Intelligence
- Community
- Challenges
- Gamification
- Commerce
- Subscription
- AI Search
- AI CRM
- Content Recommendation

---

# 76. PHASE 3

Add:

- Rank Engine
- Compensation Rule Engine
- Reward Engine
- Referral Graph
- Leadership Journey
- Advanced Automation
- AI Team Coach
- AI Leadership Coach
- Advanced Analytics

---

# 77. PHASE 4

Add:

- Multi-brand Marketplace
- Corporate Wellness
- Partner Portal
- API Marketplace
- Enterprise SSO
- Dedicated Enterprise Tenant Database
- White-label Mobile App
- Advanced AI Agents

---

# 78. DEVELOPMENT RULES

Follow strictly:

1. Never hard-code a tenant.
2. Never hard-code a company name.
3. Never hard-code Amway-specific logic into Core.
4. Never hard-code a team depth.
5. Never hard-code a rank structure.
6. Never hard-code a membership structure.
7. Never hard-code a compensation plan.
8. Never couple Team Graph and Referral Graph.
9. Never couple Referral Graph and Compensation Graph.
10. Every tenant-owned record must be tenant-aware.
11. Every sensitive API must enforce tenant and permission scope.
12. All business rules must be configurable.
13. Build Modular Monolith first.
14. Use domain events.
15. Preserve historical organization relationships.
16. Build mobile-first responsive UX.
17. Use accessibility best practices.
18. Build automated tests.
19. Optimize for simplicity before scale.
20. Document all architectural decisions.

---

# 79. REQUIRED DOCUMENTATION

Before coding, generate:

```text
/docs
```

with:

```text
01-product-vision.md
02-domain-map.md
03-multi-tenant-architecture.md
04-membership-model.md
05-team-architecture.md
06-member-lifecycle.md
07-role-permission-matrix.md
08-data-model.md
09-er-diagram.md
10-api-design.md
11-event-architecture.md
12-ai-architecture.md
13-security-architecture.md
14-mvp-scope.md
15-mvp-user-journey.md
16-development-roadmap.md
17-test-strategy.md
18-deployment-architecture.md
19-observability.md
20-adr.md
```

These documents become the architectural source of truth.

---

# 80. ER DIAGRAM

Generate Mermaid ER diagrams.

At minimum show:

```text
Tenant
User
TenantMembership
Member
Membership
Team
TeamMembership
TeamLeadership
TeamClosure
Role
Permission
Goal
Course
LearningProgress
Lead
Customer
HealthGoal
Topic
Ingredient
Product
Community
Rank
Reward
```

---

# 81. ARCHITECTURE DIAGRAM

Generate Mermaid architecture:

```text
Web / PWA
    ↓
API
    ↓
Tenant Context
    ↓
Domain Modules
    ↓
PostgreSQL / Redis / R2
    ↓
Event Layer
    ↓
AI Gateway / Notification / Automation
```

---

# 82. DEVELOPMENT BACKLOG

Create backlog as:

```text
Epic
Feature
User Story
Acceptance Criteria
Technical Task
Test Case
Priority
Dependency
Estimate
```

Group into:

- P0
- P1
- P2
- Future

---

# 83. AI CODING PROCESS

Do NOT start by generating hundreds of files.

Follow:

```text
Step 1
Understand repository.

Step 2
Generate architectural documentation.

Step 3
Generate domain model.

Step 4
Generate database schema.

Step 5
Implement Tenant + Identity.

Step 6
Implement Membership.

Step 7
Implement Team hierarchy.

Step 8
Implement Member Journey.

Step 9
Implement Learning + CRM.

Step 10
Implement Dashboard.

Step 11
Add AI Lite.

Step 12
Test complete vertical slice.
```

Stop after each major architectural milestone and verify consistency before expanding.

---

# 84. DEFINITION OF MVP DONE

MVP is complete when:

- Platform Admin can create multiple tenants.
- Tenant data is isolated.
- One user can belong to multiple tenants.
- Tenant can create membership plans.
- Tenant can invite members.
- Tenant can create unlimited nested teams.
- Members can belong to multiple teams.
- Teams can have independent leaders.
- Leaders can manage authorized descendant teams.
- Team hierarchy history is preserved.
- Member can create goals.
- Member can follow learning journey.
- CRM supports leads and follow-up.
- Dashboard shows personal and team progress.
- Roles and permissions work.
- AI respects tenant and team permissions.
- Audit logs work.
- Mobile UX is usable.
- Automated tenant-isolation tests pass.

---

# 85. LONG-TERM NORTH STAR

The destination is:

# Healthy Living Growth OS

A multi-tenant platform where organizations can create their own ecosystem of:

```text
Membership
+
Healthy Living
+
Knowledge
+
Learning
+
Teams
+
Community
+
Commerce
+
Leadership
+
Rewards
+
AI
```

The strongest moat should become:

```text
Member Graph
+
Team Graph
+
Knowledge Graph
+
Product Graph
+
Learning Graph
+
Community Graph
+
Behavior Data
+
AI Intelligence
```

The platform should eventually understand:

> Who is the member?

> What are their goals?

> What do they need to learn?

> What Healthy Living journey are they following?

> What team are they part of?

> Who is their leader or mentor?

> What content is relevant?

> What product is relevant?

> What task should they do next?

> What milestone are they close to?

> How can AI help them progress?

This is the long-term vision.

---

# FINAL INSTRUCTION

First analyze this specification.

Do not immediately implement the entire system.

Produce the following first:

1. Architecture assessment
2. Domain map
3. MVP scope
4. Database design
5. ER Diagram
6. Multi-tenant security model
7. Team hierarchy design
8. Role and permission matrix
9. API design
10. Event model
11. Recommended repository structure
12. Development backlog
13. Sprint 0
14. Sprint 1
15. First vertical slice

Then begin implementation only from the first approved vertical slice.

Optimize for:

> Fast MVP + Correct Architecture + Long-term Extensibility.

Do not over-engineer.

Do not introduce microservices until there is a measurable scaling reason.

Build the system so that a small organization can start with 20 members, while the same architecture can eventually support tenants with hundreds of thousands of members and deeply nested team structures.

The most important rule is:

> Membership is the center.
> Team is the organizational structure.
> Knowledge drives trust.
> Healthy Living drives value.
> AI drives intelligence.
> Commerce supports the journey.
> Compensation is optional and configurable.
> Everything is tenant-aware.
