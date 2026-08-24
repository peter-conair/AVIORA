/**
 * Which mutating route writes which audit action (docs/16 MVP exit criteria).
 *
 * Hand-maintained, and honest about it: this file does NOT prove that a route
 * writes the row it claims — the per-module suites and `vertical-slice.e2e`
 * do that. What it does is make the set COMPLETE. `audit-coverage.spec.ts`
 * requires every mutating route to appear here or in that file's UNAUDITED list
 * with a reason, so a new mutation fails the build until somebody decides which
 * it is.
 *
 * That is the part a list alone cannot do. The failure mode of audit is
 * silence, and a list written once preserves silence perfectly.
 */
export const AUDITED_ROUTES = new Map<string, string>([
  // identity · tenant · membership
  ['POST /api/v1/platform/tenants', 'platform.tenant.create'],
  ['POST /api/v1/auth/register', 'auth.register'],
  // login writes auth.throttled on a REFUSAL only — a wrong password is not an
  // audit event, a caller past its budget is (docs/48 §6)
  ['POST /api/v1/auth/login', 'auth.throttled'],
  ['POST /api/v1/membership-plans', 'membership.plan.create'],
  ['PATCH /api/v1/membership-plans/:id', 'membership.plan.update'],
  ['POST /api/v1/invitations', 'member.invite'],
  ['POST /api/v1/invitations/:token/accept', 'member.register'],

  // learning — releasing training to individuals (docs/73 §9)
  ['POST /api/v1/learning/assignments', 'learning.assignment.assign'],
  ['POST /api/v1/learning/assignments/hold', 'learning.assignment.hold'],
  ['DELETE /api/v1/learning/assignments/:id', 'learning.assignment.withdraw'],
  ['POST /api/v1/learning/assets', 'learning.asset.upload'],
  ['POST /api/v1/learning/assets/external', 'learning.asset.link'],
  ['POST /api/v1/courses', 'learning.course.create'],
  ['PATCH /api/v1/courses/:id', 'learning.course.update'],
  ['POST /api/v1/courses/:id/lessons', 'learning.lesson.create'],

  // teams
  ['POST /api/v1/teams', 'team.create'],
  ['POST /api/v1/teams/:id/leaders', 'team.leader.assign'],
  ['POST /api/v1/teams/:id/members', 'team.member.join'],
  ['PATCH /api/v1/teams/:id/move', 'team.move'],

  // goals · crm
  ['POST /api/v1/goals', 'goal.create'],
  ['PUT /api/v1/goals/business', 'goal.business.set'],
  ['PATCH /api/v1/ranks/:id', 'growth.rank.update'],
  ['POST /api/v1/tracker/sheets/:code/entries', 'tracker.entry.add'],
  // Registers only when AVIORA_DEV_LOGIN=true, which is a local .env thing —
  // so this sweep never saw it on CI, and the route went undeclared from the
  // day it was written. It DOES audit; it had simply never been listed.
  ['POST /api/v1/dev/login', 'auth.dev_login'],
  ['PUT /api/v1/crm/customers/:id/card', 'crm.customer.card'],
  ['POST /api/v1/crm/customers/:id/id-number', 'crm.customer.id_number.read'],
  ['POST /api/v1/crm/customers/:id/photo-consent', 'crm.consent.grant'],
  ['DELETE /api/v1/crm/customers/:id/photo-consent', 'crm.consent.revoke'],
  ['POST /api/v1/crm/customers/:id/photos', 'crm.photo.upload'],
  ['DELETE /api/v1/photos/:id', 'crm.photo.delete'],
  ['POST /api/v1/crm/leads', 'crm.lead.create'],
  ['PATCH /api/v1/crm/leads/:id', 'crm.lead.update'],
  ['PATCH /api/v1/crm/leads/:id/scores', 'crm.lead.score'],
  ['POST /api/v1/crm/leads/:id/convert', 'crm.lead.convert'],
  ['POST /api/v1/crm/follow-ups', 'crm.followup.create'],
  ['POST /api/v1/crm/stages', 'crm.stage.create'],

  // health — the GRANTS and the profile, never the readings themselves
  ['POST /api/v1/health/grants/:granteeMemberId', 'health.grant.create'],
  ['DELETE /api/v1/health/grants/:granteeMemberId', 'health.grant.revoke'],
  ['PUT /api/v1/health/me', 'health.profile.update'],

  // challenges
  ['POST /api/v1/challenges', 'challenge.create'],
  ['POST /api/v1/challenges/:id/join', 'challenge.join'],

  // commerce
  ['POST /api/v1/offerings', 'commerce.offering.create'],
  ['PATCH /api/v1/offerings/:id', 'commerce.offering.update'],
  ['PUT /api/v1/offerings/:id/plan-price', 'commerce.offering.planPrice'],
  ['POST /api/v1/coupons', 'commerce.coupon.create'],
  ['POST /api/v1/cart/checkout', 'commerce.order.place'],
  ['POST /api/v1/orders/:id/cancel', 'commerce.order.cancel'],
  ['POST /api/v1/orders/:id/payments', 'commerce.order.payment'],
  ['POST /api/v1/subscriptions/:id/cancel', 'commerce.subscription.cancel'],
  ['POST /api/v1/subscriptions/:id/pause', 'commerce.subscription.pause'],
  ['POST /api/v1/subscriptions/:id/resume', 'commerce.subscription.resume'],
  ['POST /api/v1/subscriptions/:id/skip', 'commerce.subscription.skip'],
  ['PUT /api/v1/tax/rules', 'commerce.tax.upsert'],

  // growth · compensation
  ['POST /api/v1/ranks', 'growth.rank.create'],
  ['POST /api/v1/ranks/evaluate', 'growth.rank.evaluate'],
  ['POST /api/v1/referrals', 'growth.referral.create'],
  ['DELETE /api/v1/referrals/:id', 'growth.referral.end'],
  ['POST /api/v1/compensation/plans', 'compensation.plan.create'],
  ['POST /api/v1/compensation/plans/:id/rules', 'compensation.rule.create'],
  ['POST /api/v1/compensation/runs', 'compensation.run.create'],
  ['POST /api/v1/compensation/runs/:id/approve', 'compensation.run.approve'],
  ['POST /api/v1/compensation/runs/:id/recompute', 'compensation.run.recompute'],
  ['POST /api/v1/compensation/graph', 'compensation.placement.create'],
  ['DELETE /api/v1/compensation/graph/:id', 'compensation.placement.end'],

  // automation · rewards
  ['POST /api/v1/automation/rules', 'automation.rule.create'],
  ['PATCH /api/v1/automation/rules/:id', 'automation.rule.update'],
  ['POST /api/v1/rewards/definitions', 'reward.definition.create'],
  ['POST /api/v1/rewards/grants', 'reward.grant.create'],
  ['DELETE /api/v1/rewards/grants/:id', 'reward.grant.revoke'],

  // integration — keys and webhooks are credentials and delivery targets
  ['POST /api/v1/api-keys', 'integration.api_key.create'],
  ['DELETE /api/v1/api-keys/:id', 'integration.api_key.revoke'],
  ['POST /api/v1/webhooks/endpoints', 'integration.webhook.create'],
  ['PATCH /api/v1/webhooks/endpoints/:id', 'integration.webhook.update'],
  ['DELETE /api/v1/webhooks/endpoints/:id', 'integration.webhook.delete'],

  // tenant configuration
  ['PUT /api/v1/tenant/branding', 'tenant.branding.update'],
  ['PUT /api/v1/tenant/localisation', 'tenant.localisation.update'],
  ['PUT /api/v1/tenant/sso', 'tenant.sso.upsert'],
  ['DELETE /api/v1/tenant/sso', 'tenant.sso.delete'],
  ['POST /api/v1/legal/documents', 'legal.document.publish'],
  ['POST /api/v1/legal/:kind/accept', 'legal.document.accept'],

  // partner portal — added BECAUSE this sweep found them unaudited. Granting
  // somebody access to a tenant's data is the partner-portal equivalent of
  // handing out a key, and it was writing nothing.
  ['POST /api/v1/partners', 'partner.create'],
  ['POST /api/v1/partners/:id/users', 'partner.user.grant'],
  ['DELETE /api/v1/partners/users/:id', 'partner.user.revoke'],

  // corporate wellness — likewise. Seats are what somebody paid for.
  ['POST /api/v1/sponsorships', 'sponsorship.create'],
  ['PATCH /api/v1/sponsorships/:id', 'sponsorship.update'],
  ['DELETE /api/v1/sponsorships/seats/:id', 'sponsorship.seat.release'],

  // added because this sweep found them silent
  ['POST /api/v1/knowledge/team-articles', 'knowledge.team_article.publish'],
  ['PATCH /api/v1/knowledge/team-articles/:id', 'knowledge.team_article.update'],
  ['PATCH /api/v1/members/me', 'member.profile.update'],
  ['POST /api/v1/challenges/:id/settle', 'challenge.settle'],
]);
