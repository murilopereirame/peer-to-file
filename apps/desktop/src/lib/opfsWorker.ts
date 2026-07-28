// Dedicated worker entry for OPFS piece I/O. The implementation lives in
// @p2f/shared (opfsWorkerCore.ts) so the web client runs the exact same code;
// this file exists because `new Worker(new URL('./opfsWorker.ts',
// import.meta.url))` has to resolve to a module inside this app's own source
// tree for Vite to emit a worker chunk for it (see opfsChunkStore's factory
// registration in torrentDownloads.ts).
import { installOpfsWorker, type OpfsWorkerScope } from '@p2f/shared/src/opfsWorkerCore.ts'

installOpfsWorker(self as unknown as OpfsWorkerScope)
