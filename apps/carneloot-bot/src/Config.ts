import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as Redacted from 'effect/Redacted';

import { Carneloot } from './bot/Declaration.js';

export interface AppConfigService {
	readonly botToken: Redacted.Redacted<string>;
	readonly databaseUrl: Redacted.Redacted<string>;
	readonly botId: typeof Carneloot.name;
	readonly botUsername: string;
	readonly pollingTimeoutSeconds: number;
	readonly pollingRetryMillis: number;
	readonly dispatchCapacity: number;
	readonly dispatchConcurrency: number;
	readonly jobIdleMillis: number;
	readonly jobLeaseMillis: number;
	readonly dedupLeaseMillis: number;
	readonly dedupWaitMillis: number;
	readonly dedupRetentionMillis: number;
	readonly tfxSchema: string;
	readonly tfxTablePrefix: string;
}
export class AppConfig extends Context.Service<AppConfig, AppConfigService>()(
	'carneloot/AppConfig',
) {}
export class AppConfigValidationError extends Error {
	readonly _tag = 'AppConfigValidationError';
}
const source = Config.all({
	botToken: Config.redacted('BOT_TOKEN'),
	databaseUrl: Config.redacted('DATABASE_URL'),
	botId: Config.string('BOT_ID'),
	botUsername: Config.string('BOT_USERNAME'),
	pollingTimeoutSeconds: Config.int('POLLING_TIMEOUT_SECONDS'),
	pollingRetryMillis: Config.int('POLLING_RETRY_MILLIS'),
	dispatchCapacity: Config.int('DISPATCH_CAPACITY'),
	dispatchConcurrency: Config.int('DISPATCH_CONCURRENCY'),
	jobIdleMillis: Config.int('JOB_IDLE_MILLIS'),
	jobLeaseMillis: Config.int('JOB_LEASE_MILLIS'),
	dedupLeaseMillis: Config.int('DEDUP_LEASE_MILLIS'),
	dedupWaitMillis: Config.int('DEDUP_WAIT_MILLIS'),
	dedupRetentionMillis: Config.int('DEDUP_RETENTION_MILLIS'),
	tfxSchema: Config.string('TFX_SCHEMA'),
	tfxTablePrefix: Config.string('TFX_TABLE_PREFIX'),
});
export const load = Effect.flatMap(source, (value) =>
	Effect.try({
		try: () => {
			if (value.botId !== Carneloot.name)
				throw new AppConfigValidationError(
					`BOT_ID must equal ${Carneloot.name}`,
				);
			for (const [name, number] of Object.entries(value).filter(
				(entry): entry is [string, number] => typeof entry[1] === 'number',
			))
				if (!Number.isSafeInteger(number) || number <= 0)
					throw new AppConfigValidationError(
						`${name} must be a positive integer`,
					);
			if (value.dispatchConcurrency > value.dispatchCapacity)
				throw new AppConfigValidationError(
					'DISPATCH_CONCURRENCY cannot exceed DISPATCH_CAPACITY',
				);
			if (value.dedupWaitMillis > value.dedupLeaseMillis)
				throw new AppConfigValidationError(
					'DEDUP_WAIT_MILLIS cannot exceed DEDUP_LEASE_MILLIS',
				);
			return Object.freeze({ ...value, botId: Carneloot.name });
		},
		catch: (cause) =>
			cause instanceof AppConfigValidationError
				? cause
				: new AppConfigValidationError('Invalid application configuration'),
	}),
);
export const layer = Layer.effect(AppConfig, load);
