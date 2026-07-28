import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Redacted, Ref } from 'effect';
import { Command } from 'effect/unstable/cli';
import { describe, expect, it } from 'vitest';

import { flags, toConfig } from '../../src/importer/Cli.js';
import type { LegacyImportConfigService } from '../../src/importer/LegacyImportConfig.js';

const run = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const result = yield* Ref.make<LegacyImportConfigService | undefined>(
			undefined,
		);
		const command = Command.make('import:legacy', flags, (parsed) =>
			Ref.set(result, toConfig(parsed)),
		);
		yield* Command.runWith(command, { version: 'test' })(args);
		return yield* Ref.get(result);
	}).pipe(Effect.provide(NodeServices.layer));

describe('legacy importer CLI', () => {
	it('parses overrides and redacts secrets', async () => {
		const result = await Effect.runPromise(
			run([
				'--source-url',
				'file:test.db',
				'--source-id',
				'fixture',
				'--bot-id',
				'carneloot',
				'--database-url',
				'postgres://secret',
				'--source-auth-token',
				'token',
				'--dry-run',
				'--report',
				'out.json',
			]),
		);
		if (!result?.sourceAuthToken) throw new Error('Expected source auth token');
		expect(result.dryRun).toBe(true);
		expect(result.reportPath).toBe('out.json');
		expect(String(result.databaseUrl)).not.toContain('secret');
		expect(Redacted.value(result.sourceAuthToken)).toBe('token');
	});

	it('rejects unknown and missing flags', async () => {
		await expect(Effect.runPromise(run(['--wat']))).rejects.toBeDefined();
		await expect(
			Effect.runPromise(run(['--source-url'])),
		).rejects.toBeDefined();
	});
});
