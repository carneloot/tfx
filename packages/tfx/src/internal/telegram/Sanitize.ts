export const safeMessage = (value: unknown): string => {
	const text = value instanceof Error ? value.message : String(value);
	return text
		.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]')
		.replace(/\b\d{5,}:[A-Za-z0-9_-]+\b/g, '[REDACTED]');
};
