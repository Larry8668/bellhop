import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { WEB_ORIGIN } from '../api/test-helpers.js';
import { connectMcpClient } from './helpers.js';
import { createApiKeyUser } from './setup.js';
import { findBookableProvider, setupMcpProposeTest, type McpProposeTestContext } from './propose-setup.js';

let ctx: McpProposeTestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content as Array<{ type: string; text?: string }> | undefined;
  return content?.[0]?.text ?? '';
}

function countOf(ctx: McpProposeTestContext, table: string, userId: string): number {
  const row = ctx.db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number };
  return row.n;
}

async function whoami(client: { callTool: (args: { name: string; arguments: Record<string, never> }) => Promise<unknown> }): Promise<string> {
  const result = (await client.callTool({ name: 'whoami', arguments: {} })) as { structuredContent: { userId: string } };
  return result.structuredContent.userId;
}

describe('MCP propose tools: booking approved via elicitation (scenario: happy path)', () => {
  it('propose_booking + accept/confirm:true books, consumes the approval, and succeeds the intent', async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);
    const { client } = await connectMcpClient(
      ctx.server.baseUrl,
      { authorization: `Bearer ${apiKey}` },
      { elicitation: (): ElicitResult => ({ action: 'accept', content: { confirm: true } }) },
    );
    const userId = await whoami(client);
    const provider = await findBookableProvider(ctx.providerClient, ctx.tp.clock, userId);

    const result = await client.callTool({
      name: 'propose_booking',
      arguments: {
        provider_id: provider.id,
        service: provider.service,
        slot: provider.slots[0],
      },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { outcome: { kind: string } };
    expect(structured.outcome.kind).toBe('booked');
    expect(textOf(result)).toContain('Done');

    const bookings = ctx.tp.engine.admin.state().bookings.filter((b) => b.user_id === userId);
    expect(bookings).toHaveLength(1);

    const approvalRow = ctx.db
      .prepare('SELECT status, source FROM approvals WHERE user_id = ?')
      .get(userId) as { status: string; source: string };
    expect(approvalRow.status).toBe('consumed');
    expect(approvalRow.source).toBe('mcp_elicitation');

    const intentRow = ctx.db.prepare('SELECT status FROM intents WHERE user_id = ?').get(userId) as { status: string };
    expect(intentRow.status).toBe('succeeded');
  });
});

describe('MCP propose tools: booking declined via elicitation', () => {
  it('confirm: false declines the proposal and books nothing', async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);
    const { client } = await connectMcpClient(
      ctx.server.baseUrl,
      { authorization: `Bearer ${apiKey}` },
      { elicitation: (): ElicitResult => ({ action: 'accept', content: { confirm: false } }) },
    );
    const userId = await whoami(client);
    const provider = await findBookableProvider(ctx.providerClient, ctx.tp.clock, userId);

    const result = await client.callTool({
      name: 'propose_booking',
      arguments: {
        provider_id: provider.id,
        service: provider.service,
        slot: provider.slots[0],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Declined');

    const bookings = ctx.tp.engine.admin.state().bookings.filter((b) => b.user_id === userId);
    expect(bookings).toHaveLength(0);

    const proposalRow = ctx.db.prepare('SELECT status FROM proposals WHERE user_id = ?').get(userId) as { status: string };
    expect(proposalRow.status).toBe('declined');

    expect(countOf(ctx, 'approvals', userId)).toBe(0);
  });
});

describe('MCP propose tools: client without elicitation support', () => {
  it('leaves the proposal pending and returns the web-approval fallback link', async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);
    const { client } = await connectMcpClient(ctx.server.baseUrl, { authorization: `Bearer ${apiKey}` });
    const userId = await whoami(client);
    const provider = await findBookableProvider(ctx.providerClient, ctx.tp.clock, userId);

    const result = await client.callTool({
      name: 'propose_booking',
      arguments: {
        provider_id: provider.id,
        service: provider.service,
        slot: provider.slots[0],
      },
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain(`${WEB_ORIGIN}/proposals/`);
    const structured = result.structuredContent as { status: string };
    expect(structured.status).toBe('pending');

    const bookings = ctx.tp.engine.admin.state().bookings.filter((b) => b.user_id === userId);
    expect(bookings).toHaveLength(0);

    const proposalRow = ctx.db.prepare('SELECT status FROM proposals WHERE user_id = ?').get(userId) as { status: string };
    expect(proposalRow.status).toBe('pending');
  });
});

describe('MCP propose tools: the model can never supply user_id / approval_id / hash (invariant 2)', () => {
  it('propose_booking rejects an extra user_id argument with isError, by schema (strict)', async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);
    const { client } = await connectMcpClient(ctx.server.baseUrl, { authorization: `Bearer ${apiKey}` });
    const userId = await whoami(client);
    const provider = await findBookableProvider(ctx.providerClient, ctx.tp.clock, userId);

    const result = await client.callTool({
      name: 'propose_booking',
      arguments: {
        provider_id: provider.id,
        service: provider.service,
        slot: provider.slots[0],
        user_id: 'victim',
      },
    });

    expect(result.isError).toBe(true);
    expect(countOf(ctx, 'proposals', userId)).toBe(0);
  });

  it('decline_proposal rejects extra approval_id / hash arguments with isError, by schema (strict)', async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);
    const { client } = await connectMcpClient(ctx.server.baseUrl, { authorization: `Bearer ${apiKey}` });

    const result = await client.callTool({
      name: 'decline_proposal',
      arguments: { proposal_id: 'prop_doesnotmatter', approval_id: 'appr_forged', hash: 'deadbeef' },
    });

    expect(result.isError).toBe(true);
  });

  it('propose_cancel rejects an extra user_id argument with isError, by schema (strict)', async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);
    const { client } = await connectMcpClient(ctx.server.baseUrl, { authorization: `Bearer ${apiKey}` });

    const result = await client.callTool({
      name: 'propose_cancel',
      arguments: { booking_id: 'booking_doesnotmatter', user_id: 'victim' },
    });

    expect(result.isError).toBe(true);
  });

  it("list_proposals for another principal never sees this user's pending proposal (cross-user)", async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);
    const { client } = await connectMcpClient(ctx.server.baseUrl, { authorization: `Bearer ${apiKey}` });
    const userId = await whoami(client);
    const provider = await findBookableProvider(ctx.providerClient, ctx.tp.clock, userId);

    await client.callTool({
      name: 'propose_booking',
      arguments: {
        provider_id: provider.id,
        service: provider.service,
        slot: provider.slots[0],
      },
    });

    const { apiKey: otherApiKey } = await createApiKeyUser(ctx.apiApp);
    const { client: otherClient } = await connectMcpClient(ctx.server.baseUrl, {
      authorization: `Bearer ${otherApiKey}`,
    });

    const result = await otherClient.callTool({ name: 'list_proposals', arguments: {} });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { proposals: unknown[] };
    expect(structured.proposals).toHaveLength(0);
  });
});

describe('MCP propose tools: elicitation in flight never holds the user queue (gate fix item 3)', () => {
  it('list_proposals completes immediately while a propose_booking call is still waiting on elicitInput', async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);

    let elicitationStarted = false;
    let resolveElicitation: ((result: ElicitResult) => void) | undefined;
    const elicitationPromise = new Promise<ElicitResult>((resolve) => {
      resolveElicitation = resolve;
    });

    const { client } = await connectMcpClient(
      ctx.server.baseUrl,
      { authorization: `Bearer ${apiKey}` },
      {
        elicitation: () => {
          elicitationStarted = true;
          return elicitationPromise;
        },
      },
    );
    const userId = await whoami(client);
    const provider = await findBookableProvider(ctx.providerClient, ctx.tp.clock, userId);

    const proposePromise = client.callTool({
      name: 'propose_booking',
      arguments: { provider_id: provider.id, service: provider.service, slot: provider.slots[0] },
    });

    // Wait until the server has actually called elicitInput (proposal
    // created, its queue turn released) before proving the queue is free.
    await vi.waitFor(() => {
      if (!elicitationStarted) throw new Error('elicitation has not started yet');
    });

    const listResult = (await client.callTool({ name: 'list_proposals', arguments: {} })) as unknown as {
      isError?: boolean;
      structuredContent: { proposals: Array<{ id: string; status: string }> };
    };
    expect(listResult.isError).toBeFalsy();
    expect(listResult.structuredContent.proposals).toHaveLength(1);
    expect(listResult.structuredContent.proposals[0]?.status).toBe('pending');

    resolveElicitation?.({ action: 'accept', content: { confirm: true } });
    const proposeResult = await proposePromise;
    expect(proposeResult.isError).toBeFalsy();

    const bookings = ctx.tp.engine.admin.state().bookings.filter((b) => b.user_id === userId);
    expect(bookings).toHaveLength(1);
  });
});

describe('MCP propose tools: provider error on hold', () => {
  it('propose_booking on an unavailable slot returns isError and creates no proposal row', async () => {
    ctx = await setupMcpProposeTest();
    const { apiKey } = await createApiKeyUser(ctx.apiApp);
    const { client } = await connectMcpClient(ctx.server.baseUrl, { authorization: `Bearer ${apiKey}` });
    const userId = await whoami(client);
    const provider = await findBookableProvider(ctx.providerClient, ctx.tp.clock, userId);

    // A slot this provider never offered — the real provider's hold_slot
    // rejects it with `slot_unavailable` (provider/src/engine/holds.ts).
    const bogusSlot = { start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z' };

    const result = await client.callTool({
      name: 'propose_booking',
      arguments: {
        provider_id: provider.id,
        service: provider.service,
        slot: bogusSlot,
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('slot_unavailable');
    expect(countOf(ctx, 'proposals', userId)).toBe(0);
  });
});
