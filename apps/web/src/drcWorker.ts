/**
 * The design rule check in a Web Worker (docs/05-pcb-improvements.md, P12), so the canvas stays responsive
 * on large boards. It gets the board as text and sends back the result; the editor keeps one worker and asks
 * again with the newest board when a run ends while the board has changed.
 */
import { loadNativeClipperLibInstanceAsync, NativeClipperLibRequestedFormat } from 'js-angusj-clipper/web';
import { parseDoc, runDrc, setClipper, StyleEngine, type DrcResult } from '@hassassin/core';

export type DrcRequest = { seq: number; doc: string; copper: string[] };
export type DrcReply = { seq: number; result: DrcResult } | { seq: number; error: string };

const clipper = loadNativeClipperLibInstanceAsync(NativeClipperLibRequestedFormat.WasmWithAsmJsFallback).then((lib) => setClipper(lib as unknown as Parameters<typeof setClipper>[0]));

self.onmessage = async (e: MessageEvent<DrcRequest>) => {
  const { seq } = e.data;
  try {
    await clipper;
    const doc = parseDoc(e.data.doc);
    const result = runDrc(doc, new StyleEngine(doc), e.data.copper);
    (self as unknown as Worker).postMessage({ seq, result } satisfies DrcReply);
  } catch (err) {
    (self as unknown as Worker).postMessage({ seq, error: (err as Error).message } satisfies DrcReply);
  }
};
