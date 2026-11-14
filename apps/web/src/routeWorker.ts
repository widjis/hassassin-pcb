/**
 * The autorouter in a Web Worker (docs/05-pcb-improvements.md, P8g), so the editor stays responsive.
 * It gets the board as text, routes it, checks the result with DRC and sends back the ops to apply and
 * the summary; progress messages and snapshots of the routes held so far (the live preview, P4) come
 * while it routes. Cancelling terminates the worker: nothing has
 * touched the editor's board until the result is applied there.
 */
import { loadNativeClipperLibInstanceAsync, NativeClipperLibRequestedFormat } from 'js-angusj-clipper/web';
import { autorouteSummary, checkAutoroute, parseDoc, planAutoroute, setClipper, StyleEngine, type AutorouteOptions, type RouteSnapshot } from '@hassassin/core';

export type RouteRequest = { doc: string; copper: string[]; opts?: AutorouteOptions };
export type RouteMessage =
  | { type: 'progress'; stage: 'route' | 'check'; round?: number; routed?: number; total?: number }
  | { type: 'snapshot'; snap: RouteSnapshot }
  | { type: 'done'; ops: unknown[]; summary: ReturnType<typeof autorouteSummary>; removed: number; checkMs: number }
  | { type: 'error'; message: string };

const post = (m: RouteMessage) => (self as unknown as Worker).postMessage(m);
const clipper = loadNativeClipperLibInstanceAsync(NativeClipperLibRequestedFormat.WasmWithAsmJsFallback).then((lib) => setClipper(lib as unknown as Parameters<typeof setClipper>[0]));

self.onmessage = async (e: MessageEvent<RouteRequest>) => {
  try {
    await clipper;
    const doc = parseDoc(e.data.doc);
    const engine = new StyleEngine(doc);
    const plan = planAutoroute(doc, engine, e.data.copper, { ...e.data.opts, onProgress: (p) => post({ type: 'progress', stage: 'route', ...p }), onSnapshot: (snap) => post({ type: 'snapshot', snap }) });
    post({ type: 'progress', stage: 'check' });
    const checked = checkAutoroute(doc, engine, e.data.copper, plan);
    post({ type: 'done', ops: checked.ops, summary: autorouteSummary(checked.report), removed: checked.removed, checkMs: checked.checkMs });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
