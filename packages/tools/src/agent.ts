/**
 * The in-app AI agent: a Claude tool-use loop over the same tool definitions the CLI and
 * the MCP server expose. It keeps a visible task list, works stage by stage
 * (requirements → schematic → components → layout → review → fabrication), and every
 * edit goes through the project's command layer (undoable, shared with collaborators).
 *
 * The model call is injected (`ModelCall`), so the loop runs with the real API on the
 * server/CLI and with a scripted model in tests. Only type imports from the SDK here, so
 * this file is safe for the browser bundle.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { TOOLS, ToolError } from './tools.ts';

export type AgentMessage = Anthropic.Beta.BetaMessageParam;
export type AgentParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

/** One model request; `onText` receives streamed answer text. */
export type ModelCall = (params: AgentParams, onText: (text: string) => void, signal?: AbortSignal) => Promise<Anthropic.Beta.BetaMessage>;

export const AGENT_MODEL = 'claude-opus-5-5';

export type AgentMode = 'ask' | 'agent';

export interface AgentTask {
  title: string;
  status: 'todo' | 'doing' | 'done' | 'blocked';
  stage?: string;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'note'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string; detail?: string }
  | { type: 'tasks'; tasks: AgentTask[] }
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string };

/** Tools the agent may not use: they touch the host's files or bypass the typed tools. */
const HIDDEN = new Set(['export_fab', 'import_kicad_library', 'apply_ops']);

const TASK_TOOL = {
  name: 'update_tasks',
  description:
    'Replace the task list shown to the user. Use it at the start of any multi-step request (plan), and update statuses as you go (doing → done). Keep tasks short and concrete; mark one "doing" at a time.',
  input_schema: {
    type: 'object' as const,
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
            stage: { type: 'string', enum: ['requirements', 'schematic', 'components', 'layout', 'review', 'fabrication'] },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['tasks'],
  },
};

export function agentTools(mode: AgentMode): Anthropic.Beta.BetaTool[] {
  const defs = TOOLS.filter((t) => !HIDDEN.has(t.name) && (mode === 'agent' || !t.mutates)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
  return [...defs, { ...TASK_TOOL, eager_input_streaming: true }];
}

export const AGENT_SYSTEM = `You are the design assistant inside Hassassin, a browser-based PCB design tool. You help an electronics engineer take a board from requirements to fabrication files, working through the project's stages:
1. Requirements – the spec (goal, supply, current, interfaces, size, environment, quantity). Ask about missing essentials; record answers with set_spec.
2. Schematic – circuit blocks and connections; ERC must be clean.
3. Components – every part has a real footprint and a manufacturer part number (MPN); check price/stock with bom.
4. Layout – placement, routing, pours; DRC clean and no unrouted connections.
5. Review – look for problems (decoupling, current capacity, thermal, ESD, DFM) and explain them.
6. Fabrication – the user exports Gerbers/drill/BOM from the app.

How to work:
- Start every request by looking at the project (project_status, then query/inspect/list_parts as needed). Never assume what is in the design.
- For anything that takes more than two steps, first publish a short plan with update_tasks, then keep it current.
- Use the tools for every change; changes are undoable and visible to collaborators in real time.
- Prefer library parts (search_parts, place_part) with real footprints over generic ones when the user names a specific part. Use generic parts for passives unless the user wants something else.
- Never invent manufacturer part numbers, prices, stock, or datasheet values. If you are not sure a value is right, say so and ask, or leave it for the user.
- Stay within what the user asked. Before deleting or replacing large parts of the design, describe what you will do and ask.
- Board size and shape: set_board_outline (a new project starts with a 50 × 40 mm placeholder board). Do it before placing parts.
- After edits, run the relevant check (run_erc after schematic work, run_drc after layout work) and report the result honestly, including what is still open.
- Positions are millimetres. Schematic grid is 1.27 mm; place parts with some space between them.
- Schematic style (people must be able to read and trace it):
  - Connect parts with wires (connect_pins). Arrange each block so connected pins are close and aligned, then wire them. Do not build a schematic out of labels alone.
  - Every ground and supply connection uses a power symbol (add_power with GND, +3V3, +5V, +20V, …), never a plain label. Add a PWR_FLAG (add_power flag=true) on rails that are fed from a connector or other passive pin.
  - Use net labels only for signals that run between blocks or far across the sheet (for example SDA, SCL, LED_DATA), and give them clear names.
  - Keep blocks apart (power, MCU, LED driver, sensors, connectors) and leave room between them.
  - To tidy a block after wiring, move_symbol keeps every connection; there is no need to rewire.
  - Parts snap so their pins sit on the 2.54 mm grid. Place a part so the pin it connects to is on the same row (or column) as the other pin, then the wire is straight; run tidy_wires after wiring a block to straighten what is left.
  - Keep the sheet compact and readable: build each block tightly around its main part (place_relative puts decoupling capacitors, pull-ups or dividers in a row next to an IC; align lines parts up), leave about 10 mm between blocks, and do not spread parts over the whole sheet. Texts are placed automatically so they do not overlap.
- Be concise. When you finish, summarise what changed and what the user should look at next.`;

export interface AgentOptions {
  model: ModelCall;
  /** Runs one tool on the project (throws ToolError for user-facing failures). */
  runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  mode?: AgentMode;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxSteps?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters; ask with a narrower query)` : s);

function summarise(name: string, v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (name === 'run_drc' || name === 'run_erc') return `${o.errors ?? 0} error(s)${o.warnings !== undefined ? `, ${o.warnings} warning(s)` : ''}`;
    if (typeof o.ref === 'string') return `${o.ref}`;
    if (Array.isArray(v)) return `${v.length} result(s)`;
    if (typeof o.total === 'number') return `${o.total} match(es)`;
  }
  return 'ok';
}

/** A conversation with the agent about one project. Append-only history. */
export class AgentSession {
  messages: AgentMessage[] = [];
  tasks: AgentTask[] = [];
  mode: AgentMode;
  private opts: AgentOptions;
  private busy = false;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.mode = opts.mode ?? 'agent';
  }

  get running(): boolean {
    return this.busy;
  }

  private params(): AgentParams {
    return {
      model: AGENT_MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'updates' },
      output_config: { effort: this.opts.effort ?? (this.mode === 'agent' ? 'high' : 'medium') },
      cache_control: { type: 'ephemeral' },
      system: AGENT_SYSTEM,
      tools: agentTools(this.mode),
      tool_choice: { type: 'auto' },
      messages: this.messages,
    } satisfies AgentParams;
  }

  /** Send a user message and run until the model ends its turn. */
  async send(prompt: string, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    if (this.busy) throw new Error('The agent is still working on the previous message.');
    this.busy = true;
    try {
      // Fresh project context with each user turn (kept out of the cached system prompt).
      let status = '';
      try {
        status = JSON.stringify(await this.opts.runTool('project_status', {}));
      } catch (e) {
        status = `(project_status failed: ${(e as Error).message})`;
      }
      this.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `<project_status mode="${this.mode}">\n${clip(status, 20000)}\n</project_status>` },
          { type: 'text', text: prompt },
        ],
      });
      const maxSteps = this.opts.maxSteps ?? 40;
      for (let step = 0; step < maxSteps; step++) {
        if (signal?.aborted) return emit({ type: 'done', reason: 'stopped' });
        const msg = await this.opts.model(this.params(), (t) => emit({ type: 'text', text: t }), signal);
        this.messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
        emit({ type: 'usage', input: msg.usage.input_tokens, output: msg.usage.output_tokens, cacheRead: msg.usage.cache_read_input_tokens ?? 0 });
        for (const b of msg.content) if (b.type === 'thinking' && b.thinking.trim()) emit({ type: 'note', text: b.thinking.trim() });

        if (msg.stop_reason === 'refusal') return emit({ type: 'error', message: 'The model declined this request.' });
        if (msg.stop_reason === 'max_tokens') return emit({ type: 'error', message: 'The reply hit the length limit; ask for a smaller step.' });
        if (msg.stop_reason === 'pause_turn') continue;
        const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (msg.stop_reason !== 'tool_use' || !uses.length) return emit({ type: 'done', reason: msg.stop_reason ?? 'end_turn' });

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const u of uses) {
          const input = (u.input && typeof u.input === 'object' ? u.input : null) as Record<string, unknown> | null;
          emit({ type: 'tool', id: u.id, name: u.name, input: u.input });
          if (!input) {
            results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'INVALID_JSON: the tool input was not a JSON object. Send it again.' });
            continue;
          }
          try {
            let out: unknown;
            if (u.name === 'update_tasks') {
              if (!Array.isArray(input.tasks)) throw new ToolError('"tasks" must be an array');
              this.tasks = (input.tasks as AgentTask[]).map((t) => ({ title: String(t.title), status: (['todo', 'doing', 'done', 'blocked'].includes(t.status) ? t.status : 'todo') as AgentTask['status'], ...(t.stage ? { stage: String(t.stage) } : {}) }));
              emit({ type: 'tasks', tasks: this.tasks });
              out = { ok: true };
            } else {
              const def = TOOLS.find((t) => t.name === u.name);
              if (!def || HIDDEN.has(u.name)) throw new ToolError(`Unknown tool ${u.name}`);
              if (def.mutates && this.mode !== 'agent') throw new ToolError('Ask mode is read-only; the user can switch to Agent mode to allow edits.');
              out = await this.opts.runTool(u.name, input);
            }
            const text = JSON.stringify(out ?? null);
            results.push({ type: 'tool_result', tool_use_id: u.id, content: clip(text, 16000) });
            emit({ type: 'tool_result', id: u.id, name: u.name, ok: true, summary: summarise(u.name, out), detail: clip(JSON.stringify(out ?? null, null, 2), 6000) });
          } catch (e) {
            const message = (e as Error).message ?? String(e);
            results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: message });
            emit({ type: 'tool_result', id: u.id, name: u.name, ok: false, summary: message });
          }
        }
        this.messages.push({ role: 'user', content: results });
      }
      emit({ type: 'error', message: `Stopped after ${maxSteps} steps; say "continue" to go on.` });
    } catch (e) {
      emit({ type: 'error', message: signal?.aborted ? 'Stopped.' : `Agent error: ${(e as Error).message}` });
    } finally {
      this.busy = false;
    }
  }
}
