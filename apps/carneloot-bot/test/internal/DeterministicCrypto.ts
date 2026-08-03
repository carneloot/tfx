import { Crypto, Effect, Layer } from 'effect';

export const layer = (start = 1) => {
	let counter = start;
	return Layer.succeed(Crypto.Crypto, {
		...Crypto.make({
			randomBytes: (size) => new Uint8Array(size),
			digest: (_algorithm, data) => Effect.succeed(data),
		}),
		randomUUIDv4: Effect.sync(
			() =>
				`00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, '0')}`,
		),
	});
};
