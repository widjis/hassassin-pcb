#!/usr/bin/env node
// Stand-in for `codex exec --json`.
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// Like the real CLI (0.167): `exec resume` has no -s / --sandbox flag.
if (args[0] === 'exec' && args[1] === 'resume' && args.some((a) => a === '-s' || a === '--sandbox')) {
  process.stderr.write("error: unexpected argument '-s' found\n\n  tip: to pass '-s' as a value, use '-- -s'\n\nUsage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\n");
  process.exit(2);
}
// The sandbox must be read-only on every call.
if (!args.includes('sandbox_mode="read-only"')) {
  process.stderr.write('error: expected a read-only sandbox\n');
  process.exit(2);
}
const servers = args[args.findIndex((a) => a.startsWith('mcp_servers='))] ?? '';
out({ type: 'thread.started', thread_id: 'th-1' });
out({ type: 'turn.started' });
if (!servers.includes('HASSASSIN_MCP_READONLY')) out({ type: 'item.completed', item: { id: 'x', type: 'agent_message', text: 'agent mode' } });
out({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'hassassin', tool: 'list_parts', arguments: {}, status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'hassassin', tool: 'list_parts', arguments: {}, result: { content: [{ type: 'text', text: '[{"ref":"R1"}]' }] }, error: null, status: 'completed' } });
out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: args.includes('resume') ? 'resumed' : 'R1 is here.' } });
out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } });
