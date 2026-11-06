import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import { z } from 'zod';
import { newId } from '../core/ids.js';
import { MemoryInputError } from './errors.js';
import { moduleLogger } from './logger.js';
import { createMemoryRepo, type MemoryRepo, type StoredMemory } from './repo.js';
import { selectFacts } from './select.js';
import type { ContextLogRecord, FactKind, HarnessMemory, MemoryFact } from './types.js';

const RememberInputSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  kind: z.enum(['explicit', 'inferred']),
  tags: z.array(z.string().min(1)).optional(),
});

const ContextLogEntrySchema = z.object({
  userId: z.string().min(1),
  runId: z.string().min(1),
  step: z.number().int().nonnegative(),
  estTokens: z.number().int().nonnegative(),
  factIds: z.array(z.string().min(1)),
  sections: z.record(z.string(), z.number().nonnegative()),
});

export type MemoryService = HarnessMemory & {
  list(userId: string): MemoryFact[];
  /** Editing is a user correction: the row becomes explicit and active, including a forgotten one. */
  update(userId: string, id: string, value: string): MemoryFact | null;
  confirm(userId: string, id: string): MemoryFact | null;
  forgetById(userId: string, id: string): boolean;
  lint(userId: string): Array<{ key: string; values: string[] }>;
  renderProfileMd(userId: string): string;
  listContextLog(userId: string, runId?: string): ContextLogRecord[];
};

export interface MemoryServiceDeps {
  db: Database.Database;
  clock: Clock;
  logger?: Logger;
}

function requireUserId(userId: string): void {
  if (userId.length === 0) throw new MemoryInputError('userId is required');
}

function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}

function toFact(row: StoredMemory): MemoryFact {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    kind: row.kind,
    status: row.status,
    tags: [...row.tags],
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface CleanRemember {
  key: string;
  value: string;
  kind: FactKind;
  tags?: string[];
}

function cleanRemember(input: {
  key: string;
  value: string;
  kind: FactKind;
  tags?: string[];
}): CleanRemember {
  const parsed = RememberInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryInputError(parsed.error.issues[0]?.message ?? 'invalid memory');
  }
  const key = parsed.data.key.trim();
  const value = parsed.data.value.trim();
  if (key.length === 0 || value.length === 0) {
    throw new MemoryInputError('key and value are required');
  }
  if (parsed.data.tags === undefined) return { key, value, kind: parsed.data.kind };
  const tags = parsed.data.tags.map((tag) => tag.trim());
  if (tags.some((tag) => tag.length === 0)) throw new MemoryInputError('tags must be non-empty');
  return { key, value, kind: parsed.data.kind, tags };
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const repo: MemoryRepo = createMemoryRepo(deps.db);
  const log = deps.logger ? childLogger(deps.logger, 'memory') : moduleLogger('memory');
  const { clock } = deps;

  function visible(userId: string): MemoryFact[] {
    requireUserId(userId);
    return repo.list(userId, ['active', 'unconfirmed']).map(toFact);
  }

  function contradictions(userId: string): Array<{ key: string; values: string[] }> {
    requireUserId(userId);
    const grouped = new Map<string, string[]>();
    for (const fact of repo.list(userId, ['active'])) {
      const values = grouped.get(fact.key);
      if (values === undefined) {
        grouped.set(fact.key, [fact.value]);
        continue;
      }
      if (!values.includes(fact.value)) values.push(fact.value);
    }
    const found: Array<{ key: string; values: string[] }> = [];
    for (const [key, values] of grouped) {
      if (values.length >= 2) found.push({ key, values });
    }
    return found;
  }

  return {
    selectForContext(userId, ctx): MemoryFact[] {
      requireUserId(userId);
      const selected = selectFacts(repo.list(userId, ['active']).map(toFact), ctx);
      log.debug(
        { userId, service: ctx.service ?? null, area: ctx.area ?? null, selected: selected.length },
        'memories selected',
      );
      return selected;
    },

    remember(userId, input): MemoryFact {
      requireUserId(userId);
      const cleaned = cleanRemember(input);
      const now = nowIso(clock);
      if (cleaned.kind === 'explicit') {
        const overwritten = repo.transaction(() => {
          const existing = repo.listByKey(userId, cleaned.key, ['active']);
          const keep = existing[0];
          if (keep === undefined) return null;
          const updated = repo.update(userId, keep.id, {
            value: cleaned.value,
            kind: 'explicit',
            status: 'active',
            tags: cleaned.tags ?? keep.tags,
            updatedAt: now,
          });
          if (updated === undefined) {
            throw new Error(`active memory ${keep.id} disappeared during overwrite`);
          }
          for (const extra of existing.slice(1)) {
            repo.forgetById(userId, extra.id, now);
          }
          return updated;
        });
        if (overwritten) {
          log.info({ userId, factId: overwritten.id, key: cleaned.key }, 'memory overwritten');
          return toFact(overwritten);
        }
      }

      const created: StoredMemory = {
        id: newId('mem'),
        userId,
        key: cleaned.key,
        value: cleaned.value,
        kind: cleaned.kind,
        status: cleaned.kind === 'explicit' ? 'active' : 'unconfirmed',
        tags: cleaned.tags ?? [],
        createdAt: now,
        updatedAt: now,
      };
      repo.insert(created);
      log.info(
        { userId, factId: created.id, key: created.key, kind: created.kind, status: created.status },
        'memory remembered',
      );
      return toFact(created);
    },

    forget(userId, key): boolean {
      requireUserId(userId);
      const keyText = key.trim();
      if (keyText.length === 0) throw new MemoryInputError('key is required');
      const changed = repo.forgetByKey(userId, keyText, nowIso(clock)) > 0;
      if (changed) log.info({ userId, key: keyText }, 'memory forgotten');
      return changed;
    },

    getProfile: visible,

    list: visible,

    update(userId, id, valueInput): MemoryFact | null {
      requireUserId(userId);
      const value = valueInput.trim();
      if (value.length === 0) throw new MemoryInputError('value is required');
      const current = repo.getById(userId, id);
      if (current === undefined) return null;
      const updated = repo.update(userId, id, {
        value,
        kind: 'explicit',
        status: 'active',
        tags: current.tags,
        updatedAt: nowIso(clock),
      });
      if (updated === undefined) return null;
      log.info({ userId, factId: id, key: updated.key }, 'memory updated');
      return toFact(updated);
    },

    confirm(userId, id): MemoryFact | null {
      requireUserId(userId);
      const current = repo.getById(userId, id);
      if (current === undefined || current.status === 'forgotten') return null;
      if (current.status === 'active') return toFact(current);
      const updated = repo.update(userId, id, {
        value: current.value,
        kind: current.kind,
        status: 'active',
        tags: current.tags,
        updatedAt: nowIso(clock),
      });
      if (updated === undefined) return null;
      log.info({ userId, factId: id, key: updated.key }, 'memory confirmed');
      return toFact(updated);
    },

    forgetById(userId, id): boolean {
      requireUserId(userId);
      const changed = repo.forgetById(userId, id, nowIso(clock));
      if (changed) log.info({ userId, factId: id }, 'memory forgotten by id');
      return changed;
    },

    lint: contradictions,

    renderProfileMd(userId): string {
      const facts = visible(userId);
      const conflicts = contradictions(userId);
      const lines = ['# Profile', ''];
      if (facts.length === 0) {
        lines.push('_No facts yet._');
      } else {
        for (const fact of facts) {
          lines.push(`- **${oneLine(fact.key)}**: ${oneLine(fact.value)} _(${fact.kind}, ${fact.status})_`);
        }
      }
      if (conflicts.length > 0) {
        lines.push('', '## Contradictions', '');
        for (const conflict of conflicts) {
          const quoted = conflict.values.map((value) => `"${oneLine(value)}"`).join(' vs ');
          lines.push(`- **${oneLine(conflict.key)}**: ${quoted} — which should I keep?`);
        }
      }
      return lines.join('\n');
    },

    logContext(entry): void {
      const parsed = ContextLogEntrySchema.safeParse(entry);
      if (!parsed.success) {
        throw new MemoryInputError(parsed.error.issues[0]?.message ?? 'invalid context log');
      }
      const { userId, runId, step, estTokens, factIds, sections } = parsed.data;
      if (factIds.length > 0) {
        const active = new Set(
          repo
            .getMany(userId, factIds)
            .filter((fact) => fact.status === 'active')
            .map((fact) => fact.id),
        );
        const rejected = factIds.filter((id) => !active.has(id));
        if (rejected.length > 0) {
          log.warn({ userId, runId, factIds: rejected }, 'context_log rejected non-active facts');
          throw new MemoryInputError('context_log can only record active facts for this user');
        }
      }
      repo.insertContext({
        id: newId('ctx'),
        userId,
        runId,
        step,
        estTokens,
        actualTokensIn: null,
        actualTokensOut: null,
        factIds,
        sections,
        createdAt: nowIso(clock),
      });
      log.info({ userId, runId, step, estTokens, factCount: factIds.length }, 'context logged');
    },

    listContextLog(userId, runId): ContextLogRecord[] {
      requireUserId(userId);
      return repo.listContext(userId, runId);
    },
  };
}
