import { describe, expect, it } from 'vitest';

import * as DemoSummary from '../src/DemoSummary.js';

describe('demo summary', () => {
	it('prints deterministic sanitized persisted counts and outcomes', () => {
		expect(
			DemoSummary.format({
				users: 1,
				pets: 1,
				foodEntries: 1,
				reminderEvents: 1,
				reminderStatus: 'completed',
				deliveryOutcome: 'sent',
				deliveryMode: 'at-least-once',
				durableDeduplication: true,
				jobDeclarations: ['feeding-reminder', 'food-added-notification'],
			}),
		).toBe(
			'users=1 pets=1 food_entries=1 reminder_events=1 reminder_status=completed delivery_outcome=sent delivery_mode=at-least-once durable_deduplication=true jobs=feeding-reminder,food-added-notification',
		);
	});
});
