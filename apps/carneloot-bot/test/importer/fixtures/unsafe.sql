.read valid.sql
INSERT INTO users VALUES('unsafe','not-a-number',NULL,'Unsafe',NULL);
INSERT INTO pet_food VALUES('unsafe-food','missing','unsafe',NULL,1e999,1700000000);
