import * as SqlError from 'effect/unstable/sql/SqlError';
import { ConversationStorageError } from 'tfx/ConversationStorage';
import type { TaggedError } from 'tfx/TaggedError';
import { NetworkError, TelegramError } from 'tfx/TelegramError';
import { describe, expect, it } from 'vitest';

import { ConversationOperationError } from '../src/domain/ApplicationError.js';
import {
	CaregiverAccessLost,
	CaregiverInvitationNotFound,
	CaregiverInvitationNotPending,
	CaregiverRelationshipExists,
	CaregiverSelfInvitation,
	CaregiverUsernameAmbiguous,
	CaregiverUsernameNotFound,
} from '../src/domain/caregivers/CaregiverError.js';
import {
	DomainPersistenceError,
	InvalidDomainInput,
	UserNotRegistered,
} from '../src/domain/DomainError.js';
import { FoodEntryNotFound } from '../src/domain/pet-food/PetFoodError.js';
import { ReminderSchedulerError } from '../src/ports/ReminderScheduler.js';
import { classifyError } from '../src/Router.js';

describe('Carneloot router error classification', () => {
	it('retries only persistence errors that explicitly opt in', () => {
		expect(
			classifyError(
				new DomainPersistenceError({
					reason: 'PersistenceFailure',
					message: 'unavailable',
				}),
			),
		).toEqual({
			_tag: 'RetryableFailure',
			error: 'application-persistence-unavailable',
		});
		expect(
			classifyError(
				new DomainPersistenceError({
					reason: 'InvariantViolation',
					message: 'malformed row',
				}),
			),
		).toEqual({
			_tag: 'Fatal',
			cause: 'application-persistence-invariant',
		});
		expect(
			classifyError(
				new ReminderSchedulerError({
					reason: 'PersistenceFailure',
					message: 'unavailable',
				}),
			),
		).toEqual({
			_tag: 'RetryableFailure',
			error: 'reminder-scheduler-unavailable',
		});
	});

	it('classifies wrapped framework invariants as fatal', () => {
		expect(
			classifyError(
				new ConversationOperationError({
					message: 'resume failed',
					cause: new ConversationStorageError(
						'InvariantViolation',
						'malformed state',
					),
				}),
			),
		).toEqual({
			_tag: 'Fatal',
			cause: 'conversation-storage-invariant',
		});
	});

	it('acknowledges permanent domain and Telegram output failures', () => {
		expect(
			classifyError(new UserNotRegistered({ message: 'missing' })),
		).toEqual({
			_tag: 'PermanentInvalid',
			reason: 'invalid-application-update',
		});
		expect(
			classifyError(new FoodEntryNotFound({ message: 'food entry missing' })),
		).toEqual({
			_tag: 'PermanentInvalid',
			reason: 'invalid-application-update',
		});
		expect(
			classifyError(
				new InvalidDomainInput({
					message: 'invalid food correction',
					cause: 'invalid correction amount or timestamp',
				}),
			),
		).toEqual({
			_tag: 'PermanentInvalid',
			reason: 'invalid-application-update',
		});
		const caregiverErrors = [
			CaregiverAccessLost,
			CaregiverInvitationNotFound,
			CaregiverInvitationNotPending,
			CaregiverRelationshipExists,
			CaregiverSelfInvitation,
			CaregiverUsernameAmbiguous,
			CaregiverUsernameNotFound,
		];
		for (const ErrorType of caregiverErrors)
			expect(classifyError(new ErrorType({ message: 'invalid' }))).toEqual({
				_tag: 'PermanentInvalid',
				reason: 'invalid-application-update',
			});
		expect(
			classifyError(
				new TelegramError({
					module: 'Telegram',
					method: 'sendMessage',
					reason: new NetworkError({ message: 'offline' }),
				}),
			),
		).toEqual({
			_tag: 'HandledWithOutputFailure',
			error: 'telegram-output-failed',
		});
	});

	it('uses retry markers exposed by external errors', () => {
		expect(
			classifyError(
				new SqlError.SqlError({
					reason: new SqlError.ConnectionError({ cause: 'offline' }),
				}),
			),
		).toEqual({
			_tag: 'RetryableFailure',
			error: 'retryable-application-error',
		});
		expect(
			classifyError(
				new SqlError.SqlError({
					reason: new SqlError.SqlSyntaxError({ cause: 'invalid' }),
				}),
			),
		).toEqual({
			_tag: 'Fatal',
			cause: 'unclassified-application-error',
		});
	});

	it('defaults unclassified errors to fatal unless they opt in', () => {
		expect(classifyError({ _tag: 'Unexpected' } as TaggedError)).toEqual({
			_tag: 'Fatal',
			cause: 'unclassified-application-error',
		});
		expect(
			classifyError({
				_tag: 'TransientUnexpected',
				isRetryable: true,
			} as TaggedError & { readonly isRetryable: true }),
		).toEqual({
			_tag: 'RetryableFailure',
			error: 'retryable-application-error',
		});
	});
});
