# 53 — A Role for Platform Reads (Sprint 35)

> `docs/03 §4.1` — written last sprint when the audit found it — says the
> layered defence this platform opens with holds for tenant-scoped paths and
> **not** for platform-scope ones, because those run as the table owner and
> `FORCE ROW LEVEL SECURITY` binds every role except the owner. This closes it.

## 1. What "no backstop" actually meant

Every tenant-owned table has `tenant_isolation`, and the app role is bound by it
whatever the application does. That is the second layer: a bug in a tenant query
is refused by the database.

Platform paths — the tenant list, cross-tenant metrics, the scheduler, the
outbox relay — connect as `aviora_owner`. The owner is exempt from its own
tables' policies by design in Postgres, so on those paths a mistake in a query
has nothing underneath it. Not a breach: those routes are gated by
`@RequirePlatformRoles`, and the isolation sweep drives every tenant-scoped
route against a foreign tenant. But a gap between what §4 claimed and what was
true.

## 2. A third role, and it must ask

```sql
CREATE ROLE aviora_platform LOGIN;                       -- no DDL, no BYPASSRLS
CREATE POLICY platform_access ON <table> TO aviora_platform
  USING (current_setting('app.platform', true) = 'true');
```

Two properties, and the second is the point:

- **It is not the owner.** No DDL rights, and policies apply to it — so it is
  bound by the database rather than exempt from it.
- **It must declare itself.** The policy grants nothing unless the transaction
  has set `app.platform = 'true'`. A platform connection that forgets to say so
  sees **zero rows** — the same shape as a tenant connection with no tenant,
  and the reason docs/03 wanted "explicit, audited entry points" rather than an
  inherited privilege.

`withPlatform(prisma, fn)` sets the flag for one transaction, the way
`withTenant` does. Nothing else sets it.

## 3. What moves, and what deliberately does not

| Path                         | Client       | Why                                                                                                                                                                                                                             |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observability views          | **platform** | Cross-tenant READS. Exactly what the role is for.                                                                                                                                                                               |
| Alert sweep                  | owner        | It WRITES `alert_states`, and the platform role has read-only access there. Nothing is being bypassed on a table with no `tenant_isolation`, so moving it would cost a write policy and buy nothing.                            |
| Migrations, seed, role setup | owner        | DDL. A role without DDL rights cannot run them, and should not have them.                                                                                                                                                       |
| Outbox relay, scheduler      | owner        | They write to platform tables (`domain_events`, `scheduled_job_runs`) that carry no `tenant_id` and have no `tenant_isolation` policy — the owner is not buying an exemption there, because there is nothing to be exempt from. |
| Tenant request paths         | app          | Unchanged. This sprint touches nothing a member's request goes through.                                                                                                                                                         |

Moving everything would be worse than moving nothing: the relay and the
scheduler would gain a dependency on a GUC they do not need, for tables where
the policy would be `true` anyway.

## 4. What this does not claim

It does **not** make a platform bug harmless. A platform read that sets the flag
— which is every deliberate one — still sees across tenants; that is its job.
What changes is that the exemption is now **stated in a policy, per transaction,
by a role that cannot alter the schema**, instead of inherited silently by being
the owner. The failure it prevents is the accidental one: a query that ends up
on the platform client by mistake returns nothing rather than everything.

## 5. What the implementation changed about §3

Two things only became clear while wiring it up, and both narrowed the scope
rather than widening it:

**The alert sweep stays on the owner.** It reads _and writes_ `alert_states`.
That table has RLS with a read-only policy, so a platform-role write would need
a new write policy — for a table that has no `tenant_isolation` and therefore no
exemption to be worth auditing. Granting a write there to satisfy a table in
this document would have been ceremony.

**Platform-scope tables did not need a policy at all.** `domain_events`,
`scheduled_job_runs`, `tenants`, `users` and `processed_events` have RLS
**disabled** — nothing to be exempt from — so the role needs only a `GRANT`.
Adding policies would have implied a protection that is not there.

The distinction worth carrying: this role exists to remove an _exemption from
tenant isolation_. On a table with no tenant isolation there is no exemption,
and the honest answer is a grant, not a policy.
