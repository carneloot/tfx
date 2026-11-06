// Generated from migrations/0010_external_notification_payload.sql; do not edit.
export const migration0010Sql =
	'CREATE TABLE carnebot.notification_event_payloads (\n  event_id uuid PRIMARY KEY REFERENCES carnebot.notification_events(id) ON DELETE CASCADE,\n  template_id uuid REFERENCES carnebot.notification_templates(id) ON DELETE SET NULL,\n  rendered_message text NOT NULL,\n  reply_to_message_id bigint,\n  CONSTRAINT notification_event_payloads_reply_check CHECK (reply_to_message_id IS NULL OR reply_to_message_id BETWEEN 1 AND 9007199254740991),\n  CONSTRAINT notification_event_payloads_message_check CHECK (char_length(rendered_message) BETWEEN 1 AND 4096)\n);\n';
export const migration0010Checksum =
	'819b75947a4cb40bfe4c224eb4e0ed896b812a554f47a5bafb10c2ed651625b6';
