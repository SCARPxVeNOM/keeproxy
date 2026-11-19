// Smoke test for the agent MCP server: lists its tools and calls them, the way
// Claude would. Needs keeproxyd running (npm run serve).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'npx', args: ['vite-node', 'agent/mcp-server.ts'] });
const client = new Client({ name: 'keeproxy-smoke', version: '0.1.0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const say = (r: unknown) => console.log((r as { content: { text: string }[] }).content.map((c) => c.text).join('\n'), '\n');
say(await client.callTool({ name: 'vault_status', arguments: {} }));
say(await client.callTool({ name: 'pay', arguments: { amount: 10, recipient: 'stranger', memo: 'smoke test' } }));
say(await client.callTool({ name: 'request_limit_raise', arguments: { amount: 400, reason: 'annual insurance premium' } }));
await client.close();
