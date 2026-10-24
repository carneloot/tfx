import { Crypto, Effect, Layer } from 'effect';

export const layer = (start = 1) => {
	let counter = start;
	return Layer.succeed(
		Crypto.Crypto,
		Crypto.make({
			randomBytes: (size) => {
				const bytes = new Uint8Array(size);
				let value = counter++;
				for (let i = size - 1; i >= Math.max(0, size - 6); i--) {
					bytes[i] = value % 256;
					value = Math.floor(value / 256);
				}
				return bytes;
			},
			digest: (_algorithm, data) => Effect.succeed(data),
		}),
	);
};
