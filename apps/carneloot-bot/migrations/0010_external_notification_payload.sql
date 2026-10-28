CREATE TABLE carneloot.notification_event_payloads (
  event_id uuid PRIMARY KEY REFERENCES carneloot.notification_events(id) ON DELETE CASCADE,
  template_id uuid REFERENCES carneloot.notification_templates(id) ON DELETE SET NULL,
  rendered_message text NOT NULL,
  reply_to_message_id bigint,
  CONSTRAINT notification_event_payloads_reply_check CHECK (reply_to_message_id IS NULL OR reply_to_message_id BETWEEN 1 AND 9007199254740991),
  CONSTRAINT notification_event_payloads_message_check CHECK (char_length(rendered_message) BETWEEN 1 AND 4096)
);
