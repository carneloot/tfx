import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';

import { Carneloot } from './bot/Declaration.js';

export interface AppConfigService {
	readonly botToken: Redacted.Redacted<string>;
	readonly databaseUrl: Redacted.Redacted<string>;
	readonly botId: typeof Carneloot.name;
	readonly botUsername: string;
	readonly pollingTimeout: Duration.Duration;
	readonly pollingRetryDelay: Duration.Duration;
	readonly dispatchCapacity: number;
	readonly dispatchConcurrency: number;
	readonly jobIdle: Duration.Duration;
	readonly jobLease: Duration.Duration;
	readonly jobHeartbeat: Duration.Duration;
	readonly dedupLease: Duration.Duration;
	readonly dedupHeartbeat: Duration.Duration;
	readonly dedupWait: Duration.Duration;
	readonly dedupRetention: Duration.Duration;
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
	pollingTimeout: Config.duration('POLLING_TIMEOUT'),
	pollingRetryDelay: Config.duration('POLLING_RETRY_DELAY'),
	dispatchCapacity: Config.int('DISPATCH_CAPACITY'),
	dispatchConcurrency: Config.int('DISPATCH_CONCURRENCY'),
	jobIdle: Config.duration('JOB_IDLE'),
	jobLease: Config.duration('JOB_LEASE'),
	jobHeartbeat: Config.duration('JOB_HEARTBEAT'),
	dedupLease: Config.duration('DEDUP_LEASE'),
	dedupHeartbeat: Config.duration('DEDUP_HEARTBEAT'),
	dedupWait: Config.duration('DEDUP_WAIT'),
	dedupRetention: Config.duration('DEDUP_RETENTION'),
	tfxSchema: Config.string('TFX_POSTGRES_SCHEMA'),
	tfxTablePrefix: Config.string('TFX_POSTGRES_TABLE_PREFIX'),
});
const durationEntries = (value: Config.Success<typeof source>) =>
	[
		['POLLING_TIMEOUT', value.pollingTimeout],
		['POLLING_RETRY_DELAY', value.pollingRetryDelay],
		['JOB_IDLE', value.jobIdle],
		['JOB_LEASE', value.jobLease],
		['JOB_HEARTBEAT', value.jobHeartbeat],
		['DEDUP_LEASE', value.dedupLease],
		['DEDUP_HEARTBEAT', value.dedupHeartbeat],
		['DEDUP_WAIT', value.dedupWait],
		['DEDUP_RETENTION', value.dedupRetention],
	] as const;
export const load = Effect.flatMap(source, (value) =>
	Effect.try({
		try: () => {
			if (value.botId !== Carneloot.name)
				throw new AppConfigValidationError(
					`BOT_ID must equal ${Carneloot.name}`,
				);
			for (const [name, duration] of durationEntries(value))
				if (
					!Duration.isFinite(duration) ||
					Duration.isNegative(duration) ||
					Duration.isZero(duration)
				)
					throw new AppConfigValidationError(
						`${name} must be a positive finite duration`,
					);
			for (const [name, number] of [
				['DISPATCH_CAPACITY', value.dispatchCapacity],
				['DISPATCH_CONCURRENCY', value.dispatchConcurrency],
			] as const)
				if (!Number.isSafeInteger(number) || number <= 0)
					throw new AppConfigValidationError(
						`${name} must be a positive integer`,
					);
			const pollingTimeoutSeconds = Duration.toSeconds(value.pollingTimeout);
			if (
				!Number.isInteger(pollingTimeoutSeconds) ||
				pollingTimeoutSeconds < 1 ||
				pollingTimeoutSeconds > 50
			)
				throw new AppConfigValidationError(
					'POLLING_TIMEOUT must be a whole number of seconds from 1 through 50',
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
			if (!Duration.isLessThan(value.jobHeartbeat, value.jobLease))
				throw new AppConfigValidationError(
					'JOB_HEARTBEAT must be less than JOB_LEASE',
				);
			if (!Duration.isLessThan(value.dedupHeartbeat, value.dedupLease))
				throw new AppConfigValidationError(
					'DEDUP_HEARTBEAT must be less than DEDUP_LEASE',
				);
			if (value.dispatchConcurrency > value.dispatchCapacity)
				throw new AppConfigValidationError(
					'DISPATCH_CONCURRENCY cannot exceed DISPATCH_CAPACITY',
				);
			if (Duration.isGreaterThan(value.dedupWait, value.dedupLease))
				throw new AppConfigValidationError(
					'DEDUP_WAIT cannot exceed DEDUP_LEASE',
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
