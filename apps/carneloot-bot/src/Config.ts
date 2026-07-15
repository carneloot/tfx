import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';

import { Carneloot } from './bot/Declaration.js';

export interface AppConfigService {
	readonly botToken: Redacted.Redacted<string>;
	readonly databaseUrl: Redacted.Redacted<string>;
	readonly botId: typeof Carneloot.name;
	readonly botUsername: string;
	readonly pollingTimeoutSeconds: number;
	readonly pollingRetryDelayMillis: number;
	readonly dispatchCapacity: number;
	readonly dispatchConcurrency: number;
	readonly jobIdleMillis: number;
	readonly jobLeaseMillis: number;
	readonly jobHeartbeatMillis: number;
	readonly dedupLeaseMillis: number;
	readonly dedupHeartbeatMillis: number;
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
	pollingRetryDelayMillis: Config.int('POLLING_RETRY_DELAY_MILLIS'),
	dispatchCapacity: Config.int('DISPATCH_CAPACITY'),
	dispatchConcurrency: Config.int('DISPATCH_CONCURRENCY'),
	jobIdleMillis: Config.int('JOB_IDLE_MILLIS'),
	jobLeaseMillis: Config.int('JOB_LEASE_MILLIS'),
	jobHeartbeatMillis: Config.int('JOB_HEARTBEAT_MILLIS'),
	dedupLeaseMillis: Config.int('DEDUP_LEASE_MILLIS'),
	dedupHeartbeatMillis: Config.int('DEDUP_HEARTBEAT_MILLIS'),
	dedupWaitMillis: Config.int('DEDUP_WAIT_MILLIS'),
	dedupRetentionMillis: Config.int('DEDUP_RETENTION_MILLIS'),
	tfxSchema: Config.string('TFX_POSTGRES_SCHEMA'),
	tfxTablePrefix: Config.string('TFX_POSTGRES_TABLE_PREFIX'),
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
			if (Redacted.value(value.botToken).trim().length === 0)
				throw new AppConfigValidationError('BOT_TOKEN must be nonempty');
			if (Redacted.value(value.databaseUrl).trim().length === 0)
				throw new AppConfigValidationError('DATABASE_URL must be nonempty');
			if (!/^[A-Za-z0-9_]{5,32}$/u.test(value.botUsername))
				throw new AppConfigValidationError('BOT_USERNAME is invalid');
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.tfxSchema))
				throw new AppConfigValidationError(
					'TFX_POSTGRES_SCHEMA must be a SQL identifier',
				);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.tfxTablePrefix))
				throw new AppConfigValidationError(
					'TFX_POSTGRES_TABLE_PREFIX must be a SQL identifier',
				);
			if (value.jobHeartbeatMillis >= value.jobLeaseMillis)
				throw new AppConfigValidationError(
					'JOB_HEARTBEAT_MILLIS must be less than JOB_LEASE_MILLIS',
				);
			if (value.dedupHeartbeatMillis >= value.dedupLeaseMillis)
				throw new AppConfigValidationError(
					'DEDUP_HEARTBEAT_MILLIS must be less than DEDUP_LEASE_MILLIS',
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
