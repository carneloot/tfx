import * as Context from 'effect/Context';
import type * as DateTime from 'effect/DateTime';
import type * as Effect from 'effect/Effect';

import type { Scope } from './internal/conversation/Scope.js';
import type { AfterCommit } from './internal/conversation/Transition.js';
export type { Scope };
export interface ConversationTraceContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly sampled: boolean;
}
export interface ConversationRow {
	readonly scope: Scope;
	readonly instanceId: string;
	readonly originTrace: ConversationTraceContext | undefined;
	readonly conversationId: string;
	readonly version: number;
	readonly step: string;
	readonly state: unknown;
	readonly revision: number;
	readonly lastUpdateId: number | undefined;
	readonly expiresAt: DateTime.Utc | undefined;
}
export type NewConversationRow = Omit<
	ConversationRow,
	'instanceId' | 'revision'
>;
export type Mutation =
	| {
			readonly _tag: 'Persist';
			readonly step: string;
			readonly state: unknown;
			readonly version?: number;
			readonly expiresAt?: DateTime.Utc;
			readonly afterCommit?: AfterCommit;
	  }
	| { readonly _tag: 'Delete'; readonly afterCommit?: AfterCommit };
export type TransitionResult<A> =
	| {
			readonly _tag: 'Applied';
			readonly value: A;
			readonly row: ConversationRow | undefined;
			readonly afterCommit?: AfterCommit;
	  }
	| { readonly _tag: 'Duplicate'; readonly row: ConversationRow }
	| { readonly _tag: 'Stale'; readonly row: ConversationRow }
	| { readonly _tag: 'Missing' }
	| { readonly _tag: 'Expired' };
export class ConversationStorageError extends Error {
	readonly _tag = 'ConversationStorageError';
	constructor(
		readonly reason: 'Conflict' | 'InvariantViolation' | 'PersistenceFailure',
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
	}
	get isRetryable(): boolean {
		return this.reason === 'PersistenceFailure';
	}
}
export interface ConversationStorageService {
	readonly load: (
		scope: Scope,
	) => Effect.Effect<ConversationRow | undefined, ConversationStorageError>;
	readonly create: (
		row: NewConversationRow,
		conflict: 'fail' | 'replace',
	) => Effect.Effect<ConversationRow, ConversationStorageError>;
	readonly transition: <A, E, R>(
		scope: Scope,
		updateId: number,
		expectedRevision: number,
		handler: (
			row: ConversationRow,
		) => Effect.Effect<
			{ readonly value: A; readonly mutation: Mutation },
			E,
			R
		>,
		expectedInstanceId?: string,
	) => Effect.Effect<TransitionResult<A>, E | ConversationStorageError, R>;
	readonly cancel: (
		scope: Scope,
	) => Effect.Effect<boolean, ConversationStorageError>;
}
export class ConversationStorage extends Context.Service<
	ConversationStorage,
	ConversationStorageService
>()('tfx/ConversationStorage') {}
