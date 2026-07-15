CREATE TABLE carneloot.users (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE carneloot.telegram_identities (
  bot_id text NOT NULL,
  telegram_user_id bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES carneloot.users(id) ON DELETE CASCADE,
  username text,
  first_name text NOT NULL,
  last_name text,
  private_chat_id bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT telegram_identities_pk PRIMARY KEY (bot_id, telegram_user_id),
  CONSTRAINT telegram_identities_bot_user_key UNIQUE (bot_id, user_id)
);
CREATE TABLE carneloot.pets (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES carneloot.users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  name_key text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pets_owner_name_key UNIQUE (owner_id, name_key),
  CONSTRAINT pets_name_octets CHECK (octet_length(name) BETWEEN 1 AND 80),
  CONSTRAINT pets_name_key_octets CHECK (octet_length(name_key) BETWEEN 1 AND 80)
);
