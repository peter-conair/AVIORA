/**
 * Renders the permission matrix docs/07 shows, FROM the code (docs/52).
 *
 * docs/07 was written as a design-time model and the implementation diverged:
 * it named 61 permission keys that do not exist and missed 45 that do. A reader
 * configuring a role from it would grant keys that do nothing, and would never
 * learn about the ones that matter.
 *
 * So the matrix is generated now. The same reasoning as the API catalogue
 * (docs/47 §2): a hand-maintained description of a system drifts, and a drifted
 * description is worse than none — it reads as authoritative while telling
 * somebody to do something that has no effect.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PERMISSIONS } from '@aviora/shared';
import { SYSTEM_ROLES, isTenantScopePermission } from '../src/system-roles';

const MARK_START = '<!-- GENERATED:permission-matrix -->';
const MARK_END = '<!-- /GENERATED:permission-matrix -->';

export function renderMatrix(): string {
  const keys = [...new Set(Object.values(PERMISSIONS))].sort();
  const roles = SYSTEM_ROLES.map((r) => r.code);

  const header = `| Permission | Scope | ${roles.join(' | ')} |`;
  const divider = `| --- | --- | ${roles.map(() => '---').join(' | ')} |`;

  const rows = keys.map((key) => {
    const tenantScope = isTenantScopePermission(key);
    const cells = SYSTEM_ROLES.map((role) => {
      // `grants: null` means every TENANT-scope permission at TENANT_ALL.
      if (role.grants === null) return tenantScope ? '`TENANT_ALL`' : '—';
      const grant = role.grants.find((g) => g.key === key);
      return grant ? `\`${grant.scope}\`` : '—';
    });
    return `| \`${key}\` | ${tenantScope ? 'tenant' : 'platform'} | ${cells.join(' | ')} |`;
  });

  return [
    MARK_START,
    '',
    `_Generated from \`PERMISSIONS\` and \`SYSTEM_ROLES\`. ${keys.length} permissions,`,
    `${roles.length} system roles. Do not edit by hand — run \`pnpm --filter @aviora/db`,
    `docs:permissions\`. A platform-scope key is never granted to a tenant role, which`,
    `is why those rows are dashes all the way across (docs/07 §1)._`,
    '',
    header,
    divider,
    ...rows,
    '',
    MARK_END,
  ].join('\n');
}

export function spliceIntoDoc(doc: string, matrix: string): string {
  const start = doc.indexOf(MARK_START);
  const end = doc.indexOf(MARK_END);
  if (start === -1 || end === -1) {
    throw new Error(`docs/07 is missing the ${MARK_START} markers`);
  }
  return doc.slice(0, start) + matrix + doc.slice(end + MARK_END.length);
}

if (require.main === module) {
  const file = path.resolve(__dirname, '../../../docs/07-role-permission-matrix.md');
  fs.writeFileSync(file, spliceIntoDoc(fs.readFileSync(file, 'utf8'), renderMatrix()));
  console.log('docs/07 permission matrix regenerated');
}
