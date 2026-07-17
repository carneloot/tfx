import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { BotId, PetId, TelegramUserId, UserId } from '../../src/domain/Ids.js';
import {
	DuplicateFoodEntry,
	PetAccessDenied,
	PetFoodSetupMissing,
} from '../../src/domain/pet-food/PetFoodError.js';
import { PetName } from '../../src/domain/Pet.js';
import { PetRepository } from '../../src/ports/PetRepository.js';

const addFoodExecute = vi.fn();
vi.mock('../../src/application/AddFood.js', () => ({
	execute: (...args: ReadonlyArray<unknown>) => addFoodExecute(...args),
}));

const AddFoodToAll = await import('../../src/application/AddFoodToAll.js');

const decode = <A>(
	schema: Schema.Top & { readonly Type: A },
	value: unknown,
): A => Schema.decodeUnknownSync(schema)(value);
const actorId = decode(UserId, '00000000-0000-4000-8000-000000000001');
const access = {
	actorId,
	botId: decode(BotId, 'bot'),
	telegramUserId: decode(TelegramUserId, 42),
};
const input = { amountMg: 50_000 as never, when: '', messageDate: {} as never };
const source = { botId: 'bot', updateId: 10 };
const pet = (index: number) => ({
	id: decode(
		PetId,
		`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
	),
	ownerId: actorId,
	name: decode(PetName, `Pet ${index}`),
	createdAt: {} as never,
	updatedAt: {} as never,
});
const entry = (petId: ReturnType<typeof pet>['id']) => ({ petId }) as never;
const repositoryLayer = (
	pets: ReadonlyArray<ReturnType<typeof pet>>,
	list = vi.fn(),
) => {
	list.mockReturnValue(Effect.succeed(pets));
	return {
		list,
		layer: Layer.succeed(PetRepository, {
			listAccessible: list,
			findById: () => Effect.die('unused'),
			lockById: () => Effect.die('unused'),
			deleteOwned: () => Effect.die('unused'),
			addOwned: () => Effect.die('unused'),
			listOwned: () => Effect.die('unused'),
		}),
	};
};
const run = (layer: Layer.Layer<PetRepository>) =>
	Effect.runPromise(
		(
			AddFoodToAll.execute(
				access,
				input,
				source,
			) as Effect.Effect<AddFoodToAll.AddFoodToAllResult>
		).pipe(Effect.provide(layer)),
	);

describe('AddFoodToAll', () => {
	it('returns no items and loads accessible pets once', async () => {
		const repository = repositoryLayer([]);
		const result = await run(repository.layer);
		expect(result).toEqual({ items: [] });
		expect(repository.list).toHaveBeenCalledOnce();
		expect(repository.list).toHaveBeenCalledWith(actorId);
		expect(addFoodExecute).not.toHaveBeenCalled();
	});

	it('preserves pet order and maps mixed closed outcomes including replay', async () => {
		const pets = Array.from({ length: 5 }, (_, index) => pet(index + 1));
		const outcomes: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
			Effect.succeed({ entry: entry(pets[0]!.id), replayed: false }),
			Effect.fail(new PetFoodSetupMissing({ message: 'missing' })),
			Effect.fail(new DuplicateFoodEntry({ message: 'duplicate' })),
			Effect.fail(new PetAccessDenied({ message: 'lost' })),
			Effect.succeed({ entry: entry(pets[4]!.id), replayed: true }),
		];
		addFoodExecute.mockImplementation(({ petId }) =>
			Effect.delay(
				outcomes[pets.findIndex((candidate) => candidate.id === petId)]!,
				`${6 - pets.findIndex((candidate) => candidate.id === petId)} millis`,
			),
		);

		const result = await run(repositoryLayer(pets).layer);
		expect(result.items.map((item) => item._tag)).toEqual([
			'Added',
			'SetupMissing',
			'Duplicate',
			'AccessLost',
			'Replayed',
		]);
		expect(result.items.map((item) => item.pet.id)).toEqual(
			pets.map((item) => item.id),
		);
		expect(addFoodExecute).toHaveBeenCalledTimes(5);
		for (const candidate of pets)
			expect(addFoodExecute).toHaveBeenCalledWith(
				{ ...access, petId: candidate.id },
				input,
				source,
			);
	});

	it('caps concurrency at four', async () => {
		const pets = Array.from({ length: 8 }, (_, index) => pet(index + 10));
		let active = 0;
		let maximum = 0;
		addFoodExecute.mockImplementation(({ petId }) =>
			Effect.acquireUseRelease(
				Effect.sync(() => {
					active += 1;
					maximum = Math.max(maximum, active);
				}),
				() =>
					Effect.delay(
						Effect.succeed({ entry: entry(petId), replayed: false }),
						'5 millis',
					),
				() =>
					Effect.sync(() => {
						active -= 1;
					}),
			),
		);
		await run(repositoryLayer(pets).layer);
		expect(maximum).toBe(4);
	});

	it('propagates unhandled failures', async () => {
		addFoodExecute.mockReturnValue(Effect.fail(new Error('infrastructure')));
		await expect(run(repositoryLayer([pet(20)]).layer)).rejects.toThrow(
			'infrastructure',
		);
	});
});
