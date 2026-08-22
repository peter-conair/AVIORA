/**
 * docs/07's matrix matches the code, or the build fails (docs/52).
 *
 * The design-time matrix in docs/07 drifted until it named 61 permissions that
 * do not exist and missed 45 that do. Nobody noticed, because a document cannot
 * fail. This is the same remedy the API catalogue uses (docs/47 §2): generate
 * the description, then assert the generated form is what is committed.
 *
 * If this test fails, the fix is one command — `pnpm --filter @aviora/db
 * docs:permissions` — not an edit to the table.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMatrix } from '../../../../packages/db/scripts/render-permission-matrix';

const DOC = path.resolve(__dirname, '../../../../docs/07-role-permission-matrix.md');

/**
 * Compares CONTENT, not spacing. Prettier aligns markdown table pipes, so a
 * byte-for-byte comparison would fail every time the repo is formatted — and a
 * test that fails for a reason nobody cares about is a test somebody deletes.
 */
/**
 * The ROWS, not the block. Prettier pads table cells and re-wraps the prose
 * around them, so comparing text — even whitespace-normalised — fails the
 * moment the repo is formatted, and a test that fails for a reason nobody cares
 * about is a test somebody deletes.
 *
 * A row carries everything worth asserting: the permission, its scope, and what
 * each role holds. Change any of those and this notices; reflow the file and it
 * does not.
 */
function rows(block: string): string[] {
  return [...block.matchAll(/\|\s*`([a-z][a-z0-9_.]+)`\s*\|([^\n]*)/g)]
    .map(([, key, rest]) => `${key}|${(rest ?? '').replace(/\s+/g, '')}`)
    .sort();
}

describe('The permission matrix in docs/07 is generated, not remembered', () => {
  it('matches what PERMISSIONS and SYSTEM_ROLES actually say', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    const expected = renderMatrix();
    const start = doc.indexOf('<!-- GENERATED:permission-matrix -->');
    const end = doc.indexOf('<!-- /GENERATED:permission-matrix -->');
    expect(start, 'the generated block markers are gone from docs/07').toBeGreaterThan(-1);

    const actual = doc.slice(start, end + '<!-- /GENERATED:permission-matrix -->'.length);
    const committed = rows(actual);
    expect(committed.length, 'the generated block has no rows').toBeGreaterThan(30);
    expect(
      committed,
      'docs/07 no longer matches the code. Run `pnpm --filter @aviora/db ' +
        'docs:permissions` — do not edit the table, because the next person to ' +
        'add a permission will not know to.',
    ).toEqual(rows(expected));
  });

  it('documents every permission the code defines, and invents none', async () => {
    // Read independently of the renderer: if both read the catalogue the same
    // wrong way, the test above would happily agree with the bug.
    const { PERMISSIONS } = await import('@aviora/shared');
    const doc = fs.readFileSync(DOC, 'utf8');
    // Bounded by BOTH markers. Slicing from the start marker to the end of the
    // file swallows the design-time matrix below it, which names permissions
    // that deliberately do not exist — and this test would then report the
    // design as a defect.
    const block = doc.slice(
      doc.indexOf('<!-- GENERATED:permission-matrix -->'),
      doc.indexOf('<!-- /GENERATED:permission-matrix -->'),
    );
    const documented = new Set(
      [...block.matchAll(/\|\s*`([a-z][a-z0-9_.]+)`\s*\|/g)]
        .map((m) => m[1])
        .filter((k): k is string => typeof k === 'string'),
    );
    const defined = new Set<string>(Object.values(PERMISSIONS));

    expect(
      [...defined].filter((k) => !documented.has(k)).sort(),
      'defined but undocumented',
    ).toEqual([]);
    expect(
      [...documented].filter((k) => !defined.has(k)).sort(),
      'documented but undefined',
    ).toEqual([]);
    expect(documented.size, 'the generated block lists nothing').toBeGreaterThan(30);
  });
});
