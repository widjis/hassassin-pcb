/**
 * Project storage on disk:
 *   <data>/projects/<id>/meta.json        name, share tokens, public role, lineage
 *   <data>/projects/<id>/snapshot.hpcb    document at `snapshotSeq`
 *   <data>/projects/<id>/log.jsonl        transactions after the snapshot
 *   <data>/projects/<id>/versions/*.hpcb  saved versions (+ versions.json index)
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, fromFile, newUid, toFile, type Doc, type DocFile, type Op } from '@hassassin/core';
import { COMMENTS_CONTAINER, commentsContainer, type ProjectInfo, type Role, type User, type VersionInfo } from '@hassassin/sync';

export interface Meta extends ProjectInfo {
  tokens: Record<string, Role>;
  snapshotSeq: number;
}

export interface LogEntry {
  seq: number;
  at: string;
  user: User;
  label: string;
  ops: Op[];
}

export interface LiveProject {
  meta: Meta;
  doc: Doc;
  seq: number;
  versions: VersionInfo[];
  sinceVersion: number;
  lastVersionAt: number;
}

const CHECKPOINT_EVERY = 200;
const AUTO_VERSION_EVERY_TX = 100;
const AUTO_VERSION_EVERY_MS = 10 * 60 * 1000;

export const token = () => randomBytes(18).toString('base64url');

function ensureComments(doc: Doc): void {
  if (commentsContainer(doc)) return;
  const root = doc.nodes.get(doc.rootId)!;
  applyOps(doc, [
    { op: 'add', parent: doc.rootId, index: root.children.length, tree: { nodes: [{ uid: newUid('comments'), type: 'container', name: COMMENTS_CONTAINER, props: {}, rules: [], parent: doc.rootId, children: [] }] } },
  ]);
}

export class Store {
  private live = new Map<string, LiveProject>();
  private loading = new Map<string, Promise<LiveProject>>();
  private dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'projects');
  }

  private pdir(id: string) {
    if (!/^[\w-]{6,64}$/.test(id)) throw new Error('Bad project id');
    return join(this.dir, id);
  }

  async create(name: string, doc: Doc, forkedFrom?: string): Promise<{ meta: Meta; tokens: Record<Role, string> }> {
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    const tokens: Record<Role, string> = { edit: token(), comment: token(), view: token() };
    const meta: Meta = {
      id,
      name: name || 'Untitled',
      createdAt: new Date().toISOString(),
      ...(forkedFrom ? { forkedFrom } : {}),
      publicRole: 'none',
      tokens: { [tokens.edit]: 'edit', [tokens.comment]: 'comment', [tokens.view]: 'view' },
      snapshotSeq: 0,
    };
    ensureComments(doc);
    const d = this.pdir(id);
    await mkdir(join(d, 'versions'), { recursive: true });
    await writeFile(join(d, 'snapshot.hpcb'), JSON.stringify(toFile(doc)));
    await writeFile(join(d, 'log.jsonl'), '');
    await writeFile(join(d, 'versions.json'), '[]');
    await this.writeMeta(meta);
    return { meta, tokens };
  }

  private async writeMeta(meta: Meta): Promise<void> {
    const p = join(this.pdir(meta.id), 'meta.json');
    await writeFile(p + '.tmp', JSON.stringify(meta, null, 2));
    await rename(p + '.tmp', p);
  }

  exists(id: string): boolean {
    try {
      return existsSync(join(this.pdir(id), 'meta.json'));
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<LiveProject> {
    const hit = this.live.get(id);
    if (hit) return hit;
    let p = this.loading.get(id);
    if (!p) {
      p = this.load(id);
      this.loading.set(id, p);
    }
    try {
      return await p;
    } finally {
      this.loading.delete(id);
    }
  }

  private async load(id: string): Promise<LiveProject> {
    const d = this.pdir(id);
    const meta = JSON.parse(await readFile(join(d, 'meta.json'), 'utf8')) as Meta;
    const doc = fromFile(JSON.parse(await readFile(join(d, 'snapshot.hpcb'), 'utf8')) as DocFile);
    let seq = meta.snapshotSeq;
    const log = (await readFile(join(d, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean);
    for (const line of log) {
      const e = JSON.parse(line) as LogEntry;
      if (e.seq <= seq) continue;
      try {
        applyOps(doc, e.ops);
      } catch {
        /* an entry that failed at write time was never logged; ignore defensive mismatch */
      }
      seq = e.seq;
    }
    ensureComments(doc);
    const versions = JSON.parse(await readFile(join(d, 'versions.json'), 'utf8').catch(() => '[]')) as VersionInfo[];
    const lp: LiveProject = { meta, doc, seq, versions, sinceVersion: 0, lastVersionAt: Date.now() };
    this.live.set(id, lp);
    return lp;
  }

  roleFor(lp: LiveProject, tok?: string): Role | null {
    const r = tok ? lp.meta.tokens[tok] : undefined;
    if (r) return r;
    return lp.meta.publicRole === 'none' ? null : lp.meta.publicRole;
  }

  /** Apply and persist one transaction. Throws (and changes nothing) if the ops do not apply. */
  async commit(lp: LiveProject, user: User, label: string, ops: Op[]): Promise<number> {
    applyOps(lp.doc, ops);
    lp.seq += 1;
    const entry: LogEntry = { seq: lp.seq, at: new Date().toISOString(), user, label, ops };
    await appendFile(join(this.pdir(lp.meta.id), 'log.jsonl'), JSON.stringify(entry) + '\n');
    lp.sinceVersion++;
    if (lp.seq - lp.meta.snapshotSeq >= CHECKPOINT_EVERY) await this.checkpoint(lp);
    if (lp.sinceVersion >= AUTO_VERSION_EVERY_TX || (lp.sinceVersion > 0 && Date.now() - lp.lastVersionAt > AUTO_VERSION_EVERY_MS)) {
      await this.saveVersion(lp, 'Auto-save', 'server', true);
    }
    return lp.seq;
  }

  async checkpoint(lp: LiveProject): Promise<void> {
    const d = this.pdir(lp.meta.id);
    await writeFile(join(d, 'snapshot.hpcb.tmp'), JSON.stringify(toFile(lp.doc)));
    await rename(join(d, 'snapshot.hpcb.tmp'), join(d, 'snapshot.hpcb'));
    lp.meta.snapshotSeq = lp.seq;
    await this.writeMeta(lp.meta);
    await writeFile(join(d, 'log.jsonl'), '');
  }

  async saveVersion(lp: LiveProject, name: string, author: string, auto = false): Promise<VersionInfo> {
    const v: VersionInfo = { id: newUid('v'), name: name || 'Version', seq: lp.seq, at: new Date().toISOString(), author, auto };
    const d = this.pdir(lp.meta.id);
    await writeFile(join(d, 'versions', `${v.id}.hpcb`), JSON.stringify(toFile(lp.doc)));
    lp.versions.unshift(v);
    // Keep the newest 30 automatic versions.
    const autos = lp.versions.filter((x) => x.auto);
    if (autos.length > 30) lp.versions = lp.versions.filter((x) => !x.auto || autos.indexOf(x) < 30);
    await writeFile(join(d, 'versions.json'), JSON.stringify(lp.versions, null, 2));
    lp.sinceVersion = 0;
    lp.lastVersionAt = Date.now();
    return v;
  }

  async versionDoc(lp: LiveProject, versionId: string): Promise<Doc> {
    if (!lp.versions.some((v) => v.id === versionId)) throw new Error('No such version');
    return fromFile(JSON.parse(await readFile(join(this.pdir(lp.meta.id), 'versions', `${versionId}.hpcb`), 'utf8')) as DocFile);
  }

  /** Replace the document with a saved version (the current state is saved first). */
  async restore(lp: LiveProject, versionId: string, author: string): Promise<void> {
    const doc = await this.versionDoc(lp, versionId);
    await this.saveVersion(lp, 'Before restore', author, false);
    lp.doc = doc;
    ensureComments(lp.doc);
    lp.seq += 1;
    await this.checkpoint(lp);
  }

  /** Copy a project. `withHistory` keeps saved versions (fork) or starts fresh (clone). */
  async fork(lp: LiveProject, name: string, withHistory: boolean) {
    const copy = fromFile(JSON.parse(JSON.stringify(toFile(lp.doc))) as DocFile);
    const res = await this.create(name, copy, lp.meta.id);
    if (withHistory) {
      const from = join(this.pdir(lp.meta.id), 'versions');
      const to = join(this.pdir(res.meta.id), 'versions');
      for (const f of await readdir(from)) await writeFile(join(to, f), await readFile(join(from, f)));
      await writeFile(join(this.pdir(res.meta.id), 'versions.json'), JSON.stringify(lp.versions, null, 2));
    }
    return res;
  }

  async setPublic(lp: LiveProject, role: Role | 'none'): Promise<void> {
    lp.meta.publicRole = role;
    await this.writeMeta(lp.meta);
  }

  async rename(lp: LiveProject, name: string): Promise<void> {
    lp.meta.name = name;
    await this.writeMeta(lp.meta);
  }
}
