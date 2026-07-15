import { describe, expect, it } from 'vitest';

import * as Partitioning from '../src/Partitioning.js';
describe('Partitioning', () => {
	it('partitions chat and conversation scopes deterministically', () => {
		const scope = {
			_tag: 'ChatUser' as const,
			botId: 'b',
			chatId: 1,
			userId: 2,
			updateId: 3,
		};
		expect(Partitioning.byChat(scope)).toBe('b:chat:1');
		expect(Partitioning.byConversationScope(scope)).toBe('b:chat:1:user:2');
	});
	it('falls back to user, business, and update keys', () => {
		expect(
			Partitioning.byChat({ _tag: 'User', botId: 'b', userId: 2, updateId: 1 }),
		).toBe('b:user:2');
		expect(
			Partitioning.byChat({
				_tag: 'BusinessConnection',
				botId: 'b',
				businessConnectionId: 'x',
				updateId: 1,
			}),
		).toBe('b:business:x');
		expect(
			Partitioning.byChat({ _tag: 'Update', botId: 'b', updateId: 9 }),
		).toBe('b:update:9');
	});
	it('rejects non-hashable custom keys at runtime', () =>
		expect(() =>
			Partitioning.custom(() => ({}) as never)({
				_tag: 'Update',
				botId: 'b',
				updateId: 1,
			}),
		).toThrow('stable'));
});
