/**
 * Fill `email_bidx` / `phone_bidx` for CRM rows that predate them (docs/55).
 *
 * Lives here rather than in packages/db because it must use the SAME
 * normalisation the API writes with — a backfill with its own copy of "how a
 * phone number is spelled" produces an index that disagrees with every row
 * written afterwards, and the disagreement is invisible until a duplicate
 * check quietly stops finding things.
 *
 * Derived data only: it reads the plaintext columns and writes digests. It
 * never modifies a contact, so running it twice, or after a partial run, is
 * safe and it can be undone by nulling the two columns.
 *
 *   pnpm --filter @aviora/api backfill:crm-bidx
 */
import { createOwnerClient } from '@aviora/db';
import { BlindIndexService } from '../src/common/crypto/blind-index.service';

const blind = new BlindIndexService();

async function main(): Promise<void> {
  if (!blind.isConfigured) {
    throw new Error('AVIORA_BLIND_INDEX_KEY is not set — nothing to compute');
  }
  const prisma = createOwnerClient();
  try {
    for (const table of ['lead', 'customer'] as const) {
      const model = prisma[table] as {
        findMany: (
          a: unknown,
        ) => Promise<{ id: string; email: string | null; phone: string | null }[]>;
        update: (a: unknown) => Promise<unknown>;
      };
      // Only rows that have a contact and no digest yet. Rows with neither
      // stay null, which is correct: nothing to match on must match nothing.
      const rows = await model.findMany({
        where: {
          OR: [
            { email: { not: null }, emailBidx: null },
            { phone: { not: null }, phoneBidx: null },
          ],
        },
        select: { id: true, email: true, phone: true },
      });
      let done = 0;
      for (const row of rows) {
        await model.update({
          where: { id: row.id },
          data: { emailBidx: blind.email(row.email), phoneBidx: blind.phone(row.phone) },
        });
        done += 1;
      }
      process.stdout.write(`${table}: ${done} row(s) indexed\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
