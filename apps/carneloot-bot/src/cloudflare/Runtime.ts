import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { JobRuntime } from 'tfx/JobRuntime';
import * as Telegram from 'tfx/Telegram';

import { botId } from '../bot/Declaration.js';
import * as DomainLive from '../DomainLive.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import * as RepositoriesLive from '../postgres/RepositoriesLive.js';

/** Native bindings supplied by Alchemy. Never retain a connection across events. */
export interface Env {
	readonly HYPERDRIVE: { readonly connectionString: string };
	readonly BOT_TOKEN: string;
	readonly BOT_USERNAME: string;
	readonly WEBHOOK_SECRET: string;
	readonly TFX_POSTGRES_SCHEMA: string;
	readonly TFX_POSTGRES_TABLE_PREFIX: string;
}

export const layer = (env: Env) => {
	const persistence = Layer.merge(
		TfxPostgres.servicesLayer({
			botId,
			schema: env.TFX_POSTGRES_SCHEMA,
			tablePrefix: env.TFX_POSTGRES_TABLE_PREFIX,
		}),
		RepositoriesLive.repositoriesLayer,
	);
	const infrastructure = Layer.mergeAll(
		PgClient.layer({
			url: Redacted.make(env.HYPERDRIVE.connectionString),
			prepare: false,
			maxConnections: 3,
			connectTimeout: '5 seconds',
			acquireTimeout: '5 seconds',
		}),
		Layer.provide(
			Telegram.layer(Redacted.make(env.BOT_TOKEN), { timeout: '5 seconds' }),
			FetchHttpClient.layer,
		),
		NodeCrypto.layer,
	);
	return Layer.provideMerge(
		Layer.provideMerge(DomainLive.layer, persistence),
		infrastructure,
	);
};

/** SQL jobs are authoritative. A cron event is only a bounded wakeup. */
export const drainJobs = Effect.gen(function* () {
	const notifications = yield* NotificationRepository;
	const jobs = yield* JobRuntime;
	const now = yield* DateTime.now;
	const recovered = yield* notifications.recoverAllExpired(now);
	let processed = 0;
	for (; processed < 50; processed++) {
		const job = yield* jobs.runOne();
		if (job === undefined) break;
	}
	yield* Effect.logInfo('carneloot.cloudflare.jobs_drained').pipe(
		Effect.annotateLogs({ processed, recovered }),
	);
	return { processed, recovered };
});
