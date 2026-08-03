import { describe, expect, it } from 'vitest';

import {
	fallbackCounts,
} from '../../src/application/SendExternalNotification.js';
import { classifyOutcome } from '../../src/domain/notifications/ExternalNotification.js';

const delivery = (status: string) => ({ status });

describe('SendExternalNotification fallback summary', () => {
	it.each([
		['success', ['pending'], ['sent'], { sent: 0, failed: 0, unknown: 1 }, 'indeterminate'],
		['partial', ['pending', 'pending', 'pending'], ['sent', 'sent', 'failed'], { sent: 1, failed: 1, unknown: 1 }, 'partial'],
		['failed', ['pending'], ['failed'], { sent: 0, failed: 0, unknown: 1 }, 'indeterminate'],
		['indeterminate', ['pending'], ['unknown'], { sent: 0, failed: 0, unknown: 1 }, 'indeterminate'],
		[
			'persistence uncertainty preserves recipient cardinality',
			['pending', 'failed'],
			['sent'],
			{ sent: 0, failed: 1, unknown: 1 },
			'indeterminate',
		],
	] as const)(
		'%s outcome preserves recipient total without phantom deliveries',
		(_name, statuses, outcomes, expected, status) => {
			const deliveries = statuses.map(delivery);
			const reachable = deliveries.filter((value) => value.status === 'pending');
			const counts = fallbackCounts(deliveries, reachable, outcomes);
			expect(counts).toStrictEqual(expected);
			expect(counts.sent + counts.failed + counts.unknown).toBe(deliveries.length);
			expect(classifyOutcome(counts).status).toBe(status);
		},
	);
});
