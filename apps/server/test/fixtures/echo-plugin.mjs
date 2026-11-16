#!/usr/bin/env node
// A small agent plugin for the tests (docs/06-agent-plugins.md A1): an MCP server over stdio with two
// tools. `echo` returns its text (and whether the ECHO_KEY setting reached it); `crash` exits the process.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const tools = [
  { name: 'echo', description: 'Return the text it is given.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'crash', description: 'Stop the plugin (for tests).', inputSchema: { type: 'object', properties: {} } },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } });
  if (m.method === 'tools/list') return reply({ tools });
  if (m.method === 'tools/call') {
    if (m.params?.name === 'crash') {
      process.stderr.write('echo plugin: crashing as asked\n');
      process.exit(3);
    }
    if (m.params?.name === 'echo') return reply({ content: [{ type: 'text', text: JSON.stringify({ echo: m.params.arguments?.text ?? '', keySet: !!process.env.ECHO_KEY, apiKeyLeaked: !!process.env.ANTHROPIC_API_KEY }) }] });
    return reply({ content: [{ type: 'text', text: `unknown tool ${m.params?.name}` }], isError: true });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not found' } });
});
