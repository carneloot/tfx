import * as Postgres from '@tfx/cloudflare/Postgres';
import type { Bindings } from '@tfx/cloudflare/Worker';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { botId } from '../bot/Declaration.js';
import * as ForwardToOwner from '../bot/ForwardToOwner.js';
import * as DomainLive from '../DomainLive.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import * as RepositoriesLive from '../postgres/RepositoriesLive.js';

/** Native bindings supplied by Alchemy. Never retain a connection across events. */
export interface Env extends Bindings {
	readonly HYPERDRIVE: { readonly connectionString: string };
	readonly BOT_TOKEN: string;
	readonly BOT_USERNAME: string;
	readonly TELEGRAM_FORWARD_USERNAMES?: string;
	readonly OWNER_TELEGRAM_ID?: string;
	readonly WEBHOOK_SECRET: string;
	readonly TFX_POSTGRES_SCHEMA: string;
	readonly TFX_POSTGRES_TABLE_PREFIX: string;
}

export const layer = (env: Env) => {
	const forwarding = Layer.effect(
		ForwardToOwner.Settings,
		Effect.provide(
			ForwardToOwner.config,
			ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
		),
	);
	const application = Layer.provideMerge(
		Layer.provideMerge(DomainLive.layer, RepositoriesLive.repositoriesLayer),
		Postgres.layer(env, {
			botId,
			schema: env.TFX_POSTGRES_SCHEMA,
			tablePrefix: env.TFX_POSTGRES_TABLE_PREFIX,
		}),
	);
	return Layer.merge(application, forwarding);
};

export const recoverNotifications = Effect.gen(function* () {
	const notifications = yield* NotificationRepository;
	const now = yield* DateTime.now;
	return yield* notifications.recoverAllExpired(now);
});
