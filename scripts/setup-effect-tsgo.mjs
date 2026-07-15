import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const getExePathModule = await import(
	pathToFileURL(resolve(root, 'node_modules/typescript/lib/getExePath.js')).href
);
const compiler = getExePathModule.default();

if (existsSync(`${compiler}.original`)) {
	process.stdout.write(
		'Effect TypeScript-Go language service already patched.\n',
	);
} else {
	const executable = resolve(
		root,
		'node_modules/.bin',
		process.platform === 'win32' ? 'effect-tsgo.cmd' : 'effect-tsgo',
	);
	execFileSync(executable, ['patch'], { cwd: root, stdio: 'inherit' });
}
