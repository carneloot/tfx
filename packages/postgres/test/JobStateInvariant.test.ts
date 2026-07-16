import { describe, expect, it } from 'vitest';

import { validJobState } from '../src/internal/JobStateInvariant.js';

describe('job state invariant', () => {
	it.each([
		['scheduled', undefined, false, undefined],
		['scheduled', 'migration', true, 'RetryableFailure'],
		['scheduled', 'migration', true, 'LeaseLost'],
		['running', 'execution', true, undefined],
		['completed', undefined, false, 'Succeeded'],
		['failed', undefined, false, 'RetryableFailure'],
		['failed', undefined, false, 'PermanentFailure'],
		['failed', undefined, false, 'LeaseLost'],
		['quarantined', undefined, false, undefined],
		['quarantined', undefined, false, 'FatalFailure'],
		['cancelled', undefined, false, 'Cancelled'],
	] as const)('accepts %s/%s/%s/%s', (status, phase, expiry, outcome) => {
		expect(validJobState(status, phase, expiry, outcome)).toBe(true);
	});

	it.each([
		['scheduled', 'execution', true, undefined],
		['running', undefined, false, undefined],
		['running', 'execution', true, 'RetryableFailure'],
		['completed', undefined, false, undefined],
		['completed', 'execution', true, 'Succeeded'],
		['failed', undefined, false, 'Succeeded'],
		['quarantined', 'migration', true, undefined],
		['cancelled', undefined, false, 'Succeeded'],
	] as const)('rejects %s/%s/%s/%s', (status, phase, expiry, outcome) => {
		expect(validJobState(status, phase, expiry, outcome)).toBe(false);
	});
});
