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

const harness = (initial: CaregiverStatus | null = 'pending') => {
	const replies: string[] = [],
		markups: unknown[] = [],
		notices: string[] = [],
		mutations: string[] = [];
	const responsePetIds: (typeof petId)[] = [];
	const relation: { value: PetCaregiver | undefined } = {
		value:
			initial === null
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
				if (
					outputFailure.value &&
					/sucesso|aceito|recusado|removido|parou/.test(text)
				)
					return Effect.die('output');
				replies.push(text);
				markups.push(options?.reply_markup);
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
		setPendingResponse: (
			responsePetId: typeof petId,
			_u: unknown,
			status: CaregiverStatus,
		) =>
			Effect.sync(() => {
				if (!relation.value || relation.value.status !== 'pending')
					return undefined;
				responsePetIds.push(responsePetId);
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
		markups,
		notices,
		mutations,
		responsePetIds,
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
		const h = harness(null);
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
		expect((() => h.relation.value)()?.status).toBe('pending');
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
	it('renders canonical caregiver keyboards and removes them at boundaries', async () => {
		const h = harness('accepted');
		const keyboard = (rows: string[][]) =>
			expect.objectContaining({
				keyboard: rows.map((row) => row.map((text) => ({ text }))),
				one_time_keyboard: true,
				resize_keyboard: true,
			});
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start(DeletePet.built, ownerStartup);
					expect(h.markups.at(-1)).toEqual(keyboard([['Rex'], ['Cancelar']]));
					yield* resume(DeletePet.built, 'Rex', 1);
					expect(h.markups.at(-1)).toEqual(keyboard([['Sim', 'Não']]));
					yield* resume(DeletePet.built, 'Não', 2);
					expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });

					yield* start(Invite.built, ownerStartup);
					expect(h.markups.at(-1)).toEqual(keyboard([['Rex'], ['Cancelar']]));
					yield* resume(Invite.built, 'Rex', 3);
					expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });

					yield* start(List.built, ownerStartup);
					expect(h.markups.at(-1)).toEqual(keyboard([['Rex'], ['Cancelar']]));
					yield* resume(List.built, 'Rex', 4);
					expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });

					yield* start(Invitations.built, inviteeStartup);
					expect(h.markups.at(-1)).toEqual(
						keyboard([['Rex (Owner)'], ['Cancelar']]),
					);
					yield* resume(Invitations.built, 'Rex (Owner)', 5);
					expect(h.markups.at(-1)).toEqual(keyboard([['Sim', 'Não']]));
					yield* resume(Invitations.built, 'Não', 6);
					expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });

					yield* start(Remove.built, ownerStartup);
					expect(h.markups.at(-1)).toEqual(keyboard([['Rex'], ['Cancelar']]));
					yield* resume(Remove.built, 'Rex', 7);
					expect(h.markups.at(-1)).toEqual(
						keyboard([['Caregiver (aceito)'], ['Cancelar']]),
					);

					yield* start(Stop.built, caredStartup);
					expect(h.markups.at(-1)).toEqual(keyboard([['Rex'], ['Cancelar']]));
					yield* resume(Stop.built, 'Rex', 8);
					expect(h.markups.at(-1)).toEqual(keyboard([['Sim', 'Não']]));
					yield* resume(Stop.built, 'Não', 9);
					expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });
				}),
				h.layer,
			),
		);
	});
	it('removes keyboard at every successful caregiver terminal', async () => {
		const removeKeyboard = { remove_keyboard: true };
		for (const [built, startup, inputs] of [
			[DeletePet.built, ownerStartup, ['Rex', 'Sim']],
			[Invite.built, ownerStartup, ['Rex', '@caregiver']],
			[List.built, ownerStartup, ['Rex']],
			[Invitations.built, inviteeStartup, ['Rex (Owner)', 'Sim']],
			[Remove.built, ownerStartup, ['Rex', 'Caregiver (aceito)']],
			[Stop.built, caredStartup, ['Rex', 'Sim']],
		] as const) {
			const h = harness(built === Invitations.built ? 'pending' : 'accepted');
			await run(
				Effect.provide(
					Effect.gen(function* () {
						yield* start(built, startup);
						for (const [index, input] of inputs.entries())
							yield* resume(built, input, index + 1);
					}),
					h.layer,
				),
			);
			expect(h.markups.at(-1)).toEqual(removeKeyboard);
		}
	});
	it('removes keyboard at unavailable and no-caregiver terminals', async () => {
		for (const [built, startup, beforeTerminal, terminal] of [
			[DeletePet.built, ownerStartup, ['Rex'], 'Sim'],
			[Invite.built, ownerStartup, ['Rex'], '@caregiver'],
			[List.built, ownerStartup, [], 'Rex'],
			[Invitations.built, inviteeStartup, ['Rex (Owner)'], 'Sim'],
			[Remove.built, ownerStartup, [], 'Rex'],
			[Stop.built, caredStartup, ['Rex'], 'Sim'],
		] as const) {
			const h = harness(built === Invitations.built ? 'pending' : 'accepted');
			await run(
				Effect.provide(
					Effect.gen(function* () {
						yield* start(built, startup);
						for (const [index, input] of beforeTerminal.entries())
							yield* resume(built, input, index + 1);
						h.available.value = false;
						yield* resume(built, terminal, beforeTerminal.length + 1);
					}),
					h.layer,
				),
			);
			expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });
		}

		const h = harness(null);
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start(Remove.built, ownerStartup);
					yield* resume(Remove.built, 'Rex', 1);
				}),
				Layer.fresh(h.layer),
			),
		);
		expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });
	});
	it('removes keyboard and confirms cancellation at every caregiver choice step', async () => {
		const cancel = async (built: Built, startup: object, inputs: string[]) => {
			const h = harness('accepted');
			await run(
				Effect.provide(
					Effect.gen(function* () {
						yield* start(built, startup);
						for (const [index, input] of inputs.entries())
							yield* resume(built, input, index + 1);
					}),
					h.layer,
				),
			);
			expect(h.replies.at(-1)).toBe('Operação cancelada.');
			expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });
		};
		await cancel(DeletePet.built, ownerStartup, ['Cancelar']);
		await cancel(Invite.built, ownerStartup, ['Cancelar']);
		await cancel(List.built, ownerStartup, ['Cancelar']);
		await cancel(Invitations.built, inviteeStartup, ['Cancelar']);
		await cancel(Remove.built, ownerStartup, ['Cancelar']);
		await cancel(Remove.built, ownerStartup, ['Rex', 'Cancelar']);
		await cancel(Stop.built, caredStartup, ['Cancelar']);
	});
	it('maps duplicate invitation display-label suffix to selected pet id', async () => {
		const secondPetId = Schema.decodeUnknownSync(PetId)(
			'00000000-0000-4000-8000-000000000004',
		);
		const startup = {
			...inviteeStartup,
			invitations: [
				{ petId, petName: 'Rex', ownerDisplayName: 'Owner' },
				{ petId: secondPetId, petName: 'Rex', ownerDisplayName: 'Owner' },
			],
		};
		const h = harness('pending');
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start(Invitations.built, startup);
					expect(h.markups.at(-1)).toEqual({
						keyboard: [
							[{ text: 'Rex (Owner) (1)' }],
							[{ text: 'Rex (Owner) (2)' }],
							[{ text: 'Cancelar' }],
						],
						one_time_keyboard: true,
						resize_keyboard: true,
					});
					yield* resume(Invitations.built, 'Rex (Owner) (2)', 1);
					yield* resume(Invitations.built, 'Sim', 2);
				}),
				h.layer,
			),
		);
		expect(h.responsePetIds).toEqual([secondPetId]);
	});
	it('commits remove, invitation response, and stop-caring before output failure', async () => {
		const cases = [
			{
				built: Remove.built,
				startup: ownerStartup,
				inputs: ['Rex', 'Caregiver (aceito)'],
				initial: 'accepted' as const,
				assert: (h: ReturnType<typeof harness>) => {
					expect(h.mutations.filter((x) => x === 'remove')).toHaveLength(1);
					expect(h.relation.value).toBeUndefined();
				},
			},
			{
				built: Invitations.built,
				startup: inviteeStartup,
				inputs: ['Rex (Owner)', 'Sim'],
				initial: 'pending' as const,
				assert: (h: ReturnType<typeof harness>) => {
					expect(h.mutations.filter((x) => x === 'accepted')).toHaveLength(1);
					expect(h.relation.value?.status).toBe('accepted');
				},
			},
			{
				built: Stop.built,
				startup: caredStartup,
				inputs: ['Rex', 'Sim'],
				initial: 'accepted' as const,
				assert: (h: ReturnType<typeof harness>) => {
					expect(h.mutations.filter((x) => x === 'remove')).toHaveLength(1);
					expect(h.relation.value).toBeUndefined();
				},
			},
		] as const;
		for (const testCase of cases) {
			const h = harness(testCase.initial);
			h.outputFailure.value = true;
			const exit = await run(
				Effect.provide(
					Effect.exit(
						Effect.gen(function* () {
							yield* start(testCase.built, testCase.startup);
							for (const [index, input] of testCase.inputs.entries())
								yield* resume(testCase.built, input, index + 1);
						}),
					),
					h.layer,
				),
			);
			expect(exit._tag).toBe('Failure');
			testCase.assert(h);
		}
	});
	it('cancels visibly and re-renders choices after forged labels', async () => {
		const h = harness('accepted');
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* start(DeletePet.built, ownerStartup);
					const expected = h.markups.at(-1);
					yield* resume(DeletePet.built, 'forged', 1);
					expect(h.markups.at(-1)).toEqual(expected);
					const storage = yield* ConversationStorage;
					expect((yield* storage.load(scope))?.step).toBe('pet');
					yield* resume(DeletePet.built, 'Cancelar', 2);
					expect(yield* storage.load(scope)).toBeUndefined();
					expect(h.markups.at(-1)).toEqual({ remove_keyboard: true });
					expect(h.mutations).not.toContain('delete');
				}),
				h.layer,
			),
		);
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
