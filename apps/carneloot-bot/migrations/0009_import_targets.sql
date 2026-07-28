CREATE TABLE carneloot.api_keys (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES carneloot.users(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT api_keys_sha256_check CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE carneloot.notification_templates (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES carneloot.users(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT notification_templates_keyword_nonempty CHECK (octet_length(keyword) BETWEEN 1 AND 128),
  CONSTRAINT notification_templates_message_nonempty CHECK (octet_length(message) BETWEEN 1 AND 4096),
  CONSTRAINT notification_templates_owner_keyword_key UNIQUE (owner_user_id, keyword)
);

CREATE TABLE carneloot.notification_subscriptions (
  template_id uuid NOT NULL REFERENCES carneloot.notification_templates(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES carneloot.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (template_id, user_id)
);

CREATE TABLE carneloot.legacy_import_ledger (
  source_fingerprint text NOT NULL,
  source_table text NOT NULL,
  source_key text NOT NULL,
  target_table text NOT NULL,
  target_key text NOT NULL,
  row_digest text NOT NULL,
  imported_at timestamptz NOT NULL,
  PRIMARY KEY (source_fingerprint, source_table, source_key, target_table),
  CONSTRAINT legacy_import_ledger_fingerprint_nonempty CHECK (octet_length(source_fingerprint) BETWEEN 1 AND 128),
  CONSTRAINT legacy_import_ledger_digest_check CHECK (row_digest ~ '^[0-9a-f]{64}$')
);
