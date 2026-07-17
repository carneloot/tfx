#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Crypto from 'effect/Crypto';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Encoding from 'effect/Encoding';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';

const migrationPattern = /^(\d{4})_[a-z0-9_]+\.sql$/u;

class MigrationArtifactError extends Data.TaggedError('MigrationArtifactError')<{
	readonly message: string;
}> {}

export const renderMigrationArtifact = (
	fileName: string,
	sql: string,
	checksum: string,
): string => {
	const match = migrationPattern.exec(fileName);
	if (match === null) throw new Error(`Invalid migration filename: ${fileName}`);
	const version = match[1];
	const quoteSingle = (value: string) =>
		`'${value
			.replaceAll('\\', '\\\\')
			.replaceAll("'", "\\'")
			.replaceAll('\r', '\\r')
			.replaceAll('\n', '\\n')
			.replaceAll('\t', '\\t')}'`;
	const quotedSql = sql.includes("'") ? JSON.stringify(sql) : quoteSingle(sql);
	return `// Generated from migrations/${fileName}; do not edit.\nexport const migration${version}Sql =\n\t${quotedSql};\nexport const migration${version}Checksum =\n\t${quoteSingle(checksum)};\n`;
};

export const generateMigrationArtifacts = (options: {
	readonly appDirectory: string;
	readonly check: boolean;
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const migrationsDirectory = path.join(options.appDirectory, 'migrations');
		const outputDirectory = path.join(
			options.appDirectory,
			'src',
			'postgres',
		);
		const files = (yield* fs.readDirectory(migrationsDirectory))
			.filter((file) => migrationPattern.test(file))
			.sort();

		if (files.length === 0) {
			return yield* Effect.fail(
				new MigrationArtifactError({
					message: 'No application migrations found',
				}),
			);
		}

		yield* Effect.forEach(
			files,
			(fileName) =>
				Effect.gen(function* () {
					const version = migrationPattern.exec(fileName)![1];
					const sourcePath = path.join(migrationsDirectory, fileName);
					const outputPath = path.join(
						outputDirectory,
						`Migration${version}Sql.ts`,
					);
					const sql = yield* fs.readFileString(sourcePath);
					const digest = yield* crypto.digest(
						'SHA-256',
						new TextEncoder().encode(sql),
					);
					const rendered = renderMigrationArtifact(
						fileName,
						sql,
						Encoding.encodeHex(digest),
					);

					if (options.check) {
						const exists = yield* fs.exists(outputPath);
						const actual = exists
							? yield* fs.readFileString(outputPath)
							: '';
						if (actual !== rendered) {
							return yield* Effect.fail(
								new MigrationArtifactError({
									message: `${outputPath} differs; run pnpm --filter carneloot-bot migrations:generate`,
								}),
							);
						}
						return;
					}

					yield* fs.writeFileString(outputPath, rendered);
					yield* Effect.logInfo('generated migration artifact').pipe(
						Effect.annotateLogs({ migration: fileName, outputPath }),
					);
				}),
			{ concurrency: 'unbounded', discard: true },
		);
	});

const main = Effect.gen(function* () {
	const path = yield* Path.Path;
	const appDirectory = path.resolve(import.meta.dirname, '..');
	yield* generateMigrationArtifacts({
		appDirectory,
		check: process.argv.includes('--check'),
	});
});

if (import.meta.main) {
	main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
