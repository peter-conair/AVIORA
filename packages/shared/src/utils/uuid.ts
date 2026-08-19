import { v7 as uuidv7 } from 'uuid';

/** uuid v7 — time-ordered, index-friendly primary keys (ADR-012). */
export function newId(): string {
  return uuidv7();
}
