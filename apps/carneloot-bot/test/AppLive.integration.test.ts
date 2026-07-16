import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Effect, Layer, Logger, References } from 'effect';
import { BotRuntime } from 'tfx/BotRuntime';
import * as Telegram from 'tfx/Telegram';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

import * as AppLive from '../src/AppLive.js';
import { AppConfig } from '../src/Config.js';
import { JobWorker } from '../src/JobWorker.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
import { testConfig } from './internal/TestConfig.js';

interface CapturedLog {
	readonly message: unknown;
	readonly level: string;
	readonly annotations: Readonly<Record<string, unknown>>;
}

const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const logs: Array<CapturedLog> = [];
	const logger = Logger.make((options) => {
		logs.push({
			message:
				Array.isArray(options.message) && options.message.length === 1
					? options.message[0]
					: options.message,
			level: options.logLevel,
			annotations: options.fiber.getRef(References.CurrentLogAnnotations),
		});
	});
	return Effect.map(
		Effect.provideService(effect, Logger.CurrentLoggers, new Set([logger])),
		(result) => ({ result, logs }),
	);
};

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';

describe.skipIf(!enabled)('application layer', () => {
	it('exposes narrow runtimes and acquires each migration suite once', async () => {
		const config = {
			...testConfig,
			tfxSchema: 'tfx_app_live',
			tfxTablePrefix: 'case_',
		};
		const telegram = Layer.provide(
			Telegram.layer(config.botToken),
			NodeHttpClient.layerFetch,
		);
		const infrastructure = Layer.merge(PostgresTestLayer.layer, telegram);
		const graph = Layer.provide(
			Layer.provide(
				AppLive.layer(() => UpdateDelivery.manual),
				infrastructure,
			),
			Layer.succeed(AppConfig, config),
		);
		const captured = await Effect.runPromise(
			captureLogs(
				Effect.scoped(
					Effect.flatMap(Layer.build(graph), (context) =>
						Effect.provide(
							Effect.gen(function* () {
								yield* BotRuntime;
								yield* JobWorker;
								yield* UpdateDeduplicator;
							}),
							context,
						),
					),
				),
			),
		);
		const count = (message: string) =>
			captured.logs.filter((log) => log.message === message).length;
		expect(count('carneloot.migrations.started')).toBe(1);
		expect(count('carneloot.migrations.completed')).toBe(1);
		expect(count('tfx.postgres.migrations.started')).toBe(1);
		expect(count('tfx.postgres.migrations.completed')).toBe(1);
	});
});
