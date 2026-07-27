import { Crypto, Effect, Schema } from 'effect';

import { Uuid } from '../domain/Uuid.js';

/** Namespace reserved for deterministic Carneloot legacy-import identifiers. */
export const LegacyIdNamespace = '7d4f55c8-2f1d-5b6c-9a3e-8b4f1e7c2d90';

const encoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const namespaceBytes = Uint8Array.from([
	0x7d, 0x4f, 0x55, 0xc8, 0x2f, 0x1d, 0x5b, 0x6c, 0x9a, 0x3e, 0x8b, 0x4f, 0x1e,
	0x7c, 0x2d, 0x90,
]);

const formatUuid = (bytes: Uint8Array): string => {
	const hex = bytesToHex(bytes);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Stable source identity independent of database location or credentials. */
export const sourceFingerprint = (sourceId: string) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const digest = yield* crypto.digest(
			'SHA-256',
			encoder.encode(`legacy-source-v1\0${sourceId}`),
		);
		return `sha256:${bytesToHex(digest)}`;
	});

/** RFC 4122 UUIDv5 derived solely from source identity, table, and legacy key. */
export const legacyId = (
	fingerprint: string,
	table: string,
	legacyId: string,
) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const name = encoder.encode(`${fingerprint}:${table}:${legacyId}`);
		const input = new Uint8Array(namespaceBytes.length + name.length);
		input.set(namespaceBytes);
		input.set(name, namespaceBytes.length);

		const digest = yield* crypto.digest('SHA-1', input);
		const uuidBytes = digest.slice(0, 16);
		uuidBytes[6] = ((uuidBytes[6] ?? 0) & 0x0f) | 0x50;
		uuidBytes[8] = ((uuidBytes[8] ?? 0) & 0x3f) | 0x80;

		return yield* Schema.decodeUnknownEffect(Uuid)(formatUuid(uuidBytes));
	});
