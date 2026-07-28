import * as Config from 'effect/Config';
import * as Option from 'effect/Option';
import { Flag, Param } from 'effect/unstable/cli';

import type { LegacyImportConfigService } from './LegacyImportConfig.js';

const required = (flag: string, environment: string, description: string) =>
	Flag.string(flag).pipe(
		Flag.withDescription(`${description} Falls back to ${environment}.`),
		Flag.withFallbackConfig(Config.string(environment)),
	);

const optionalSecret = (flag: string, environment: string) =>
	Flag.optional(Param.redacted(Param.flagKind, flag)).pipe(
		Flag.withFallbackConfig(Config.option(Config.redacted(environment))),
	);

const requiredSecret = (
	flag: string,
	environment: string,
	description: string,
) =>
	Param.redacted(Param.flagKind, flag).pipe(
		Flag.withDescription(`${description} Falls back to ${environment}.`),
		Flag.withFallbackConfig(Config.redacted(environment)),
	);

export const flags = {
	sourceUrl: required(
		'source-url',
		'LEGACY_DATABASE_URL',
		'Legacy SQLite file URL or libSQL endpoint.',
	),
	sourceAuthToken: optionalSecret(
		'source-auth-token',
		'LEGACY_DATABASE_AUTH_TOKEN',
	),
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
	databaseUrl: requiredSecret(
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
	const sourceAuthToken = Option.isOption(value.sourceAuthToken)
		? Option.getOrUndefined(value.sourceAuthToken)
		: value.sourceAuthToken;
	const databaseUrl = value.databaseUrl;
	const reportPath =
		value.reportPath._tag === 'Some' ? value.reportPath.value : undefined;
	return {
		sourceUrl: value.sourceUrl,
		...(sourceAuthToken ? { sourceAuthToken } : {}),
		sourceId: value.sourceId,
		botId: value.botId,
		databaseUrl,
		dryRun: value.dryRun,
		...(reportPath ? { reportPath } : {}),
	};
};
