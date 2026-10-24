import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(
	root,
	'node_modules/.bin',
	process.platform === 'win32' ? 'effect-tsgo.cmd' : 'effect-tsgo',
);

// The patcher checks versions itself, including upgrades of an existing patch.
execFileSync(executable, ['patch', '--typescript'], {
	cwd: root,
	stdio: 'inherit',
});
