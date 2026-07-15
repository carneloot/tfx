import { packageName } from '@tfx/postgres';
import { describe, expect, it } from 'vitest';

describe('@tfx/postgres package', () => {
	it('loads', () => expect(packageName).toBe('@tfx/postgres'));
});
