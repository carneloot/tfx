CREATE TABLE carnebot.pet_caregivers (
  pet_id uuid NOT NULL,
  caregiver_user_id uuid NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pet_caregivers_pk PRIMARY KEY (pet_id, caregiver_user_id),
  CONSTRAINT pet_caregivers_pet_fk FOREIGN KEY (pet_id)
    REFERENCES carnebot.pets(id) ON DELETE CASCADE,
  CONSTRAINT pet_caregivers_user_fk FOREIGN KEY (caregiver_user_id)
    REFERENCES carnebot.users(id) ON DELETE RESTRICT,
  CONSTRAINT pet_caregivers_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected'))
);
CREATE INDEX pet_caregivers_user_status_pet_idx
  ON carnebot.pet_caregivers (caregiver_user_id, status, pet_id);
