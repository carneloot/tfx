// PostgreSQL extended queries accept one statement, even with prepare:false.
// Keep quoted text and procedural bodies intact; only top-level semicolons split.
export const splitSqlStatements = (source: string): ReadonlyArray<string> => {
	const statements: Array<string> = [];
	let start = 0;
	let hasSql = false;
	let i = 0;
	while (i < source.length) {
		if (/\s/u.test(source[i]!)) {
			i++;
			continue;
		}
		if (source.startsWith('--', i)) {
			const end = source.slice(i + 2).search(/[\r\n]/u);
			i = end === -1 ? source.length : i + 3 + end;
			continue;
		}
		if (source.startsWith('/*', i)) {
			let depth = 1;
			i += 2;
			while (i < source.length && depth > 0) {
				if (source.startsWith('/*', i)) {
					depth++;
					i += 2;
				} else if (source.startsWith('*/', i)) {
					depth--;
					i += 2;
				} else i++;
			}
			if (depth > 0) hasSql = true;
			continue;
		}
		if (source[i] === ';') {
			if (hasSql) statements.push(source.slice(start, i).trim());
			start = ++i;
			hasSql = false;
			continue;
		}
		hasSql = true;
		const quote = source[i];
		if (quote === "'" || quote === '"') {
			const escaped =
				quote === "'" &&
				/[eE]/u.test(source[i - 1] ?? '') &&
				!/[\p{L}\p{N}_$]/u.test(source[i - 2] ?? '');
			i++;
			while (i < source.length) {
				if (escaped && source[i] === '\\') i += 2;
				else if (source[i] === quote) {
					if (source[i + 1] === quote) i += 2;
					else {
						i++;
						break;
					}
				} else i++;
			}
			continue;
		}
		if (quote === '$' && !/[\p{L}\p{N}_$]/u.test(source[i - 1] ?? '')) {
			const delimiter = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(
				source.slice(i),
			)?.[0];
			if (delimiter !== undefined) {
				const end = source.indexOf(delimiter, i + delimiter.length);
				i = end === -1 ? source.length : end + delimiter.length;
				continue;
			}
		}
		i++;
	}
	if (hasSql) statements.push(source.slice(start).trim());
	return statements;
};
