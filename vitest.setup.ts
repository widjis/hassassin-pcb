// Load the WebAssembly geometry engine once for all tests.
import { loadNativeClipperLibInstanceAsync, NativeClipperLibRequestedFormat } from 'js-angusj-clipper';
import { setClipper } from './packages/core/src/clip.ts';

setClipper(await loadNativeClipperLibInstanceAsync(NativeClipperLibRequestedFormat.WasmOnly));
