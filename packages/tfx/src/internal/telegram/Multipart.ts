export type Upload = Blob | File;

export const hasUpload = (
	payload: Readonly<Record<string, unknown>>,
): boolean => Object.values(payload).some((value) => value instanceof Blob);

export const toFormData = (
	payload: Readonly<Record<string, unknown>>,
): FormData => {
	const form = new FormData();
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined) continue;
		if (value instanceof Blob) form.append(key, value);
		else if (typeof value === 'object') form.append(key, JSON.stringify(value));
		else form.append(key, String(value));
	}
	return form;
};
