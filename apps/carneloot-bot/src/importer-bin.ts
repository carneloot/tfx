/* eslint-disable @typescript-eslint/consistent-type-assertions */
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { parseArgs, CliError } from './importer/Cli.js';
import { layerFrom } from './importer/LegacyImportConfig.js';
import { run } from './importer/LegacyImporter.js';
import * as LegacySourceLive from './importer/LegacySourceLive.js';
import * as LegacyTargetLive from './importer/LegacyTargetLive.js';
const program = Effect.gen(function* () {
	const config = yield* Effect.try({
		try: () => parseArgs(process.argv.slice(2)),
		catch: (e) => e as CliError,
	});
	const infrastructure = Layer.merge(
		LegacySourceLive.layer,
		LegacyTargetLive.layer,
	).pipe(
		Layer.provideMerge(PgClient.layer({ url: config.databaseUrl })),
		Layer.provideMerge(layerFrom(config)),
	);
	const report = yield* Effect.provide(run, infrastructure);
	process.stdout.write(
		`legacy import: ${report.blockers.length} blocker(s), ${report.warnings.length} warning(s)`,
	);
	if (report.blockers.length) process.exitCode = 1;
}).pipe(
	Effect.catchIf(
		(e): e is CliError => e instanceof CliError,
		(e) =>
			Effect.sync(() => {
				(e.exitCode === 0 ? process.stdout : process.stderr).write(
					`${e.message}\n`,
				);
				process.exitCode = e.exitCode;
			}),
	),
);
BunRuntime.runMain(program as Effect.Effect<void, unknown, never>);
