// Generated from migrations/0006_pet_caregivers.sql; do not edit.
export const migration0006Sql =
	"CREATE TABLE carneloot.pet_caregivers (\n  pet_id uuid NOT NULL,\n  caregiver_user_id uuid NOT NULL,\n  status text NOT NULL,\n  created_at timestamptz NOT NULL,\n  updated_at timestamptz NOT NULL,\n  CONSTRAINT pet_caregivers_pk PRIMARY KEY (pet_id, caregiver_user_id),\n  CONSTRAINT pet_caregivers_pet_fk FOREIGN KEY (pet_id)\n    REFERENCES carneloot.pets(id) ON DELETE CASCADE,\n  CONSTRAINT pet_caregivers_user_fk FOREIGN KEY (caregiver_user_id)\n    REFERENCES carneloot.users(id) ON DELETE RESTRICT,\n  CONSTRAINT pet_caregivers_status_check\n    CHECK (status IN ('pending', 'accepted', 'rejected'))\n);\nCREATE INDEX pet_caregivers_user_status_pet_idx\n  ON carneloot.pet_caregivers (caregiver_user_id, status, pet_id);\n";
export const migration0006Checksum =
	'6f2944eaac7b89b1f356650c37084e1ae455cbe05279ad7e46c1ff2b936ef4b6';
