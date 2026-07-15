import * as Effect from 'effect/Effect';

import {
	ConversationStorage,
	ConversationStorageError,
} from '../src/ConversationStorage.js';
import { JobRuntime } from '../src/JobRuntime.js';
import { JobStoreError } from '../src/JobStore.js';
import {
	UpdateDeduplicator,
	UpdateDeduplicatorError,
} from '../src/UpdateDeduplicator.js';

const conversationLoad = ConversationStorage.use((storage) =>
	storage.load({ botId: 'bot', chatId: 1, userId: 2 }),
);
const _conversationError: Effect.Effect<
	unknown,
	ConversationStorageError,
	ConversationStorage
> = conversationLoad;
const jobCancel = JobRuntime.use((runtime) => runtime.cancel('id'));
const _jobError: Effect.Effect<boolean, JobStoreError, JobRuntime> = jobCancel;
const dedupClaim = UpdateDeduplicator.use((dedup) => dedup.claim(1));
const _dedupError: Effect.Effect<
	unknown,
	UpdateDeduplicatorError,
	UpdateDeduplicator
> = dedupClaim;
void [_conversationError, _jobError, _dedupError];
