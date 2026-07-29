import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packed = process.argv[2] === undefined;
const packDir = packed
	? mkdtempSync(join(tmpdir(), 'effectloot-pack-'))
	: undefined;
const archive =
	process.argv[2] ??
	(() => {
		execFileSync(
			'pnpm',
			['--filter', 'tfx', 'pack', '--pack-destination', packDir!],
			{
				cwd: root,
				stdio: 'inherit',
				env: { ...process.env, PNPM_CONFIG_IGNORE_SCRIPTS: 'true' },
			},
		);
		const result = readdirSync(packDir!)
			.map((file) => join(packDir!, file))
			.find((file) => file.endsWith('.tgz'));
		if (result === undefined)
			throw new Error('tfx pack did not produce an archive');
		return result;
	})();
const temp = mkdtempSync(join(tmpdir(), 'effectloot-pack-check-'));
try {
	execFileSync('tar', ['-xzf', archive, '-C', temp]);
	const root = join(temp, 'package');
	const manifest = JSON.parse(
		readFileSync(join(root, 'package.json'), 'utf8'),
	) as {
		name: string;
		exports: Record<string, string>;
	};
	for (const [subpath, target] of Object.entries(manifest.exports)) {
		if (subpath.includes('internal') || subpath.includes('RawClient'))
			throw new Error(`Private export found: ${subpath}`);
		if (!existsSync(join(root, target.replace(/^\.\//u, ''))))
			throw new Error(`Missing export target ${subpath} -> ${target}`);
	}
	const files = readdirSync(root, { recursive: true }).map(String);
	if (files.some((file) => /(^|\/)test(s)?\//u.test(file)))
		throw new Error('Packed archive contains tests');
	if (files.some((file) => file.includes('testcontainers')))
		throw new Error('Packed archive contains Testcontainers');
	if (
		manifest.name === 'tfx' &&
		!existsSync(
			join(root, 'dist/internal/telegram/generated/TelegramApi.runtime.js'),
		)
	)
		throw new Error('Packed tfx is missing generated Telegram runtime asset');
	process.stdout.write(
		`packed-package-ok ${manifest.name} exports=${Object.keys(manifest.exports).length}\n`,
	);
} finally {
	rmSync(temp, { recursive: true, force: true });
	if (packed) rmSync(packDir!, { recursive: true, force: true });
}
