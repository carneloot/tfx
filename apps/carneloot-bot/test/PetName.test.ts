import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { PetName, petNameKey } from '../src/domain/Pet.js';
const decode = Schema.decodeUnknownSync(PetName);
describe('PetName', () => {
	it('normalizes Unicode whitespace and preserves display casing', () => {
		expect(decode('  Rex\u00a0  JÚNIOR ')).toBe('Rex JÚNIOR');
		expect(petNameKey(' Rex  JÚNIOR ')).toBe('rex júnior');
	});
	it('enforces independent UTF-8 display and key limits', () => {
		expect(new TextEncoder().encode(decode('a'.repeat(80)))).toHaveLength(80);
		expect(() => decode('a'.repeat(81))).toThrow();
		expect(() => decode('🐶'.repeat(21))).toThrow();
	});
	it('rejects empty and Cc controls while retaining Cf policy', () => {
		expect(() => decode(' \n ')).toThrow();
		expect(() => decode('Rex\u0000')).toThrow();
		expect(decode('Rex\u200d')).toBe('Rex\u200d');
	});
});
