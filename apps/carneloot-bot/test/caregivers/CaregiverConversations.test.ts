import * as PgClient from '@effect/sql-pg/PgClient';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { Conversations } from 'tfx/Conversations';
import * as ConversationsLive from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as MemoryStorage from 'tfx/MemoryConversationStorage';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { Telegram } from 'tfx/Telegram';
import { describe, expect, it } from 'vitest';

import * as DeletePet from '../../src/bot/conversations/DeletePetConversation.js';
import * as Invite from '../../src/bot/conversations/InviteCaregiverConversation.js';
import * as List from '../../src/bot/conversations/ListCaregiversConversation.js';
import * as Invitations from '../../src/bot/conversations/PetInvitationsConversation.js';
import * as Remove from '../../src/bot/conversations/RemoveCaregiverConversation.js';
import * as Stop from '../../src/bot/conversations/StopCaringConversation.js';
import type {
	CaregiverStatus,
	PetCaregiver,
} from '../../src/domain/caregivers/PetCaregiver.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';
import { UserRepository } from '../../src/ports/UserRepository.js';

const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const caregiverId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000002',
);
const petId = Schema.decodeUnknownSync(PetId)(
	'00000000-0000-4000-8000-000000000003',
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const now = DateTime.makeUnsafe(0);
const pet = {
	id: petId,
	ownerId,
	name: 'Rex' as const,
	nameKey: 'rex',
	createdAt: now,
	updatedAt: now,
};
const registered = (id: typeof ownerId, telegram: number, name: string) => ({
	user: { id, createdAt: now, updatedAt: now },
	profile: {
		botId,
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegram),
		username: name.toLowerCase(),
		firstName: name,
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegram),
	},
});
const owner = registered(ownerId, 101, 'Owner');
const caregiver = registered(caregiverId, 202, 'Caregiver');
const scope = { botId: 'carneloot', chatId: 101, userId: 101 };
const ownerStartup = {
	actorId: ownerId,
	botId,
	telegramUserId: owner.profile.telegramUserId,
	pets: [{ id: petId, name: pet.name }],
};
const inviteeStartup = {
	actorId: caregiverId,
	botId,
	telegramUserId: caregiver.profile.telegramUserId,
	invitations: [{ petId, petName: pet.name, ownerDisplayName: 'Owner' }],
};
const caredStartup = {
	actorId: caregiverId,
	botId,
	telegramUserId: caregiver.profile.telegramUserId,
	pets: [{ id: petId, name: pet.name }],
};
type Built =
	| typeof DeletePet.built
	| typeof Invite.built
	| typeof List.built
	| typeof Invitations.built
	| typeof Remove.built
	| typeof Stop.built;

const harness = (initial: CaregiverStatus | undefined = 'pending') => {
	const replies: string[] = [],
		notices: string[] = [],
		mutations: string[] = [];
	const relation: { value: PetCaregiver | undefined } = {
		value:
			initial === undefined
				? undefined
				: {
						petId,
						caregiverUserId: caregiverId,
						status: initial,
						createdAt: now,
						updatedAt: now,
					},
	};
	const available = { value: true },
		outputFailure = { value: false };
	const context: MessageContextService = {
		message: {} as never,
		chatId: 101,
		messageId: 1,
		messageThreadId: undefined,
		businessConnectionId: undefined,
		reply: (text, options) =>
			Effect.suspend(() => {
				if (outputFailure.value && /sucesso|aceito|parou/.test(text))
					return Effect.die('output');
				replies.push(text);
				if (
					(options?.reply_markup as { remove_keyboard?: boolean } | undefined)
						?.remove_keyboard
				)
					mutations.push('keyboard-removed');
				return Effect.succeed({} as never);
			}),
		replyToCurrent: () => Effect.die('unused'),
		react: () => Effect.succeed(true),
		editText: () => Effect.die('unused'),
		delete: () => Effect.succeed(true),
		sendChatAction: () => Effect.succeed(true),
	};
	const users = {
		registerTelegramProfile: () => Effect.die('unused'),
		findByTelegram: (_b: unknown, id: number) =>
			Effect.succeed(id === 101 ? owner : caregiver),
		findById: (_b: unknown, id: typeof ownerId) =>
			Effect.succeed(id === ownerId ? owner : caregiver),
		findByUsername: () => Effect.succeed([caregiver]),
	};
	const pets = {
		findById: () => Effect.succeed(available.value ? pet : undefined),
		lockById: () => Effect.succeed(available.value ? pet : undefined),
		deleteOwned: () =>
			Effect.sync(() => {
				if (!available.value) return false;
				available.value = false;
				mutations.push('delete');
				return true;
			}),
		addOwned: () => Effect.die('unused'),
		listOwned: () => Effect.succeed([pet]),
		listAccessible: () => Effect.succeed([pet]),
	};
	const caregivers = {
		find: () => Effect.succeed(relation.value),
		lock: () => Effect.succeed(relation.value),
		insertPending: () =>
			Effect.sync(() => {
				relation.value = {
					petId,
					caregiverUserId: caregiverId,
					status: 'pending',
					createdAt: now,
					updatedAt: now,
				};
				mutations.push('invite');
				return relation.value;
			}),
		setPendingResponse: (_p: unknown, _u: unknown, status: CaregiverStatus) =>
			Effect.sync(() => {
				if (!relation.value || relation.value.status !== 'pending')
					return undefined;
				relation.value = { ...relation.value, status };
				mutations.push(status);
				return relation.value;
			}),
		remove: () =>
			Effect.sync(() => {
				if (!relation.value) return false;
				relation.value = undefined;
				mutations.push('remove');
				return true;
			}),
		listForPet: () => Effect.succeed(relation.value ? [relation.value] : []),
		listPendingForUser: () =>
			Effect.succeed(
				relation.value?.status === 'pending' ? [relation.value] : [],
			),
		listAcceptedForUser: () =>
			Effect.succeed(
				relation.value?.status === 'accepted' ? [relation.value] : [],
			),
	};
	const layer = Layer.mergeAll(
		MemoryStorage.layer,
		Layer.succeed(MessageContext, context),
		Layer.succeed(Telegram, {
			sendMessage: (p: { text: string }) =>
				Effect.sync(() => {
					notices.push(p.text);
					return {} as never;
				}),
		} as never),
		Layer.succeed(UserRepository, users as never),
		Layer.succeed(PetRepository, pets as never),
		Layer.succeed(PetCaregiverRepository, caregivers as never),
		Layer.succeed(ReminderScheduler, {
			cancelForPet: () => Effect.void,
			replaceForLatest: () => Effect.void,
		}),
		Layer.succeed(PgClient.PgClient, {
			withTransaction: <A, E, R>(e: Effect.Effect<A, E, R>) => e,
		} as never),
	);
	return {
		replies,
		notices,
		mutations,
		relation,
		available,
		outputFailure,
		layer,
	};
};
const fresh = <A, E, R>(effect: Effect.Effect<A, E, R | Conversations>) =>
	Effect.provide(effect, Layer.fresh(ConversationsLive.layer));
const start = (built: Built, startup: object) =>
	fresh(
		Effect.flatMap(Conversations, (s) =>
			s.start(built as never, startup as never, { scope, conflict: 'replace' }),
		),
	);
const resume = (built: Built, input: string, updateId: number) =>
	fresh(
		Effect.flatMap(Conversations, (s) =>
			s.resume(built as never, input, { scope, updateId }),
		),
	);
const run = <A, E>(e: Effect.Effect<A, E, unknown>) =>
	Effect.runPromise(e as Effect.Effect<A, E>);

describe('caregiver durable conversation transcripts', () => {
	it('covers owner selection, invalid input, no confirmation, listing, and restart', async () => {
		const h = harness('accepted');
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start(DeletePet.built, ownerStartup);
					yield* resume(DeletePet.built, 'forged', 1);
					const storage = yield* ConversationStorage;
					const persisted = yield* storage.load(scope);
					expect(persisted?.step).toBe('pet');
					yield* resume(DeletePet.built, 'Rex', 2);
					yield* resume(DeletePet.built, 'Não', 3);
					yield* start(List.built, ownerStartup);
					yield* resume(List.built, 'Rex', 4);
				}),
				h.layer,
			),
		);
		expect(h.mutations).not.toContain('delete');
		expect(h.replies).toContain('Pet não deletado.');
		expect(h.replies.some((x) => x.includes('Caregiver — aceito'))).toBe(true);
	});
	it('invites with afterCommit notice and commits once when Telegram output fails', async () => {
		const h = harness(undefined);
		h.outputFailure.value = true;
		const exit = await run(
			Effect.provide(
				Effect.exit(
					Effect.gen(function* () {
						yield* start(Invite.built, ownerStartup);
						yield* resume(Invite.built, 'Rex', 1);
						yield* resume(Invite.built, '@caregiver', 2);
					}),
				),
				h.layer,
			),
		);
		expect(exit._tag).toBe('Failure');
		expect(h.mutations.filter((x) => x === 'invite')).toHaveLength(1);
		expect(h.relation.value?.status).toBe('pending');
	});
	it.each([
		['Sim', 'accepted'],
		['Não', 'rejected'],
	] as const)('responds %s after durable restart', async (answer, status) => {
		const h = harness('pending');
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start(Invitations.built, inviteeStartup);
					yield* resume(Invitations.built, 'Rex (Owner)', 1);
					const storage = yield* ConversationStorage;
					const persisted = yield* storage.load(scope);
					expect(persisted?.step).toBe('confirm');
					yield* resume(Invitations.built, answer, 2);
				}),
				h.layer,
			),
		);
		expect(h.relation.value?.status).toBe(status);
		expect(h.notices).toHaveLength(1);
	});
	it('removal detects relation revocation between selection and final input', async () => {
		const h = harness('accepted');
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start(Remove.built, ownerStartup);
					yield* resume(Remove.built, 'Rex', 1);
					h.relation.value = undefined;
					yield* resume(Remove.built, 'Caregiver (aceito)', 2);
				}),
				h.layer,
			),
		);
		expect(h.replies.at(-1)).toBe(
			'Este pet não está mais disponível para você.',
		);
		expect(h.mutations).not.toContain('remove');
	});
	it('stops caring on yes and preserves relation on no with keyboard removal', async () => {
		for (const answer of ['Não', 'Sim']) {
			const h = harness('accepted');
			await run(
				Effect.provide(
					Effect.gen(function* () {
						yield* start(Stop.built, caredStartup);
						yield* resume(Stop.built, 'Rex', 1);
						yield* resume(Stop.built, answer, 2);
					}),
					h.layer,
				),
			);
			expect(h.relation.value === undefined).toBe(answer === 'Sim');
			expect(h.mutations).toContain('keyboard-removed');
		}
	});
	it('rejects empty startup choices and invalid entries', () => {
		expect(() =>
			DeletePet.declaration.startup.make({ ...ownerStartup, pets: [] }),
		).toThrow();
		expect(() =>
			Invite.declaration.startup.make({ ...ownerStartup, pets: [] }),
		).toThrow();
		expect(() =>
			List.declaration.startup.make({ ...ownerStartup, pets: [] }),
		).toThrow();
		expect(() =>
			Remove.declaration.startup.make({ ...ownerStartup, pets: [] }),
		).toThrow();
		expect(() =>
			Invitations.declaration.startup.make({
				...inviteeStartup,
				invitations: [],
			}),
		).toThrow();
		expect(() =>
			Stop.declaration.startup.make({ ...caredStartup, pets: [] }),
		).toThrow();
		expect(() =>
			DeletePet.declaration.startup.make({ ...ownerStartup, pets: [{}] }),
		).toThrow();
	});
});
