import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('@tfx/postgres package export guard', () => {
	it('does not export or pack private database helpers', async () => {
		const packed = JSON.parse(
			execFileSync('npm', ['pack', '--dry-run', '--json'], {
				cwd: new URL('..', import.meta.url),
				encoding: 'utf8',
			}),
		)[0] as { files: ReadonlyArray<{ path: string }> };
		expect(
			packed.files.some((file) => file.path.includes('test/internal')),
		).toBe(false);
		const privatePath: string = '@tfx/postgres/test/internal/PostgresTestLayer';
		await expect(import(privatePath)).rejects.toBeDefined();
	});
});
