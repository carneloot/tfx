import * as Duration from 'effect/Duration';
import * as Schema from 'effect/Schema';

export class NetworkError extends Schema.TaggedErrorClass<NetworkError>()(
	'NetworkError',
	{
		message: Schema.String,
	},
) {
	readonly isRetryable = true;
	readonly retryAfter = undefined;
}

export class RateLimitError extends Schema.TaggedErrorClass<RateLimitError>()(
	'RateLimitError',
	{
		errorCode: Schema.Number,
		description: Schema.String,
		retryAfterSeconds: Schema.Number,
	},
) {
	readonly isRetryable = true;
	get retryAfter(): Duration.Duration {
		return Duration.seconds(this.retryAfterSeconds);
	}
}

export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
	'AuthenticationError',
	{ errorCode: Schema.Number, description: Schema.String },
) {
	readonly isRetryable = false;
	readonly retryAfter = undefined;
}
export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()(
	'ForbiddenError',
	{ errorCode: Schema.Number, description: Schema.String },
) {
	readonly isRetryable = false;
	readonly retryAfter = undefined;
}
export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
	'InvalidRequestError',
	{ errorCode: Schema.Number, description: Schema.String },
) {
	readonly isRetryable = false;
	readonly retryAfter = undefined;
}
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
	'ConflictError',
	{ errorCode: Schema.Number, description: Schema.String },
) {
	readonly isRetryable = true;
	readonly retryAfter = undefined;
}
export class ChatMigrationError extends Schema.TaggedErrorClass<ChatMigrationError>()(
	'ChatMigrationError',
	{
		errorCode: Schema.Number,
		description: Schema.String,
		migrateToChatId: Schema.Number,
	},
) {
	readonly isRetryable = false;
	readonly retryAfter = undefined;
}
export class InternalTelegramError extends Schema.TaggedErrorClass<InternalTelegramError>()(
	'InternalTelegramError',
	{ errorCode: Schema.Number, description: Schema.String },
) {
	readonly isRetryable = true;
	readonly retryAfter = undefined;
}
export class InvalidResponseError extends Schema.TaggedErrorClass<InvalidResponseError>()(
	'InvalidResponseError',
	{ message: Schema.String },
) {
	readonly isRetryable = false;
	readonly retryAfter = undefined;
}
export class UnknownError extends Schema.TaggedErrorClass<UnknownError>()(
	'UnknownError',
	{ message: Schema.String },
) {
	readonly isRetryable = false;
	readonly retryAfter = undefined;
}

export const TelegramErrorReason = Schema.Union([
	NetworkError,
	RateLimitError,
	AuthenticationError,
	ForbiddenError,
	InvalidRequestError,
	ConflictError,
	ChatMigrationError,
	InternalTelegramError,
	InvalidResponseError,
	UnknownError,
]);
export type TelegramErrorReason = typeof TelegramErrorReason.Type;

export class TelegramError extends Schema.TaggedErrorClass<TelegramError>()(
	'TelegramError',
	{
		module: Schema.Literal('Telegram'),
		method: Schema.String,
		reason: TelegramErrorReason,
	},
) {
	get cause(): TelegramErrorReason {
		return this.reason;
	}
	get message(): string {
		return 'description' in this.reason
			? this.reason.description
			: this.reason.message;
	}
	get isRetryable(): boolean {
		return this.reason.isRetryable;
	}
	get retryAfter(): Duration.Duration | undefined {
		return this.reason.retryAfter;
	}
}

export interface TelegramFailureEnvelope {
	readonly ok: false;
	readonly error_code: number;
	readonly description?: string;
	readonly parameters?: {
		readonly retry_after?: number;
		readonly migrate_to_chat_id?: number;
	};
}

export const fromEnvelope = (
	method: string,
	envelope: TelegramFailureEnvelope,
): TelegramError => {
	const errorCode = envelope.error_code;
	const description = envelope.description ?? 'Telegram request failed';
	const parameters = envelope.parameters;
	const reason =
		parameters?.migrate_to_chat_id !== undefined
			? new ChatMigrationError({
					errorCode,
					description,
					migrateToChatId: parameters.migrate_to_chat_id,
				})
			: errorCode === 429
				? new RateLimitError({
						errorCode,
						description,
						retryAfterSeconds: parameters?.retry_after ?? 0,
					})
				: errorCode === 401
					? new AuthenticationError({ errorCode, description })
					: errorCode === 403
						? new ForbiddenError({ errorCode, description })
						: errorCode === 400
							? new InvalidRequestError({ errorCode, description })
							: errorCode === 409
								? new ConflictError({ errorCode, description })
								: errorCode >= 500
									? new InternalTelegramError({ errorCode, description })
									: new UnknownError({
											message: `Telegram error ${errorCode}: ${description}`,
										});
	return new TelegramError({ module: 'Telegram', method, reason });
};
