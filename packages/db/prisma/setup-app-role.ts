/** One-shot: ensure the aviora_app login role exists with the env password. */
import { PrismaClient } from '@prisma/client';
import { ensureAppRole } from '../src/admin';

const owner = new PrismaClient({ datasourceUrl: process.env.AVIORA_DATABASE_URL });

ensureAppRole(owner)
  .then(() => console.log('✓ aviora_app role ensured'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
