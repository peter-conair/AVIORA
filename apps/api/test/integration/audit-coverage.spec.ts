/**
 * Audit coverage sweep (docs/16 MVP exit criteria, docs/13).
 *
 * The roadmap asks that "every mutation in the flow produces an audit log row",
 * and the vertical-slice suite proves that for eight named actions. Eight named
 * actions is a list somebody wrote once. What it cannot do is notice the NINTH
 * mutation — a route added next month that quietly records nothing.
 *
 * So this asks the application which mutating routes exist and requires each one
 * to be DECLARED: either it writes an audit row, or it is listed here as
 * deliberately unaudited with a reason. A new mutation fails this test until
 * somebody decides which it is, which is the whole point — the failure mode of
 * audit is silence, and silence is what a hand-maintained list preserves.
 *
 * It is the same shape as the route-registry isolation sweep: ask the app, do
 * not remember.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/app.factory';

interface RouteInfo {
  method: string;
  path: string;
}

let app: INestApplication;

/**
 * Mutating routes that deliberately write no audit row, each with the reason.
 *
 * This list is meant to be read, argued with, and kept short. A reason of
 * "routine" should make somebody ask whether it is really routine.
 */
const UNAUDITED: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^\/api\/v1\/tracker\/entries\/[^/]+\/marks$/,
    why: 'Ticking a box on a follow-up sheet is routine work, and a busy line produces hundreds a week — auditing each would bury the rows this log exists for. The tick is not lost: tracker_marks stores when it happened and which member put it there, which is strictly more than an audit row would say (docs/59 §4). Adding a ROW to a sheet IS audited.',
  },
  {
    pattern: /^\/api\/v1\/auth\/(logout|refresh)$/,
    why: 'Session lifecycle, not tenant mutations. Refresh-token reuse already kills the family and records it; a row per logout would bury the mutations this log exists for. (login IS audited, on refusal — see the inventory.)',
  },
  {
    pattern: /^\/api\/v1\/(courses\/[^/]+\/start|lessons\/[^/]+\/complete)$/,
    why: 'A member starting a course or completing a lesson is their own routine progress, already stored in learning_progress with timestamps. Auditing every lesson would flood the log and make the sensitive rows harder to find — which is a real cost, not a saving.',
  },
  {
    pattern: /^\/api\/v1\/(habits|metrics|health)\b/,
    why: 'Health data is SELF-scoped (docs/13). An audit row naming what a member logged would be a second copy of the thing the privacy model exists to contain — readable by whoever reads audit.',
  },
  {
    pattern: /^\/api\/v1\/(community|posts|comments|reactions)\b/,
    why: 'Community content is its own record, with authorship and timestamps, and is soft-deleted rather than removed. A parallel audit trail of every reaction would be noise.',
  },
  {
    pattern: /^\/api\/v1\/(cart|ai|assistant)\b/,
    why: 'Cart edits are a draft the member is still making; the ORDER that results is audited (commerce.order.place). AI turns are stored as conversations with their own history — and an answer WITHHELD by the safety filter writes ai.safety.blocked, which is the intervention worth recording (docs/50 §3).',
  },
  {
    pattern: /^\/api\/v1\/notifications\b/,
    why: 'Marking a notification read is the member reading their own mail.',
  },
  {
    pattern: /^\/api\/v1\/(goals\/[^/]+\/progress|goals\/[^/]+)$/,
    why: 'Goal creation is audited (goal.create); updating progress on your own goal is routine member activity.',
  },
  {
    pattern: /^\/api\/v1\/platform\/scheduler\/run$/,
    why: 'Forcing a scheduled job writes a scheduled_job_runs row that records who ran what and when — a better record than an audit line, and the one an operator already reads (docs/35 §5).',
  },
  {
    pattern: /^\/api\/v1\/challenges\/[^/]+\/join$/,
    why: 'Joining is audited (challenge.join); LEAVING is the member withdrawing their own consent to share a derived count, and the participant row records it with a timestamp.',
  },
  {
    pattern: /^\/api\/v1\/crm\/(interactions|follow-ups\/[^/]+\/complete)$/,
    why: 'Logging a call and ticking off a follow-up are the routine of sales work, and each IS the record — creating the lead and the follow-up is audited.',
  },
  {
    pattern: /^\/api\/v1\/platform\/tenant-databases\/[^/]+\/plan$/,
    why: 'The migration DRY RUN. It is a POST because it computes, but it changes nothing (docs/32 §3).',
  },
  {
    pattern: /^\/api\/v1\/sponsorships\/[^/]+\/invitations$/,
    why: 'The invitation it sends is audited as member.invite, and the seat it takes is visible in the pool a sponsor already reads (docs/45 §2).',
  },
  {
    pattern: /^\/api\/v1\/subscriptions\/run-due$/,
    why: 'The manual twin of the scheduler job. Each renewal writes a subscription_runs row and an order, and the scheduler writes a scheduled_job_runs row saying who ran what (docs/35).',
  },
  {
    pattern: /^\/api\/v1\/webhooks\/deliveries\/[^/]+\/retry$/,
    why: 'A delivery records its own attempts, response code and error text — a better account than an audit line (docs/30 §1).',
  },
  {
    pattern: /^\/api\/v1\/gamification\b/,
    why: 'Points and badges are awarded from the outbox against an event id, and every award carries that reference — the event is the audit trail.',
  },
  {
    pattern: /^\/api\/v1\/partner\/invitations$/,
    why: 'The invitation it sends is audited as member.invite, and the referral it creates is the partner-facing record (docs/46 §2).',
  },
];

beforeAll(async () => {
  process.env.AVIORA_SCHEDULER_DISABLED = 'true';
  process.env.AVIORA_OUTBOX_DISABLED = 'true';
  process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 37).toString('base64');
  app = await createApp({ logger: false });
  await app.init();
}, 180_000);

afterAll(async () => {
  await app?.close();
});

function listRoutes(nestApp: INestApplication): RouteInfo[] {
  const server = nestApp.getHttpAdapter().getInstance() as {
    router?: { stack: unknown[] };
    _router?: { stack: unknown[] };
  };
  const stack = (server.router ?? server._router)?.stack ?? [];
  const routes: RouteInfo[] = [];
  for (const layer of stack as Array<{
    route?: { path: string | string[]; methods?: Record<string, boolean> };
  }>) {
    const route = layer.route;
    if (!route) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    // Express registers middleware for every verb it knows, so the stack is
    // mostly noise: keep the four that mutate, and drop the catch-all layers
    // (`{*path}`, the `$`-anchored prefix mount) and the liveness endpoints.
    for (const p of paths) {
      if (p.includes('{*path}') || p.endsWith('$')) continue;
      if (['/healthz', '/readyz', '/manifest.webmanifest'].includes(p)) continue;
      for (const [m, on] of Object.entries(route.methods ?? {})) {
        if (!on) continue;
        const method = m.toUpperCase();
        if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) continue;
        routes.push({ method, path: p });
      }
    }
  }
  return routes;
}

describe('Every mutation is declared: audited, or unaudited with a reason', () => {
  it('finds the mutating routes to judge', () => {
    const routes = listRoutes(app);
    // If this ever reads zero, the sweep below passes while checking nothing —
    // the failure mode this codebase keeps meeting.
    expect(
      routes.length,
      'no mutating routes were found, so this sweep is asserting nothing',
    ).toBeGreaterThan(30);
  });

  it('has no mutation that is neither audited nor explained', async () => {
    const routes = listRoutes(app);
    const { AUDITED_ROUTES } = await import('./audit-inventory');

    const undeclared = routes.filter((r) => {
      const key = `${r.method} ${r.path}`;
      if (AUDITED_ROUTES.has(key)) return false;
      return !UNAUDITED.some((u) => u.pattern.test(r.path));
    });

    expect(
      undeclared.map((r) => `${r.method} ${r.path}`).sort(),
      'these mutations are neither in the audited inventory nor listed as ' +
        'deliberately unaudited. Add the audit call, or add the route to ' +
        'UNAUDITED with the reason — the point is that somebody decides, ' +
        'because the failure mode of audit is silence.',
    ).toEqual([]);
  });

  it('does not list a reason for a route that no longer exists', () => {
    const routes = listRoutes(app);
    const stale = UNAUDITED.filter((u) => !routes.some((r) => u.pattern.test(r.path)));
    expect(
      stale.map((u) => String(u.pattern)),
      'these exemptions match no route. An exemption for something that does ' +
        'not exist is how a list stops describing the system it guards.',
    ).toEqual([]);
  });
});
