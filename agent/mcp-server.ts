// SPDX-License-Identifier: Apache-2.0
//
// The agent side of DELEGATE, as an MCP server, so Claude (or any MCP
// client) can act as the vault's agent.
//
// The tools only ever act as the *agent* device: it can pay under its
// mandate and read what an agent may know. It cannot heartbeat, withdraw,
// enroll, recover or revoke — those belong to other devices, and the
// contract would refuse them anyway because the agent holds no other secret.
//
// It talks to a running keeproxyd (npm run serve).
//
//   claude mcp add keeproxy -- npx vite-node agent/mcp-server.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = process.env['KEEPROXY_API'] ?? 'http://127.0.0.1:8787';

async function api<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${p}`, { ...init, headers: { 'content-type': 'application/json' } });
  return (await r.json()) as T;
}

interface StateResponse {
  chain: null | {
    address: string;
    phase: string;
    balance: string;
    mandateGeneration: number;
    epochSpend: { key: string; spent: string }[];
  };
  devices: null | {
    agent: { mandate: { capPerEpoch: string; epochSeconds: string; expiresAt: number; generation: string } };
  };
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const server = new McpServer({ name: 'keeproxy-agent', version: '0.1.0' });

server.registerTool(
  'vault_status',
  {
    title: 'Vault status (agent view)',
    description:
      "What this agent may know about the vault: its phase and NIGHT balance, and this agent's own mandate terms " +
      '(cap per epoch, epoch length, expiry, whether it is still current).',
    inputSchema: {},
  },
  async () => {
    const s = await api<StateResponse>('/api/state');
    if (!s.chain || !s.devices) return text('No vault is deployed yet.');
    const m = s.devices.agent.mandate;
    const current = Number(m.generation) === s.chain.mandateGeneration;
    return text(
      [
        `Vault ${s.chain.address} is ${s.chain.phase}, holding ${s.chain.balance} NIGHT.`,
        `My mandate: up to ${m.capPerEpoch} NIGHT per ${Number(m.epochSeconds) / 86400}-day epoch, ` +
          `expires ${new Date(m.expiresAt * 1000).toISOString()}.`,
        current ? 'The mandate is current.' : 'The owner has revoked my mandate (kill switch).',
        'I can only pay recipients on my private allowlist; the contract checks the cap, the allowlist and the expiry in zero knowledge.',
      ].join('\n'),
    );
  },
);

server.registerTool(
  'pay',
  {
    title: 'Pay from the vault under my mandate',
    description:
      'Pays NIGHT from the vault to a recipient. "payee" is the approved bill account on my allowlist; "stranger" ' +
      'is any other address (the contract will refuse it). A payment over the epoch cap is refused before anything is submitted.',
    inputSchema: {
      amount: z.number().int().positive().describe('Amount of NIGHT to pay'),
      recipient: z.enum(['payee', 'stranger']).default('payee'),
      memo: z.string().optional().describe('What the payment is for (kept off chain)'),
    },
  },
  async ({ amount, recipient, memo }) => {
    const r = await api<{ ok: boolean; txId?: string; error?: string }>('/api/act', {
      method: 'POST',
      body: JSON.stringify({ action: 'agentPay', params: { amount, recipient, memo } }),
    });
    return r.ok
      ? text(`Paid ${amount} NIGHT to ${recipient}${memo ? ` for "${memo}"` : ''}. Transaction ${r.txId ?? '(submitted)'}.`)
      : text(`Refused by the vault contract: ${r.error}. Nothing was submitted.`);
  },
);

server.registerTool(
  'request_limit_raise',
  {
    title: 'Ask the owner for a higher limit',
    description:
      'The agent cannot raise its own cap. This records a request the owner sees in the Keeproxy console; ' +
      'the owner would issue a new mandate if they agree.',
    inputSchema: { amount: z.number().int().positive(), reason: z.string() },
  },
  async ({ amount, reason }) => {
    const message = `Agent asks to raise its cap to ${amount} NIGHT/epoch: ${reason}`;
    const r = await api<{ ok: boolean }>('/api/act', {
      method: 'POST',
      body: JSON.stringify({ action: 'agentNote', params: { message } }),
    });
    return text(r.ok ? `Sent to the owner's console. I keep my current limits until they issue a new mandate.` : 'Could not reach the console.');
  },
);

await server.connect(new StdioServerTransport());
