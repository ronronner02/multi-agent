// The packaged-engine probe (U18).
//
// Runs inside the packaged Electron binary with `ELECTRON_RUN_AS_NODE=1`, so it loads the same
// Node ABI the daemon's utility process does and no window is ever created. It answers three
// questions with one JSON line on stdout:
//
//   1. does `resources/engine/node_modules` resolve modules from its own tree?
//   2. does better-sqlite3's win32-x64 prebuild load in Electron and open a real database?
//   3. does the daemon module import from `resources/engine` with no repository checkout, and do
//      the files it reads at import time (`config/team/*`) resolve beside it?
//
// The caller passes the engine root as argv[2] and the database directory as argv[3].

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const engineRoot = process.argv[2];
const databaseRoot = process.argv[3];

function report(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

try {
  // `createRequire` anchored in the engine root is how the utility process resolves a package
  // from this tree: Node walks up from the anchor, never from this file's own directory.
  const requireFromEngine = createRequire(path.join(engineRoot, 'noop.cjs'));
  const sqliteEntry = requireFromEngine.resolve('better-sqlite3');
  const sqlite = requireFromEngine('better-sqlite3');
  const databasePath = path.join(databaseRoot, `probe-${process.pid}.db`);
  const db = new sqlite(databasePath);
  db.exec('CREATE TABLE probe (value TEXT NOT NULL)');
  db.prepare('INSERT INTO probe (value) VALUES (?)').run('packaged');
  const rows = db.prepare('SELECT value FROM probe').all();
  db.close();

  // A native module loads or it throws; the success path also names the binding file so the
  // report can show it came from the staged tree and not from an engine checkout.
  const bindingPath = path.join(path.dirname(path.dirname(sqliteEntry)), 'prebuilds', 'win32-x64.node');

  const daemonEntry = path.join(engineRoot, 'packages', 'daemon', 'dist', 'index.js');
  const daemon = await import(pathToFileURL(daemonEntry).href);

  report({
    ok: true,
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    modules: process.versions.modules,
    engineRoot,
    sqliteResolvedFrom: sqliteEntry,
    bindingPath,
    databasePath,
    rows,
    daemonExports: Object.keys(daemon).sort(),
    startServer: typeof daemon.startServer,
    // The daemon module itself was imported from this tree, not from a checkout.
    daemonResolvedFrom: daemonEntry,
  });
} catch (error) {
  report({ ok: false, error: String(error && error.stack ? error.stack : error) });
  process.exitCode = 1;
}