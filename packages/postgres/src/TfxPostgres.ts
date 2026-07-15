import type * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { ConversationStorage } from 'tfx/ConversationStorage';
import { JobStore } from 'tfx/JobStore';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';

import { migrate } from './internal/Migrator.js';
import type { Options } from './Options.js';
import * as PostgresConversationStorage from './PostgresConversationStorage.js';
import * as PostgresJobStore from './PostgresJobStore.js';
import * as PostgresUpdateDeduplicator from './PostgresUpdateDeduplicator.js';
export const layer = (
	options: Options = {},
): Layer.Layer<
	ConversationStorage | JobStore | UpdateDeduplicator,
	unknown,
	PgClient.PgClient
> =>
	Layer.unwrap(
		Effect.as(
			migrate(options),
			Layer.mergeAll(
				PostgresConversationStorage.layer(options, true),
				PostgresJobStore.layer(options, true),
				PostgresUpdateDeduplicator.layer(options, true),
			),
		),
	);
