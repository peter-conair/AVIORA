/**
 * CRM contact encryption, rehearsed (docs/54).
 *
 * docs/13 §11.1 records why `leads` and `customers` still hold `name`, `email`
 * and `phone` in plaintext: encrypting them is a one-way door, and the obvious
 * objection — "then nobody can look a lead up by email again" — had no answer.
 *
 * This is the answer, run end to end against a scratch COPY of the real
 * database. It encrypts every contact column, fills the blind indexes, and then
 * checks the two things that decide whether the real migration is safe:
 *
 *   1. **Every plaintext lookup still returns the same row** through the blind
 *      index. This is the whole reason the index exists.
 *   2. **Every encrypted value decrypts back to exactly what was there.** Not
 *      "most" — a single row that comes back wrong is a customer whose phone
 *      number is gone.
 *
 * Deliberately NOT run in CI and NOT pointed at a database anybody uses: it
 * rewrites every CRM row. `scripts/crm-encryption-rehearsal.sh` makes the copy
 * and points this at it. Nothing here drops anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientForDsn } from '@aviora/db';
import { BlindIndexService } from '../../src/common/crypto/blind-index.service';
import { FieldEncryptionService } from '../../src/common/crypto/field-encryption.service';

const url = process.env.AVIORA_REHEARSAL_DATABASE_URL;
const enabled = !!url;

// A key for the rehearsal only. The real migration takes its keys from the
// secret store; generating one here keeps a throwaway database from needing a
// production secret to exist.
process.env.AVIORA_PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString('base64');
process.env.AVIORA_BLIND_INDEX_KEY ??= Buffer.alloc(32, 5).toString('base64');

type Row = { id: string; name: string | null; email: string | null; phone: string | null };

const prisma = enabled ? createClientForDsn(url!) : (null as never);
const enc = new FieldEncryptionService();
const bidx = new BlindIndexService();

const TABLES = ['leads', 'customers'] as const;

describe.skipIf(!enabled)('CRM encryption rehearsal', () => {
  const before = new Map<string, Row[]>();

  beforeAll(async () => {
    for (const table of TABLES) {
      const rows = await prisma.$queryRawUnsafe<Row[]>(
        `SELECT id::text, name, email, phone FROM ${table} ORDER BY id`,
      );
      before.set(table, rows);
    }
    const total = TABLES.reduce((n, t) => n + (before.get(t)?.length ?? 0), 0);
    // A rehearsal against an empty table proves nothing and would pass.
    expect(total, 'no CRM rows in the scratch database — nothing to rehearse').toBeGreaterThan(0);
  });

  afterAll(async () => {
    if (enabled) await prisma.$disconnect();
  });

  it('migrates every row and reports how long the tables are being written', async () => {
    for (const table of TABLES) {
      const rows = before.get(table)!;
      const started = Date.now();
      // One transaction per batch, not one for the whole table: a migration
      // that holds a single transaction over every CRM row holds locks for its
      // whole duration, which is the difference between a slow deploy and an
      // outage.
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        await prisma.$transaction(
          batch.map((row) =>
            prisma.$executeRawUnsafe(
              `UPDATE ${table}
                  SET name = $2, email = $3, phone = $4, email_bidx = $5, phone_bidx = $6
                WHERE id = $1::uuid`,
              row.id,
              enc.encrypt(row.name),
              enc.encrypt(row.email),
              enc.encrypt(row.phone),
              bidx.email(row.email),
              bidx.phone(row.phone),
            ),
          ),
        );
      }
      const seconds = (Date.now() - started) / 1000;
      console.log(
        `  ${table}: ${rows.length} rows in ${seconds.toFixed(1)}s ` +
          `(${Math.round(rows.length / Math.max(seconds, 0.001))}/s)`,
      );
    }
  });

  it('still finds every contact by the email somebody would type', async () => {
    for (const table of TABLES) {
      const withEmail = before.get(table)!.filter((r) => r.email?.trim());
      let found = 0;
      for (const row of withEmail) {
        // Typed the way a person types it, not the way it is stored: extra
        // spaces and the wrong case are what the index has to survive.
        const typed = `  ${row.email!.toUpperCase()} `;
        const hits = await prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id::text FROM ${table} WHERE email_bidx = $1`,
          bidx.email(typed),
        );
        expect(
          hits.map((h) => h.id),
          `${table} ${row.id}: the lead is no longer findable by its own email`,
        ).toContain(row.id);
        found += 1;
      }
      expect(found, `${table}: no rows had an email to look up`).toBeGreaterThan(0);
    }
  });

  it('finds contacts by a phone number written a different way', async () => {
    let checked = 0;
    for (const table of TABLES) {
      const withPhone = before
        .get(table)!
        .filter((r) => BlindIndexService.normalisePhone(r.phone ?? ''));
      for (const row of withPhone.slice(0, 50)) {
        const digits = row.phone!.replace(/\D/g, '');
        // Stored as one spelling, searched as another — the case that plain
        // equality misses and the reason phones are normalised at all.
        const rewritten = `+66 ${digits.slice(-9, -6)}-${digits.slice(-6, -3)}-${digits.slice(-3)}`;
        const hits = await prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id::text FROM ${table} WHERE phone_bidx = $1`,
          bidx.phone(rewritten),
        );
        expect(
          hits.map((h) => h.id),
          `${table} ${row.id}: phone lookup lost the row`,
        ).toContain(row.id);
        checked += 1;
      }
    }
    // The first run of this rehearsal passed here without comparing anything:
    // no row in the real database has a phone, so the loop above ran zero
    // times and reported green. A rehearsal that reports success for a column
    // it never touched is worse than no rehearsal, so the script now
    // synthesises phones into the copy (step 2) and this refuses to pass
    // without them.
    expect(checked, 'no phones to look up — step 2 of the script did not run').toBeGreaterThan(0);
  });

  it('gives every single value back exactly as it was', async () => {
    for (const table of TABLES) {
      const after = await prisma.$queryRawUnsafe<Row[]>(
        `SELECT id::text, name, email, phone FROM ${table} ORDER BY id`,
      );
      const originals = new Map(before.get(table)!.map((r) => [r.id, r]));
      expect(after).toHaveLength(originals.size);
      for (const row of after) {
        const was = originals.get(row.id)!;
        for (const field of ['name', 'email', 'phone'] as const) {
          const original = was[field];
          // An empty original stores as NULL, which is the same absence.
          const expected = original?.length ? original : null;
          expect(
            enc.decrypt(row[field]),
            `${table} ${row.id}.${field} did not survive the round trip`,
          ).toBe(expected);
        }
      }
    }
  });

  it('leaves no plaintext behind in the columns it claimed to encrypt', async () => {
    for (const table of TABLES) {
      // The check that catches a migration which silently skipped rows — the
      // failure mode where everything above passes because it reads what it
      // wrote, and a tenth of the table was never touched.
      const leftovers = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM ${table}
          WHERE (name  IS NOT NULL AND name  NOT LIKE 'enc.v1.%')
             OR (email IS NOT NULL AND email NOT LIKE 'enc.v1.%')
             OR (phone IS NOT NULL AND phone NOT LIKE 'enc.v1.%')`,
      );
      expect(Number(leftovers[0]!.n), `${table} still holds plaintext contacts`).toBe(0);
    }
  });
});
