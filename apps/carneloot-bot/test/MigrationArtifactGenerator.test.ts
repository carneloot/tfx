import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { describe, expect, it } from 'vitest';

import {
	generateMigrationArtifacts,
	renderMigrationArtifact,
} from '../scripts/generate-migration-artifacts.js';

const withTemporaryApp = <A, E>(
	use: (
		appDirectory: string,
	) => Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const appDirectory = yield* fs.makeTempDirectoryScoped({
			prefix: 'carneloot-migrations-',
		});
		yield* fs.makeDirectory(path.join(appDirectory, 'migrations'));
		yield* fs.makeDirectory(path.join(appDirectory, 'src', 'postgres'), {
			recursive: true,
		});
		return yield* use(appDirectory);
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

describe('migration artifact generator', () => {
	it('renders quotes and newlines as exact TypeScript source', () => {
		const sql = 'SELECT "pet", \'food\';\n';
		expect(renderMigrationArtifact('0007_quote_test.sql', sql, 'abc123')).toBe(
			'// Generated from migrations/0007_quote_test.sql; do not edit.\n' +
				'export const migration0007Sql =\n' +
				'\t"SELECT \\"pet\\", \'food\';\\n";\n' +
				'export const migration0007Checksum =\n' +
				"\t'abc123';\n",
		);
	});

	it('generates every migration in stable version order with lowercase SHA-256', async () => {
		await run(
			withTemporaryApp((appDirectory) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;
					const migrations = path.join(appDirectory, 'migrations');
					const output = path.join(appDirectory, 'src', 'postgres');
					yield* fs.writeFileString(path.join(migrations, '0002_second.sql'), 'def');
					yield* fs.writeFileString(path.join(migrations, 'ignore.txt'), 'ignored');
					yield* fs.writeFileString(path.join(migrations, '0001_first.sql'), 'abc');

					yield* generateMigrationArtifacts({ appDirectory, check: false });
					const first = yield* fs.readFileString(path.join(output, 'Migration0001Sql.ts'));
					const second = yield* fs.readFileString(path.join(output, 'Migration0002Sql.ts'));
					expect(first).toContain(
						"\t'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';",
					);
					expect(first).toMatch(/[a-f0-9]{64}/u);
					expect(second).toContain("export const migration0002Sql =\n\t'def';");

					yield* generateMigrationArtifacts({ appDirectory, check: false });
					expect(yield* fs.readFileString(path.join(output, 'Migration0001Sql.ts'))).toBe(first);
					expect(yield* fs.readFileString(path.join(output, 'Migration0002Sql.ts'))).toBe(second);
				}),
			),
		);
	});

	it('fails check mode when generated output differs from canonical SQL', async () => {
		await expect(
			run(
				withTemporaryApp((appDirectory) =>
					Effect.gen(function* () {
						const fs = yield* FileSystem.FileSystem;
						const path = yield* Path.Path;
						yield* fs.writeFileString(
							path.join(appDirectory, 'migrations', '0001_first.sql'),
							'SELECT 1;\n',
						);
						yield* fs.writeFileString(
							path.join(appDirectory, 'src', 'postgres', 'Migration0001Sql.ts'),
							'stale',
						);
						yield* generateMigrationArtifacts({ appDirectory, check: true });
					}),
				),
			),
		).rejects.toThrow(/Migration0001Sql\.ts differs/u);
	});
});
