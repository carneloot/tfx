import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as CallbackData from '../src/CallbackData.js';

const run = Effect.runPromise;

describe('CallbackData', () => {
	it('encodes and decodes namespaced string codecs', async () => {
		const pet = CallbackData.make('pet', Schema.String);
		expect(await run(pet.encode('rex'))).toBe('pet:rex');
		expect(await run(pet.decode('pet:rex'))).toBe('rex');
	});

	it('rejects namespace mismatch and malformed payload', async () => {
		const pet = CallbackData.make('pet', Schema.String);
		await expect(run(pet.decode('food:rex'))).rejects.toMatchObject({
			reason: 'NamespaceMismatch',
		});
		await expect(run(pet.decode('malformed'))).rejects.toMatchObject({
			reason: 'MalformedPayload',
		});
	});

	it('rejects duplicate namespaces', () => {
		const values: ReadonlyArray<CallbackData.CallbackData<string>> = [
			CallbackData.make('pet', Schema.String),
			CallbackData.make('pet', Schema.String),
		];
		expect(() => CallbackData.registry(...values)).toThrow(
			'Duplicate callback namespace',
		);
	});

	it('accepts 64 bytes and rejects 65 bytes', async () => {
		const value = CallbackData.make('n', Schema.String);
		await expect(run(value.encode('x'.repeat(62)))).resolves.toHaveLength(64);
		await expect(run(value.encode('x'.repeat(63)))).rejects.toMatchObject({
			reason: 'ByteLimit',
		});
		await expect(
			run(value.decode(`n:${'x'.repeat(63)}`)),
		).rejects.toMatchObject({ reason: 'ByteLimit' });
	});

	it('counts multibyte payloads as UTF-8 bytes', async () => {
		const value = CallbackData.make('n', Schema.String);
		await expect(run(value.encode('😀'.repeat(15)))).resolves.toBe(
			`n:${'😀'.repeat(15)}`,
		);
		await expect(run(value.encode('😀'.repeat(16)))).rejects.toMatchObject({
			reason: 'ByteLimit',
		});
	});
});
