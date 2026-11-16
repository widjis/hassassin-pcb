#!/usr/bin/env node
// Stand-in for the `claude` launcher: it starts the real program as a child (here a sleeping Node process,
// its pid written to the file in FAKE_CHILD_PID) and waits, as the installed command does.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-slow' }) + '\n');
setInterval(() => {}, 1000);
