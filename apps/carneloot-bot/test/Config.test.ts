import { ConfigProvider, Effect, Redacted } from 'effect';
import { describe, expect, it } from 'vitest';

import * as AppConfig from '../src/Config.js';

const valid = {
	BOT_TOKEN: 'secret-token',
	DATABASE_URL: 'postgres://secret',
	BOT_ID: 'carneloot',
	BOT_USERNAME: 'carneloot_bot',
	POLLING_TIMEOUT_SECONDS: '30',
	POLLING_RETRY_DELAY_MILLIS: '1000',
	DISPATCH_CAPACITY: '32',
	DISPATCH_CONCURRENCY: '4',
	JOB_IDLE_MILLIS: '100',
	JOB_LEASE_MILLIS: '30000',
	JOB_HEARTBEAT_MILLIS: '10000',
	DEDUP_LEASE_MILLIS: '30000',
	DEDUP_HEARTBEAT_MILLIS: '10000',
	DEDUP_WAIT_MILLIS: '1000',
	DEDUP_RETENTION_MILLIS: '86400000',
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
		expect(String(config.botToken)).not.toContain('secret-token');
		expect(Redacted.value(config.databaseUrl)).toBe('postgres://secret');
	});
	it.each([
		{ ...valid, BOT_ID: 'other' },
		{ ...valid, JOB_IDLE_MILLIS: '0' },
		{ ...valid, DISPATCH_CAPACITY: '2', DISPATCH_CONCURRENCY: '4' },
		{ ...valid, DEDUP_LEASE_MILLIS: '100', DEDUP_WAIT_MILLIS: '101' },
		{ ...valid, JOB_HEARTBEAT_MILLIS: '30000' },
		{ ...valid, DEDUP_HEARTBEAT_MILLIS: '30000' },
		{ ...valid, BOT_USERNAME: '' },
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
