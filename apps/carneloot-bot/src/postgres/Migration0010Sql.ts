// Generated from migrations/0010_external_notification_payload.sql; do not edit.
export const migration0010Sql =
	'CREATE TABLE carneloot.notification_event_payloads (\n  event_id uuid PRIMARY KEY REFERENCES carneloot.notification_events(id) ON DELETE CASCADE,\n  template_id uuid REFERENCES carneloot.notification_templates(id),\n  rendered_message text NOT NULL,\n  CONSTRAINT notification_event_payloads_rendered_message_nonempty CHECK (octet_length(rendered_message) > 0)\n);\n';
export const migration0010Checksum =
	'a23852905a350e690fde7e3874563cb269382918d71f475923cac34367bd6163';
