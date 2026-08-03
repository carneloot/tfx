import { describe, expect, it } from 'vitest';

import {
	classifyOutcome,
	MissingTemplateVariables,
	renderNotificationTemplate,
} from '../../src/domain/notifications/ExternalNotification.js';

describe('ExternalNotification', () => {
	it('deduplicates placeholders and replaces every occurrence', () => {
		const rendered = renderNotificationTemplate(
			'Hello {{ name }}. {{name}}, feed {{ pet }}.',
			{ name: 'Ana', pet: 'Mimo' },
		);
		expect(rendered).toBe('Hello Ana. Ana, feed Mimo.');
	});

	it('sorts and reports missing placeholder names', () => {
		const rendered = renderNotificationTemplate(
			'{{ zebra }} {{ ant }} {{ zebra }}',
			{},
		);
		expect(rendered).toBeInstanceOf(MissingTemplateVariables);
		if (rendered instanceof MissingTemplateVariables)
			expect(rendered.names).toStrictEqual(['ant', 'zebra']);
	});

	it.each([
		[
			{ sent: 2, failed: 0, unknown: 0 },
			{ status: 'sent', httpStatus: 200 },
		],
		[
			{ sent: 1, failed: 1, unknown: 0 },
			{ status: 'partial', httpStatus: 207 },
		],
		[
			{ sent: 0, failed: 2, unknown: 0 },
			{ status: 'failed', httpStatus: 502 },
		],
		[
			{ sent: 0, failed: 0, unknown: 1 },
			{ status: 'indeterminate', httpStatus: 202 },
		],
	] as const)('maps %o to exact outcome', (counts, expected) => {
		expect(classifyOutcome(counts)).toStrictEqual(expected);
	});
});
