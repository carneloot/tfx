import { ConfigProvider, Duration, Effect, Redacted } from 'effect';
import { describe, expect, it } from 'vitest';

import * as AppConfig from '../src/Config.js';

const valid = {
	BOT_TOKEN: 'secret-token',
	DATABASE_URL: 'postgres://secret',
	BOT_ID: 'carneloot',
	BOT_USERNAME: 'carneloot_bot',
	POLLING_TIMEOUT: '30 seconds',
	POLLING_RETRY_DELAY: '1 second',
	DISPATCH_CAPACITY: '32',
	DISPATCH_CONCURRENCY: '4',
	JOB_IDLE: '100 millis',
	JOB_LEASE: '30 seconds',
	JOB_HEARTBEAT: '10 seconds',
	DEDUP_LEASE: '30 seconds',
	DEDUP_HEARTBEAT: '10 seconds',
	DEDUP_WAIT: '5 seconds',
	DEDUP_RETENTION: '1 day',
	TFX_POSTGRES_SCHEMA: 'tfx',
	TFX_POSTGRES_TABLE_PREFIX: 'bot_',
};
const load = (values: Record<string, string>) =>
	Effect.provide(
		AppConfig.load,
		ConfigProvider.layer(ConfigProvider.fromUnknown(values)),
	);
describe('AppConfig', () => {
	it('loads validated redacted durable configuration', async () => {
		const config = await Effect.runPromise(load(valid));
		expect(config.botId).toBe('carneloot');
		expect(config.dispatchConcurrency).toBe(4);
		expect(Duration.equals(config.pollingTimeout, Duration.seconds(30))).toBe(
			true,
		);
		expect(Duration.equals(config.jobIdle, Duration.millis(100))).toBe(true);
		expect(Duration.equals(config.jobLease, Duration.seconds(30))).toBe(true);
		expect(Duration.equals(config.dedupRetention, Duration.days(1))).toBe(true);
		expect(String(config.botToken)).not.toContain('secret-token');
		expect(Redacted.value(config.databaseUrl)).toBe('postgres://secret');
	});
	it.each([
		{ ...valid, BOT_ID: 'other' },
		{ ...valid, JOB_IDLE: '0 millis' },
		{ ...valid, JOB_IDLE: '-1 second' },
		{ ...valid, JOB_IDLE: 'Infinity' },
		{ ...valid, POLLING_TIMEOUT: '500 millis' },
		{ ...valid, POLLING_TIMEOUT: '51 seconds' },
		{ ...valid, DISPATCH_CAPACITY: '2', DISPATCH_CONCURRENCY: '4' },
		{ ...valid, DEDUP_LEASE: '100 millis', DEDUP_WAIT: '101 millis' },
		{ ...valid, JOB_HEARTBEAT: '30 seconds' },
		{ ...valid, DEDUP_HEARTBEAT: '30 seconds' },
		{ ...valid, BOT_TOKEN: '' },
		{ ...valid, DATABASE_URL: '   ' },
		{ ...valid, BOT_USERNAME: '' },
		{ ...valid, BOT_USERNAME: 'a' },
		{ ...valid, TFX_POSTGRES_SCHEMA: 'bad-name' },
		{ ...valid, TFX_POSTGRES_TABLE_PREFIX: 'bad-name' },
	])('rejects invalid configuration %#', async (values) => {
		expect((await Effect.runPromiseExit(load(values)))._tag).toBe('Failure');
	});
	it('requires durable database configuration', async () => {
		const { DATABASE_URL: _, ...missing } = valid;
		expect((await Effect.runPromiseExit(load(missing)))._tag).toBe('Failure');
	});
});
