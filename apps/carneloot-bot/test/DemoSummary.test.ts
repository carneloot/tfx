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
				reminderStatus: 'scheduled',
				deliveryOutcome: 'not-materialized',
			}),
		).toBe(
			'users=1 pets=1 food_entries=1 reminder_events=1 reminder_status=scheduled delivery_outcome=not-materialized',
		);
	});
});
