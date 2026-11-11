/**
 * Live projects: a share link (http://host/?p=<id>&t=<token>) opens the project on the
 * collaboration server. Tool edits go to everyone who has it open, labelled as an agent.
 */
import { SyncClient, type User } from '@hassassin/sync';
import { DEFAULT_LAYERS, wrapProject, type Project } from '@hassassin/tools';
import type { LayerInfo } from '@hassassin/kicad-import';

export interface LiveLink {
  ws: string;
  id: string;
  token: string;
}

export function parseLiveLink(s: string): LiveLink | null {
  if (!/^https?:\/\//i.test(s)) return null;
  const u = new URL(s);
  const id = u.searchParams.get('p');
  const token = u.searchParams.get('t');
  if (!id || !token) return null;
  return { ws: `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws`, id, token };
}

export interface LiveSession {
  project: Project;
  client: SyncClient;
}

export async function openLive(link: LiveLink, user?: Partial<User>): Promise<LiveSession> {
  const holder: { project: Project | null } = { project: null };
  const me: User = { id: user?.id ?? `agent-${process.pid}`, name: user?.name ?? process.env.HASSASSIN_AGENT_NAME ?? 'AI agent (MCP)', color: user?.color ?? '#b48cff', kind: 'agent' };
  const client = new SyncClient({
    url: link.ws,
    project: link.id,
    token: link.token,
    user: me,
    target: {
      doc: () => holder.project!.doc,
      history: () => holder.project!.history,
      replace: (doc) => {
        const layers = (doc.meta.layers as LayerInfo[] | undefined) ?? DEFAULT_LAYERS;
        const fresh = wrapProject(doc, layers, holder.project?.name ?? 'live');
        if (holder.project) Object.assign(holder.project, fresh);
        else holder.project = fresh;
      },
      changed: () => holder.project?.engine.recompute(),
    },
  });
  await client.connect();
  holder.project!.name = client.project?.name ?? holder.project!.name;
  client.sendPresence(null, []);
  return { project: holder.project!, client };
}

/** Run a tool on a live project; refused or rolled-back edits become errors. */
export async function runLive(s: LiveSession, run: () => Promise<unknown>, mutates = false): Promise<unknown> {
  if (mutates && s.client.role !== 'edit') {
    throw new Error(`This link gives ${s.client.role} access to “${s.project.name}”; changing it needs an edit link.`);
  }
  const problems: string[] = [];
  const off = s.client.on('rejected', (r) => problems.push(r.reason));
  try {
    const result = await run();
    await s.client.flush();
    if (problems.length) throw new Error(`The server did not accept the change: ${problems.join('; ')}`);
    return result;
  } finally {
    off();
  }
}
