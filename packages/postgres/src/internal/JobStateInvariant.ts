import type { JobStatus, LeasePhase } from 'tfx/JobStore';

export type JobOutcomeTag =
	| 'Succeeded'
	| 'RetryableFailure'
	| 'PermanentFailure'
	| 'FatalFailure'
	| 'Cancelled'
	| 'LeaseLost';

export const validJobState = (
	status: JobStatus,
	leasePhase: LeasePhase | undefined,
	hasLeaseExpiry: boolean,
	outcome: JobOutcomeTag | undefined,
): boolean => {
	if ((leasePhase === undefined) !== !hasLeaseExpiry) return false;
	switch (status) {
		case 'scheduled':
			return (
				(leasePhase === undefined || leasePhase === 'migration') &&
				(outcome === undefined ||
					outcome === 'RetryableFailure' ||
					outcome === 'LeaseLost')
			);
		case 'running':
			return leasePhase === 'execution' && outcome === undefined;
		case 'completed':
			return leasePhase === undefined && outcome === 'Succeeded';
		case 'failed':
			return (
				leasePhase === undefined &&
				(outcome === 'RetryableFailure' ||
					outcome === 'PermanentFailure' ||
					outcome === 'LeaseLost')
			);
		case 'quarantined':
			return (
				leasePhase === undefined &&
				(outcome === undefined || outcome === 'FatalFailure')
			);
		case 'cancelled':
			return leasePhase === undefined && outcome === 'Cancelled';
	}
};
