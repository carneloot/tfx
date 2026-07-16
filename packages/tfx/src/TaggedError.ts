/** Structural contract required for values carried in public Effect error channels. */
export interface TaggedError {
	readonly _tag: string;
}
export interface RetryableError extends TaggedError {
	readonly isRetryable: true;
}
/** Errors must explicitly opt in to retries. Missing markers are non-retryable. */
export const isRetryableError = (error: TaggedError): error is RetryableError =>
	'isRetryable' in error && error.isRetryable === true;
