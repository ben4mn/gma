-- The person an invite created when it was first accepted. Opening the link
-- again may fix that person's name or mistyped email, and nobody else's: an
-- invite never edits, renames or takes over someone another invite made, or
-- anyone who already has an account (SEC-1).

ALTER TABLE invites ADD COLUMN created_user_id TEXT REFERENCES users (id);

-- Invites accepted before this column existed: the person the invite inserted
-- was created in the same transaction that first marked it used.
UPDATE invites
   SET created_user_id = used_by
 WHERE used_by IS NOT NULL
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = invites.used_by AND u.created_at = invites.used_at);
