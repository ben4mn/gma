-- What Grandma calls each person ("Mike", "Grandpa Joe"). The frame shows this
-- instead of the full name. It defaults to the first word of the name; Ben can
-- change it in /admin (PATCH /api/admin/people/:id).

ALTER TABLE users ADD COLUMN short_name TEXT;

UPDATE users
   SET short_name = CASE
     WHEN instr(trim(name), ' ') > 0 THEN substr(trim(name), 1, instr(trim(name), ' ') - 1)
     ELSE trim(name)
   END;

-- New people get the default without every INSERT having to know about it.
CREATE TRIGGER users_short_name_default
AFTER INSERT ON users
WHEN NEW.short_name IS NULL OR trim(NEW.short_name) = ''
BEGIN
  UPDATE users
     SET short_name = CASE
       WHEN instr(trim(NEW.name), ' ') > 0 THEN substr(trim(NEW.name), 1, instr(trim(NEW.name), ' ') - 1)
       ELSE trim(NEW.name)
     END
   WHERE id = NEW.id;
END;

-- A renamed person whose short name was still the default (the first word of
-- the old name) gets the new default. A short name Ben chose is kept.
CREATE TRIGGER users_short_name_follows_name
AFTER UPDATE OF name ON users
WHEN NEW.short_name IS OLD.short_name
 AND (OLD.short_name IS NULL OR OLD.short_name = CASE
       WHEN instr(trim(OLD.name), ' ') > 0 THEN substr(trim(OLD.name), 1, instr(trim(OLD.name), ' ') - 1)
       ELSE trim(OLD.name)
     END)
BEGIN
  UPDATE users
     SET short_name = CASE
       WHEN instr(trim(NEW.name), ' ') > 0 THEN substr(trim(NEW.name), 1, instr(trim(NEW.name), ' ') - 1)
       ELSE trim(NEW.name)
     END
   WHERE id = NEW.id;
END;
