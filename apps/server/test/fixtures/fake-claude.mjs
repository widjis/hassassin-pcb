#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`: prints a scripted event stream.
const args = process.argv.slice(2);
const resume = args.includes('--resume');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['mcp__hassassin__project_status'] });
if (!args.includes('--strict-mcp-config') || args[args.indexOf('--tools') + 1] !== '') {
  out({ type: 'result', subtype: 'error', is_error: true, result: 'unsafe flags' });
  process.exit(0);
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: resume ? 'Again.' : 'Checking.' }, { type: 'tool_use', id: 't1', name: 'mcp__hassassin__update_tasks', input: { tasks: [{ title: 'Look', status: 'doing' }] } }, { type: 'tool_use', id: 't2', name: 'mcp__hassassin__run_erc', input: {} }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }, { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '{"errors":2,"warnings":0}' }] }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Two ERC errors.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Two ERC errors.', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } });
