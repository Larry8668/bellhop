import { describe, expect, it } from 'vitest';
import type { LanguageModelV4ToolCall } from '@ai-sdk/provider';
import { rememberSearchResults, repairToolCallFor, repairToolInput } from '../../src/harness/repair.js';

const PROVIDERS = [
  { id: 'prv_aaa', name: 'Sri Sai Plumbing' },
  { id: 'prv_bbb', name: 'QuickFix Pipes' },
];

describe('repairToolInput', () => {
  it('adds :00 seconds to top-level and nested datetimes', () => {
    const out = repairToolInput('u_secs', {
      window_from: '2026-11-08T12:00+05:30',
      slot: { start: '2026-11-08T12:00Z', end: '2026-11-08T13:00:30+05:30' },
    });
    expect(out).toEqual({
      window_from: '2026-11-08T12:00:00+05:30',
      slot: { start: '2026-11-08T12:00:00Z', end: '2026-11-08T13:00:30+05:30' },
    });
  });

  it('resolves a provider name from this user\'s last search only', () => {
    rememberSearchResults('u_a', PROVIDERS);
    rememberSearchResults('u_b', [{ id: 'prv_zzz', name: 'Other Co' }]);
    expect(repairToolInput('u_a', { provider_id: 'sri sai plumbing' })).toEqual({ provider_id: 'prv_aaa' });
    expect(repairToolInput('u_b', { provider_id: 'Sri Sai Plumbing' })).toEqual({ provider_id: 'Sri Sai Plumbing' });
    expect(repairToolInput('u_nobody', { provider_id: 'QuickFix Pipes' })).toEqual({ provider_id: 'QuickFix Pipes' });
  });

  it('leaves unknown names and prv_ ids unchanged', () => {
    rememberSearchResults('u_c', PROVIDERS);
    expect(repairToolInput('u_c', { provider_id: 'Nobody Ltd' })).toEqual({ provider_id: 'Nobody Ltd' });
    expect(repairToolInput('u_c', { provider_id: 'prv_bbb' })).toEqual({ provider_id: 'prv_bbb' });
    expect(repairToolInput('u_c', { provider_id: 'prv_unknown' })).toEqual({ provider_id: 'prv_unknown' });
  });
});

describe('repairToolCallFor', () => {
  const call = (input: string): LanguageModelV4ToolCall =>
    ({ type: 'tool-call', toolCallId: 'c1', toolName: 'propose_booking', input }) as LanguageModelV4ToolCall;

  it('returns a repaired call, or null when nothing changes or the input is not JSON', async () => {
    rememberSearchResults('u_d', PROVIDERS);
    const repair = repairToolCallFor('u_d');
    const fixed = await repair({ toolCall: call(JSON.stringify({ provider_id: 'QuickFix Pipes', at: '2026-11-08T12:00Z' })) });
    expect(JSON.parse(fixed!.input)).toEqual({ provider_id: 'prv_bbb', at: '2026-11-08T12:00:00Z' });
    expect(await repair({ toolCall: call(JSON.stringify({ provider_id: 'prv_bbb' })) })).toBeNull();
    expect(await repair({ toolCall: call('not json') })).toBeNull();
  });
});
