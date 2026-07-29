import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
describe('tfx package export guard', () => {
	it(
		'does not export or pack private test helpers',
		{ timeout: 30_000 },
		async () => {
			const manifest = JSON.parse(
				readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
			) as { exports: Record<string, string> };
			const packed = JSON.parse(
				execFileSync('npm', ['pack', '--dry-run', '--json'], {
					cwd: new URL('..', import.meta.url),
					encoding: 'utf8',
				}),
			)[0] as { files: ReadonlyArray<{ path: string }> };
			expect(
				packed.files.some((file) => file.path.includes('test/internal')),
			).toBe(false);
			for (const subpath of [
				'MessageHandler',
				'MessageInput',
				'MessageHandlerResult',
			])
				expect(manifest.exports[`./${subpath}`]).toBe(`./src/${subpath}.ts`);
			const privatePath: string = 'tfx/test/internal/FakeTelegram';
			await expect(import(privatePath)).rejects.toBeDefined();
		},
	);
});
