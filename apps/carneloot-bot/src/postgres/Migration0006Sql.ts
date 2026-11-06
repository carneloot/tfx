// Generated from migrations/0006_pet_caregivers.sql; do not edit.
export const migration0006Sql =
	"CREATE TABLE carnebot.pet_caregivers (\n  pet_id uuid NOT NULL,\n  caregiver_user_id uuid NOT NULL,\n  status text NOT NULL,\n  created_at timestamptz NOT NULL,\n  updated_at timestamptz NOT NULL,\n  CONSTRAINT pet_caregivers_pk PRIMARY KEY (pet_id, caregiver_user_id),\n  CONSTRAINT pet_caregivers_pet_fk FOREIGN KEY (pet_id)\n    REFERENCES carnebot.pets(id) ON DELETE CASCADE,\n  CONSTRAINT pet_caregivers_user_fk FOREIGN KEY (caregiver_user_id)\n    REFERENCES carnebot.users(id) ON DELETE RESTRICT,\n  CONSTRAINT pet_caregivers_status_check\n    CHECK (status IN ('pending', 'accepted', 'rejected'))\n);\nCREATE INDEX pet_caregivers_user_status_pet_idx\n  ON carnebot.pet_caregivers (caregiver_user_id, status, pet_id);\n";
export const migration0006Checksum =
	'cfbdb778db8f09be2730aad853eddf16e8a78548ec9cefc0c8f775ca5bd81bd0';
