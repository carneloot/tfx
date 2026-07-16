export interface SweepCursor<K, V> {
	iterator: Iterator<[K, V]> | undefined;
}

export const makeCursor = <K, V>(): SweepCursor<K, V> => ({
	iterator: undefined,
});

export const sweep = <K, V>(
	values: Map<K, V>,
	cursor: SweepCursor<K, V>,
	shouldDelete: (value: V) => boolean,
	limit: number,
): void => {
	cursor.iterator ??= values.entries();
	let scanned = 0;
	while (scanned < limit) {
		const next = cursor.iterator.next();
		if (next.done) {
			cursor.iterator = undefined;
			return;
		}
		scanned++;
		const [key, value] = next.value;
		if (shouldDelete(value)) values.delete(key);
	}
};
