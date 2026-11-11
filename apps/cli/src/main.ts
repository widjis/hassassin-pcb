/**
 * hassassin — command-line access to Hassassin PCB projects (for people, scripts and AI agents).
 *
 *   hassassin tools                               list every tool
 *   hassassin new <out.hpcb>                      empty project (schematic sheet + 50×40 mm board)
 *   hassassin import <board.kicad_pcb> [sch…] -o <out.hpcb>
 *   hassassin <tool> <project> [args] [--key value] [--json '{…}'] [-o out.hpcb]
 *   hassassin mcp                                 MCP server on stdin/stdout
 *
 * Output is JSON on stdout. Exit codes: 0 ok, 1 error, 2 checks found errors (--fail-on-error).
 */
import { newProject, ToolError, TOOL_MAP, TOOLS, runTool, saveProject, type ToolDef } from '@hassassin/tools';
import { isHpcb, loadGeometry, readProject, toolContext, writeAny, writeProject } from './io.ts';
import { serveMcp } from './mcp.ts';
import { openLive, parseLiveLink, runLive } from './live.ts';
import { AgentSession, type AgentEvent } from '@hassassin/tools';

const VERSION = '0.5.0';

/** Positional arguments after the project, per tool. */
const POSITIONAL: Record<string, string[]> = {
  query: ['selector'],
  inspect: ['target'],
  netlist: ['filter'],
  set_rule: ['target', 'rule', 'value'],
  set_property: ['target', 'key', 'value'],
  add_part: ['kind', 'x', 'y'],
  connect_pins: ['from', 'to'],
  add_label: ['pin', 'name'],
  move_part: ['ref', 'x', 'y', 'rotation'],
  route: ['from', 'to'],
  export_fab: ['out'],
  search_parts: ['query'],
  get_part: ['id'],
  search_footprints: ['query'],
  place_part: ['id', 'x', 'y'],
  assign_footprint: ['ref', 'footprint'],
  set_part_info: ['ref'],
  import_offers: ['file'],
  set_offer: ['mpn', 'supplier', 'prices'],
  import_kicad_library: ['files'],
};

function print(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

function fail(message: string, code = 1): never {
  print({ error: message });
  process.exit(code);
}

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-o') {
      flags.out = argv[++i] ?? '';
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else flags[a.slice(2)] = true;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

const snake = (s: string) => s.replace(/-/g, '_');

function coerce(tool: ToolDef, key: string, raw: string | true): unknown {
  const schema = tool.input.properties[key];
  if (raw === true) return true;
  if (!schema) return raw;
  if (schema.type === 'number') return Number(raw);
  if (schema.type === 'boolean') return raw !== 'false' && raw !== '0';
  if (schema.type === 'array') return raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map((s) => s.trim());
  return raw;
}

function usage(): string {
  return [
    `hassassin ${VERSION} — Hassassin PCB from the command line`,
    '',
    'Commands:',
    '  tools                                   list tools and their arguments',
    '  new <out.hpcb>                          start an empty project',
    '  import <board.kicad_pcb> [sch…] -o <out.hpcb>   convert a KiCad project (sibling .kicad_sch files are picked up)',
    '  mcp                                     run as an MCP server (stdio)',
    '  agent <project> "<request>" [--mode ask] [-o out.hpcb]   let the AI agent work on the project (needs Anthropic credentials)',
    '  <tool> <project> [positional…] [--arg value] [--json \'{…}\'] [-o out.hpcb] [--fail-on-error]',
    '',
    'Examples:',
    '  hassassin project-status board.hpcb',
    '  hassassin query board.hpcb "net[netClass=power] > trace"',
    '  hassassin set-rule board.hpcb "net#GND" pourLayers "F.Cu B.Cu"',
    '  hassassin add-part board.hpcb resistor 20 10 --value 4k7',
    '  hassassin run-drc board.hpcb --fail-on-error',
    '  hassassin search-parts board.hpcb "ldo 3.3"',
    '  hassassin place-part board.hpcb kicad:Regulator_Linear:AMS1117-3.3 40 20',
    '  hassassin assign-footprint board.hpcb R1 chip-0805',
    '  hassassin bom board.hpcb --boards 50',
    '',
    `Tools: ${TOOLS.map((t) => t.name.replace(/_/g, '-')).join(', ')}`,
  ].join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional.shift();
  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (cmd === 'version' || flags.version) return print({ version: VERSION });
  if (cmd === 'mcp') return serveMcp(VERSION);
  if (cmd === 'tools') {
    return print(
      TOOLS.map((t) => ({
        command: t.name.replace(/_/g, '-'),
        mutates: t.mutates,
        positional: POSITIONAL[t.name] ?? [],
        args: Object.fromEntries(Object.entries(t.input.properties).map(([k, s]) => [k, `${s.type}${(t.input.required ?? []).includes(k) ? ' (required)' : ''}${s.description ? ` — ${s.description}` : ''}`])),
        description: t.description,
      })),
    );
  }
  if (cmd === 'new') {
    const out = positional[0] ?? (typeof flags.out === 'string' ? flags.out : undefined);
    if (!out) fail('Usage: hassassin new <out.hpcb>');
    const p = newProject(out.replace(/\.hpcb$/i, '').split('/').pop());
    await writeAny(out, saveProject(p));
    return print({ created: out });
  }
  if (cmd === 'import') {
    const out = typeof flags.out === 'string' ? flags.out : undefined;
    if (!positional.length || !out) fail('Usage: hassassin import <board.kicad_pcb> [schematics…] -o <out.hpcb>');
    const p = await readProject(positional);
    await writeProject(p, out);
    const nodes = [...p.doc.nodes.values()];
    return print({ created: out, parts: nodes.filter((n) => n.type === 'element').length, symbols: nodes.filter((n) => n.type === 'symbol').length, sheets: nodes.filter((n) => n.type === 'sheet').length });
  }

  if (cmd === 'agent') return agentCommand(positional, flags);

  const tool = TOOL_MAP.get(snake(cmd));
  if (!tool) fail(`Unknown command "${cmd}". Run "hassassin help".`);
  const projectPath = positional.shift();
  if (!projectPath) fail(`Usage: hassassin ${cmd} <project.hpcb> …`);

  const args: Record<string, unknown> = {};
  (POSITIONAL[tool.name] ?? []).forEach((k, i) => {
    if (positional[i] !== undefined) args[k] = coerce(tool, k, positional[i]!);
  });
  for (const [k, v] of Object.entries(flags)) {
    if (['json', 'out', 'fail-on-error'].includes(k)) continue;
    args[snake(k)] = coerce(tool, snake(k), v);
  }
  if (typeof flags.json === 'string') Object.assign(args, JSON.parse(flags.json));
  // For export-fab, -o is the zip path.
  if (tool.name === 'export_fab' && typeof flags.out === 'string' && args.out === undefined) args.out = flags.out;

  const link = parseLiveLink(projectPath);
  if (link) {
    const s = await openLive(link);
    if (tool.name === 'refill_pours') await loadGeometry();
    try {
      print(await runLive(s, () => runTool(s.project, tool.name, args, toolContext()), tool.mutates));
    } finally {
      s.client.close();
    }
    return;
  }
  const p = await readProject([projectPath]);
  if (tool.name === 'refill_pours') await loadGeometry();
  const result = await runTool(p, tool.name, args, toolContext());
  if (tool.mutates && p.dirty) {
    const target = typeof flags.out === 'string' && tool.name !== 'export_fab' ? flags.out : projectPath;
    if (!isHpcb(target)) fail(`"${tool.name}" changes the project; write it as .hpcb with -o project.hpcb (KiCad files are read-only here).`);
    await writeProject(p, target);
    print({ ...(typeof result === 'object' && result ? result : { result }), saved: target });
  } else print(result);
  if (flags['fail-on-error'] && typeof result === 'object' && result && Number((result as { errors?: number }).errors) > 0) process.exit(2);
}

/** One agent request against a file or a live link. Progress goes to stderr, a JSON summary to stdout. */
async function agentCommand(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const [projectPath, ...rest] = positional;
  const prompt = rest.join(' ').trim();
  if (!projectPath || !prompt) fail('Usage: hassassin agent <project.hpcb | share link> "<request>" [--mode ask] [-o out.hpcb]');
  const { anthropicModel, hasAnthropicCredentials } = await import('../../../packages/tools/src/agentModel.ts');
  if (!hasAnthropicCredentials()) process.stderr.write('Note: no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN set; trying the SDK\'s other credential sources.\n');
  const mode = flags.mode === 'ask' ? 'ask' : 'agent';
  const ctx = toolContext();
  const link = parseLiveLink(projectPath);
  const live = link ? await openLive(link) : null;
  const p = live ? live.project : await readProject([projectPath]);
  await loadGeometry();
  const session = new AgentSession({
    model: anthropicModel(),
    mode,
    runTool: (name, args) => {
      const def = TOOL_MAP.get(name);
      const run = () => runTool(p, name, args, ctx);
      return live ? runLive(live, run, def?.mutates ?? false) : run();
    },
  });
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  const out = { text: '', tools: 0, errors: [] as string[], tasks: [] as unknown[], usage: { input: 0, output: 0, cacheRead: 0 } };
  await session.send(
    prompt,
    (e: AgentEvent) => {
      if (e.type === 'text') (process.stderr.write(e.text), (out.text += e.text));
      else if (e.type === 'tool') (process.stderr.write(`\n  → ${e.name} ${JSON.stringify(e.input).slice(0, 100)}\n`), out.tools++);
      else if (e.type === 'tool_result' && !e.ok) process.stderr.write(`    ✗ ${e.summary}\n`);
      else if (e.type === 'tasks') out.tasks = e.tasks;
      else if (e.type === 'usage') (out.usage.input += e.input), (out.usage.output += e.output), (out.usage.cacheRead += e.cacheRead);
      else if (e.type === 'error') (out.errors.push(e.message), process.stderr.write(`\n  ! ${e.message}\n`));
    },
    ac.signal,
  );
  process.stderr.write('\n');
  if (live) live.client.close();
  else if (p.dirty) {
    const target = typeof flags.out === 'string' ? flags.out : projectPath;
    if (!isHpcb(target)) fail('The agent changed the project; save it as .hpcb with -o project.hpcb.');
    await writeProject(p, target);
    (out as Record<string, unknown>).saved = target;
  }
  print(out);
}

main(process.argv.slice(2)).catch((e) => fail(e instanceof ToolError ? e.message : (e as Error).message ?? String(e)));
