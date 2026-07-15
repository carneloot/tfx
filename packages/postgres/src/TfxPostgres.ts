import type * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import {
	ConversationStorage,
	type ConversationStorageError,
} from 'tfx/ConversationStorage';
import { JobStore, JobStoreError } from 'tfx/JobStore';
import {
	UpdateDeduplicator,
	type UpdateDeduplicatorError,
} from 'tfx/UpdateDeduplicator';

import { migrate } from './internal/Migrator.js';
import { safeCause } from './internal/RowValidation.js';
import type { Options } from './Options.js';
import * as PostgresConversationStorage from './PostgresConversationStorage.js';
import * as PostgresJobStore from './PostgresJobStore.js';
import * as PostgresUpdateDeduplicator from './PostgresUpdateDeduplicator.js';
export const layer = (
	options: Options = {},
): Layer.Layer<
	ConversationStorage | JobStore | UpdateDeduplicator,
	ConversationStorageError | JobStoreError | UpdateDeduplicatorError,
	PgClient.PgClient
> =>
	Layer.unwrap(
		Effect.as(
			migrate(options).pipe(
				Effect.mapError(
					(cause) =>
						new JobStoreError(
							'PersistenceFailure',
							'PostgreSQL migration failed',
							safeCause(cause),
						),
				),
			),
			Layer.mergeAll(
				PostgresConversationStorage.layer(options, true),
				PostgresJobStore.layer(options, true),
				PostgresUpdateDeduplicator.layer(options, true),
			),
		),
	);
