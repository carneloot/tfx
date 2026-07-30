import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import type { EventId } from '../domain/notifications/NotificationEvent.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';

export const execute = Effect.fn('RecoverStaleDeliveries.execute')
	((eventId: EventId) =>
	Effect.gen(function* () {
		const now = yield* DateTime.now;
		const notifications = yield* NotificationRepository;
		return yield* notifications.recoverExpired(eventId, now);
	}));
