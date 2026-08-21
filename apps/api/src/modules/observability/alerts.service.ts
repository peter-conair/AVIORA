import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/db/prisma.service';
import { EmailService } from '../../common/email/email.service';

/**
 * Alerting (docs/42).
 *
 * The failure this is designed against is not "the alert did not fire". It is
 * being unable to tell the difference between nothing being wrong and nothing
 * being checked — the shape of two things this codebase has already been bitten
 * by: a pre-commit guard registered so it never ran, and an isolation probe
 * that counted rows which did not exist. Both looked like health.
 *
 * So every answer carries when the checks last ran, and the endpoint says so
 * even when nothing is firing.
 */

/** Loose on purpose: an alert that fires on a normal Tuesday teaches people to ignore alerting. */
const THRESHOLDS = {
  /** Oldest unprocessed event, in seconds. 10 minutes of backlog is a real backlog. */
  outboxAgeSeconds: Number(process.env.AVIORA_ALERT_OUTBOX_AGE_S ?? 600),
  /** Events that have already errored at least once. */
  outboxFailing: Number(process.env.AVIORA_ALERT_OUTBOX_FAILING ?? 25),
  /** A run left `claimed` this long is a job nobody ran (docs/35 §5). */
  staleClaimMinutes: Number(process.env.AVIORA_ALERT_STALE_CLAIM_M ?? 30),
  /** A daily job with no success in this long has silently stopped. */
  jobSilentHours: Number(process.env.AVIORA_ALERT_JOB_AGE_H ?? 26),
  /** Webhook deliveries stuck failing. */
  webhookFailing: Number(process.env.AVIORA_ALERT_WEBHOOK_FAILING ?? 20),
  /** One reminder if a problem is still there after this long. */
  reminderHours: Number(process.env.AVIORA_ALERT_REMINDER_H ?? 24),
};

/** The daily jobs whose silence is worth an alert. Both move money or standing. */
const DAILY_JOBS = ['subscription.renew', 'rank.evaluate'];

export interface AlertCheck {
  check: string;
  firing: boolean;
  /** What was measured, and the line it was measured against. */
  value: number;
  threshold: number;
  summary: string;
  firingSince: string | null;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /** Evaluates every check. Reads only what docs/36 already computes from. */
  async evaluate(): Promise<AlertCheck[]> {
    const now = Date.now();
    const staleBefore = new Date(now - THRESHOLDS.staleClaimMinutes * 60_000);
    const silentBefore = new Date(now - THRESHOLDS.jobSilentHours * 3_600_000);

    const [oldest, failing, staleClaims, webhookFailing, jobSuccesses] = await Promise.all([
      this.prisma.owner.domainEvent.findFirst({
        where: { processedAt: null },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      }),
      this.prisma.owner.domainEvent.count({
        where: { processedAt: null, attempts: { gt: 0 } },
      }),
      this.prisma.owner.scheduledJobRun.count({
        where: { status: 'claimed', startedAt: { lt: staleBefore } },
      }),
      this.prisma.owner.webhookDelivery.count({ where: { status: 'failed' } }),
      this.prisma.owner.scheduledJobRun.groupBy({
        by: ['job'],
        where: { job: { in: DAILY_JOBS }, status: 'succeeded', finishedAt: { gte: silentBefore } },
        _count: { _all: true },
      }),
    ]);

    const backlogSeconds = oldest ? Math.round((now - oldest.occurredAt.getTime()) / 1000) : 0;
    // A job that has NEVER run is not silent — a platform with no tenants on a
    // paid plan has nothing to renew, and paging about that would be noise.
    // Only a job that used to run and stopped is worth waking somebody for.
    const everRan = await this.prisma.owner.scheduledJobRun.groupBy({
      by: ['job'],
      where: { job: { in: DAILY_JOBS }, status: 'succeeded' },
      _count: { _all: true },
    });
    const ranRecently = new Set(jobSuccesses.map((j) => j.job));
    const silentJobs = everRan.filter((j) => !ranRecently.has(j.job)).map((j) => j.job);

    const checks: Array<Omit<AlertCheck, 'firingSince'>> = [
      {
        check: 'outbox.backlog',
        firing: backlogSeconds > THRESHOLDS.outboxAgeSeconds,
        value: backlogSeconds,
        threshold: THRESHOLDS.outboxAgeSeconds,
        summary: `oldest unprocessed event is ${backlogSeconds}s old`,
      },
      {
        check: 'outbox.failing',
        firing: failing >= THRESHOLDS.outboxFailing,
        value: failing,
        threshold: THRESHOLDS.outboxFailing,
        summary: `${failing} queued events have already errored`,
      },
      {
        check: 'scheduler.stale_claim',
        firing: staleClaims > 0,
        value: staleClaims,
        threshold: 0,
        summary:
          `${staleClaims} scheduled run(s) claimed over ` +
          `${THRESHOLDS.staleClaimMinutes}m ago and never settled — the scheduler ` +
          'will not retry them, so somebody has to force them (docs/35 §5)',
      },
      {
        check: 'scheduler.missed',
        firing: silentJobs.length > 0,
        value: silentJobs.length,
        threshold: 0,
        summary:
          silentJobs.length > 0
            ? `${silentJobs.join(', ')} has not succeeded in ${THRESHOLDS.jobSilentHours}h`
            : 'every daily job has succeeded recently',
      },
      {
        check: 'webhook.failing',
        firing: webhookFailing >= THRESHOLDS.webhookFailing,
        value: webhookFailing,
        threshold: THRESHOLDS.webhookFailing,
        summary: `${webhookFailing} webhook deliveries are in failed state`,
      },
    ];

    const states = await this.prisma.owner.alertState.findMany({
      where: { check: { in: checks.map((c) => c.check) } },
      select: { check: true, firingSince: true },
    });
    const since = new Map(states.map((s) => [s.check, s.firingSince]));
    return checks.map((c) => ({
      ...c,
      firingSince: c.firing ? (since.get(c.check)?.toISOString() ?? null) : null,
    }));
  }

  /**
   * Evaluates, records, and tells somebody when the answer CHANGED.
   *
   * Called by the `alert.sweep` scheduler job, so it inherits one run per
   * occurrence and a row saying it happened (docs/42 §3). Alerting on its own
   * timer would be a second scheduler nobody could see.
   */
  async sweep(): Promise<{ firing: string[]; notified: string[]; checked: number }> {
    const checks = await this.evaluate();
    const notified: string[] = [];
    const now = new Date();

    for (const c of checks) {
      const prior = await this.prisma.owner.alertState.findUnique({ where: { check: c.check } });
      const wasFiring = prior?.firing ?? false;
      const started = c.firing && !wasFiring;
      const cleared = !c.firing && wasFiring;
      // One reminder for a problem nobody fixed. Once — a check that emails
      // every sweep is a check people filter into a folder they never open.
      const dueReminder =
        c.firing &&
        wasFiring &&
        prior?.lastNotifiedAt != null &&
        now.getTime() - prior.lastNotifiedAt.getTime() > THRESHOLDS.reminderHours * 3_600_000;

      const tell = started || cleared || dueReminder;
      if (tell) {
        const sent = await this.notify(c, cleared ? 'cleared' : started ? 'started' : 'still');
        if (sent) notified.push(c.check);
      }

      await this.prisma.owner.alertState.upsert({
        where: { check: c.check },
        create: {
          check: c.check,
          firing: c.firing,
          value: String(c.value),
          firingSince: c.firing ? now : null,
          lastNotifiedAt: tell ? now : null,
          checkedAt: now,
        },
        update: {
          firing: c.firing,
          value: String(c.value),
          // The episode's start is kept across sweeps: "firing since 09:12" is
          // the thing a responder actually wants, and resetting it every sweep
          // would make every alert look brand new.
          firingSince: c.firing ? (prior?.firingSince ?? now) : null,
          ...(tell ? { lastNotifiedAt: now } : {}),
          checkedAt: now,
        },
      });
    }

    return {
      firing: checks.filter((c) => c.firing).map((c) => c.check),
      notified,
      checked: checks.length,
    };
  }

  /** One email, one address. Routing and escalation are somebody's product (docs/42 §3). */
  private async notify(check: AlertCheck, kind: 'started' | 'cleared' | 'still'): Promise<boolean> {
    const to = process.env.AVIORA_ALERT_EMAIL;
    if (!to) {
      this.logger.warn(
        `alert ${check.check} ${kind} but AVIORA_ALERT_EMAIL is not set: ${check.summary}`,
      );
      return false;
    }
    const verb = kind === 'cleared' ? 'CLEARED' : kind === 'still' ? 'STILL FIRING' : 'FIRING';
    try {
      await this.email.send(
        to,
        `[AVIORA] ${verb}: ${check.check}`,
        `<p><b>${check.check}</b> — ${verb.toLowerCase()}</p>
<p>${escapeHtml(check.summary)}</p>
<p>measured <b>${check.value}</b> against a threshold of <b>${check.threshold}</b>.</p>
${check.firingSince ? `<p>firing since ${check.firingSince}</p>` : ''}
<p>See <code>GET /platform/observability/alerts</code>.</p>`,
      );
      return true;
    } catch (e) {
      // An alert that cannot be delivered must not stop the sweep: the other
      // checks still need to run, and the endpoint still has to be able to say
      // what is firing.
      this.logger.error(
        `could not email alert ${check.check}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /**
   * When the checks last ran. The whole point of §1: "no alerts" from a sweep
   * ninety seconds old is health, and "no alerts" from a sweep that last ran
   * yesterday is the thing to investigate. A reader must never have to guess
   * which one they are looking at.
   */
  async lastCheckedAt(): Promise<string | null> {
    const row = await this.prisma.owner.alertState.findFirst({
      orderBy: { checkedAt: 'desc' },
      select: { checkedAt: true },
    });
    return row?.checkedAt.toISOString() ?? null;
  }

  get thresholds(): typeof THRESHOLDS {
    return THRESHOLDS;
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
