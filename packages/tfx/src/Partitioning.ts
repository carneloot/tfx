import type { UpdateRoutingScope } from './UpdateRoutingScope.js';
export type PartitionKey = string | number | bigint;
export type Partitioning = (scope: UpdateRoutingScope) => PartitionKey;
export const byChat: Partitioning = (scope) => {
	switch (scope._tag) {
		case 'ChatUser':
		case 'Chat':
			return `${scope.botId}:chat:${scope.chatId}`;
		case 'User':
			return `${scope.botId}:user:${scope.userId}`;
		case 'BusinessConnection':
			return `${scope.botId}:business:${scope.businessConnectionId}`;
		case 'Update':
			return `${scope.botId}:update:${scope.updateId}`;
	}
};
export const byConversationScope: Partitioning = (scope) =>
	scope._tag === 'ChatUser'
		? `${scope.botId}:chat:${scope.chatId}:user:${scope.userId}`
		: byChat(scope);
export const custom =
	(partition: Partitioning): Partitioning =>
	(scope) => {
		const key = partition(scope);
		if (
			typeof key !== 'string' &&
			typeof key !== 'number' &&
			typeof key !== 'bigint'
		)
			throw new TypeError(
				'Partition key must be a stable string, number, or bigint',
			);
		return key;
	};
