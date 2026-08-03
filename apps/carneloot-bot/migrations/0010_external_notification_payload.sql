CREATE TABLE carneloot.notification_event_payloads (
  event_id uuid PRIMARY KEY REFERENCES carneloot.notification_events(id) ON DELETE CASCADE,
  template_id uuid REFERENCES carneloot.notification_templates(id),
  rendered_message text NOT NULL,
  CONSTRAINT notification_event_payloads_rendered_message_nonempty CHECK (octet_length(rendered_message) > 0)
);
