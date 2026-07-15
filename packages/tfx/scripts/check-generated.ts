import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const sourceFiles = [
	resolve(root, '.repos/telegram-api/specs/telegram-bot-api.openapi.json'),
	...[
		'001-server.json',
		'002-default-responses.json',
		'003-input-files.json',
	].map((name) => resolve(root, 'packages/tfx/openapi/patches', name)),
];
const actualManifest =
	sourceFiles
		.map(
			(file) =>
				`${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${file.split('/').at(-1)}`,
		)
		.join('\n') + '\n';
const expectedManifest = readFileSync(
	resolve(root, 'packages/tfx/openapi/telegram-sources.sha256'),
	'utf8',
);
if (actualManifest !== expectedManifest)
	throw new Error('Telegram source/patch SHA256 manifest differs');

const directory = mkdtempSync(join(tmpdir(), 'tfx-telegram-'));
const candidate = join(directory, 'TelegramApi.ts');
try {
	execFileSync(
		'node',
		[resolve(root, 'packages/tfx/scripts/generate-telegram.ts'), candidate],
		{ cwd: root, stdio: 'inherit' },
	);
	for (const name of [
		'TelegramApi.ts',
		'TelegramApi.types.ts',
		'TelegramApi.runtime.js',
		'TelegramApi.runtime.d.ts',
	]) {
		const expected = resolve(
			root,
			'packages/tfx/src/internal/telegram/generated',
			name,
		);
		const actual = join(directory, name);
		if (!readFileSync(expected).equals(readFileSync(actual))) {
			throw new Error(
				`${name} differs; run pnpm --filter tfx telegram:generate`,
			);
		}
	}
} finally {
	rmSync(directory, { recursive: true, force: true });
}
