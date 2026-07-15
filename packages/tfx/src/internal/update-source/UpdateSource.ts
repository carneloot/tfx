import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { DispatchOutcome } from '../../DispatchOutcome.js';
import type { TaggedError } from '../../TaggedError.js';
import type { Update } from '../telegram/generated/TelegramApi.types.js';
export interface UpdateSourceService {
	readonly run: (
		deliver: (update: Update) => Effect.Effect<DispatchOutcome, never>,
	) => Effect.Effect<void, TaggedError>;
}
export class UpdateSource extends Context.Service<
	UpdateSource,
	UpdateSourceService
>()('tfx/internal/UpdateSource') {}
