export interface DemoSummary {
	readonly users: number;
	readonly pets: number;
	readonly foodEntries: number;
	readonly reminderEvents: number;
	readonly reminderStatus: 'scheduled' | 'completed';
	readonly deliveryOutcome: 'not-materialized' | 'sent' | 'unknown' | 'failed';
}
export const format = (summary: DemoSummary): string =>
	`users=${summary.users} pets=${summary.pets} food_entries=${summary.foodEntries} reminder_events=${summary.reminderEvents} reminder_status=${summary.reminderStatus} delivery_outcome=${summary.deliveryOutcome}`;
