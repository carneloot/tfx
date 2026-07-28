import * as Config from 'effect/Config';
import * as Redacted from 'effect/Redacted';
import { Flag } from 'effect/unstable/cli';

import type { LegacyImportConfigService } from './LegacyImportConfig.js';

const required = (flag: string, environment: string, description: string) =>
	Flag.string(flag).pipe(
		Flag.withDescription(`${description} Falls back to ${environment}.`),
		Flag.withFallbackConfig(Config.string(environment)),
	);

const optional = (flag: string, environment: string) =>
	Flag.optional(Flag.string(flag)).pipe(
		Flag.withFallbackConfig(Config.option(Config.string(environment))),
	);

export const flags = {
	sourceUrl: required(
		'source-url',
		'LEGACY_DATABASE_URL',
		'Legacy SQLite file URL or libSQL endpoint.',
	),
	sourceAuthToken: optional('source-auth-token', 'LEGACY_DATABASE_AUTH_TOKEN'),
	sourceId: required(
		'source-id',
		'LEGACY_SOURCE_ID',
		'Stable, operator-assigned identity for this legacy source; changing it creates a distinct import namespace.',
	),
	botId: required(
		'bot-id',
		'BOT_ID',
		'Carneloot bot ID used to reconstruct Telegram identities and food replay keys.',
	),
	databaseUrl: required(
		'database-url',
		'DATABASE_URL',
		'Target PostgreSQL connection URL.',
	),
	dryRun: Flag.boolean('dry-run').pipe(Flag.withDefault(false)),
	reportPath: Flag.optional(Flag.string('report')),
};

type Flags = {
	readonly [Key in keyof typeof flags]: (typeof flags)[Key] extends Flag.Flag<
		infer Value
	>
		? Value
		: never;
};

export const toConfig = (value: Flags): LegacyImportConfigService => {
	const sourceAuthToken =
		typeof value.sourceAuthToken === 'string'
			? value.sourceAuthToken
			: value.sourceAuthToken._tag === 'Some'
				? value.sourceAuthToken.value
				: undefined;
	const reportPath =
		value.reportPath._tag === 'Some' ? value.reportPath.value : undefined;
	return {
		sourceUrl: value.sourceUrl,
		...(sourceAuthToken
			? { sourceAuthToken: Redacted.make(sourceAuthToken) }
			: {}),
		sourceId: value.sourceId,
		botId: value.botId,
		databaseUrl: Redacted.make(value.databaseUrl),
		dryRun: value.dryRun,
		...(reportPath ? { reportPath } : {}),
	};
};
