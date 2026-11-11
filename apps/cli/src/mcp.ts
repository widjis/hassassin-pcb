/**
 * MCP server over stdio (newline-delimited JSON-RPC 2.0), implemented directly.
 * Every project tool takes a `project` argument: a path to a .hpcb file (or KiCad
 * files for read-only tools). Projects stay loaded between calls so undo/redo work
 * within a session; changes are written back to the .hpcb after each mutating call.
 */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { newProject, saveProject, ToolError, TOOLS, runTool, type Project } from '@hassassin/tools';
import { isHpcb, loadGeometry, mtime, readProject, writeAny, writeProject } from './io.ts';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Hassassin PCB: design electronics end to end.
Typical flow: project_status → set_spec (requirements) → add_part / connect_pins / add_label (schematic) → run_erc → update_pcb → move_part / route / set_rule / refill_pours (layout) → run_drc → export_fab.
Projects are .hpcb files; create one with new_project or import_kicad. Targets accept a part ("R1"), a pin/pad ("R1.2"), a uid, or a CSS-like selector ("net[netClass=power] > trace"). Values take units ("0.4mm", "10mil").`;

interface Cached {
  project: Project;
  mtime: number;
}

const projectProp = { type: 'string', description: 'Path to the project (.hpcb). Read-only tools also accept a .kicad_pcb (its .kicad_sch files are loaded too).' };

const EXTRA_TOOLS = [
  {
    name: 'new_project',
    description: 'Create an empty project (.hpcb) with a root schematic sheet and a 50×40 mm board outline.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Where to write the .hpcb' } }, required: ['path'] },
  },
  {
    name: 'import_kicad',
    description: 'Convert a KiCad project to .hpcb. Give the .kicad_pcb (sibling .kicad_sch files are picked up) and/or schematic files.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, out: { type: 'string' } }, required: ['files', 'out'] },
  },
];

export async function serveMcp(version: string): Promise<void> {
  const cache = new Map<string, Cached>();
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const log = (...a: unknown[]) => process.stderr.write(`[hassassin-mcp] ${a.join(' ')}\n`);

  const getProject = async (path: string): Promise<Project> => {
    const abs = resolve(path);
    const m = await mtime(abs);
    const hit = cache.get(abs);
    if (hit && (hit.mtime === m || hit.project.dirty)) return hit.project;
    const project = await readProject([abs]);
    cache.set(abs, { project, mtime: m });
    return project;
  };

  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'new_project') {
      const path = String(args.path ?? '');
      if (!isHpcb(path)) throw new ToolError('path must end with .hpcb');
      await writeAny(path, saveProject(newProject(path.replace(/\.hpcb$/i, '').split('/').pop())));
      return { created: path };
    }
    if (name === 'import_kicad') {
      const files = (Array.isArray(args.files) ? args.files : []).map(String);
      const out = String(args.out ?? '');
      if (!files.length || !isHpcb(out)) throw new ToolError('Give files and an .hpcb "out" path.');
      const p = await readProject(files);
      await writeProject(p, out);
      return { created: out, parts: [...p.doc.nodes.values()].filter((n) => n.type === 'element').length };
    }
    const path = args.project;
    if (typeof path !== 'string' || !path) throw new ToolError('Every tool needs "project": a path to a .hpcb file.');
    const p = await getProject(path);
    const rest = { ...args };
    delete rest.project;
    if (name === 'refill_pours') await loadGeometry();
    const tool = TOOLS.find((t) => t.name === name);
    if (tool?.mutates && !isHpcb(path)) throw new ToolError(`"${name}" changes the project; import it first with import_kicad (KiCad files are read-only).`);
    const result = await runTool(p, name, rest, { writeFile: writeAny });
    if (p.dirty) {
      await writeProject(p, path);
      cache.set(resolve(path), { project: p, mtime: await mtime(resolve(path)) });
    }
    return result;
  };

  const handle = async (msg: { id?: string | number; method?: string; params?: Record<string, unknown> }) => {
    const { id, method, params } = msg;
    const reply = (result: unknown) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const error = (code: number, message: string) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const asked = String(params?.protocolVersion ?? '');
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hassassin-pcb', title: 'Hassassin PCB', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: [
            ...EXTRA_TOOLS,
            ...TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: { type: 'object', properties: { project: projectProp, ...t.input.properties }, required: ['project', ...(t.input.required ?? [])] },
              annotations: { readOnlyHint: !t.mutates, destructiveHint: false, idempotentHint: !t.mutates },
            })),
          ],
        });
      case 'tools/call': {
        const name = String(params?.name ?? '');
        try {
          const result = await callTool(name, (params?.arguments ?? {}) as Record<string, unknown>);
          const structured = result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
          return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: structured, isError: false });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        if (method?.startsWith('notifications/')) return; // no response to notifications
        return error(-32601, `Method not found: ${method}`);
    }
  };

  const rl = createInterface({ input: process.stdin });
  let queue: Promise<unknown> = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    // Handle calls one at a time so edits to the same project never interleave.
    queue = queue
      .then(async () => {
        await handle(msg);
      })
      .catch((e) => log('handler crashed:', (e as Error).message));
  });
  await new Promise<void>((done) => rl.on('close', () => queue.then(() => done())));
}
