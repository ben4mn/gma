-- F7: a short name keeps a leading family or title word. Following the join
-- form's own example, "Uncle Mike" became "Uncle" on Grandma's frame ("3 photos
-- from Uncle"). The default is now the first word, unless the name starts with
-- a family or title word (Aunt, Uncle, Cousin, Grandpa, Nana, Great, Tía, Mr …):
-- then it is that word and the next ("Uncle Mike", "Aunt Carol"), or, when the
-- first two are both family words, the first three ("Great Aunt Mary"). A
-- default over 30 characters drops leading family words, never the given name.
--
-- The same rule, word for word, is lib/people.js defaultShortName() and
-- web/shared/names.js shortNameFor() (the join form's prefill); words are
-- compared in ASCII lower case, as SQLite's lower() does. test/short-names.test.js
-- checks that all three agree, so change them together.
--
-- Short names nobody edited (still the old first-word default, or empty) are
-- recomputed; a short name Ben (or the person, on joining) chose is kept.

DROP TRIGGER IF EXISTS users_short_name_default;
DROP TRIGGER IF EXISTS users_short_name_follows_name;

UPDATE users
   SET short_name = (SELECT CASE
          WHEN w3 <> '' AND lower(w1) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.') AND lower(w2) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.')
            THEN CASE WHEN length(w1 || ' ' || w2 || ' ' || w3) <= 30 THEN w1 || ' ' || w2 || ' ' || w3
                      WHEN length(w2 || ' ' || w3) <= 30 THEN w2 || ' ' || w3
                      ELSE substr(w3, 1, 30) END
          WHEN w2 <> '' AND lower(w1) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.')
            THEN CASE WHEN length(w1 || ' ' || w2) <= 30 THEN w1 || ' ' || w2 ELSE substr(w2, 1, 30) END
          ELSE substr(w1, 1, 30) END
        FROM (SELECT w1, w2, CASE WHEN instr(r2, ' ') > 0 THEN substr(r2, 1, instr(r2, ' ') - 1) ELSE r2 END AS w3
                FROM (SELECT w1, CASE WHEN instr(r1, ' ') > 0 THEN substr(r1, 1, instr(r1, ' ') - 1) ELSE r1 END AS w2,
                             CASE WHEN instr(r1, ' ') > 0 THEN ltrim(substr(r1, instr(r1, ' ') + 1)) ELSE '' END AS r2
                        FROM (SELECT CASE WHEN sp > 0 THEN substr(t, 1, sp - 1) ELSE t END AS w1,
                                     CASE WHEN sp > 0 THEN ltrim(substr(t, sp + 1)) ELSE '' END AS r1
                                FROM (SELECT t, instr(t, ' ') AS sp FROM (SELECT trim(name) AS t))))))
 WHERE short_name IS NULL OR trim(short_name) = '' OR short_name = (CASE WHEN instr(trim(name), ' ') > 0 THEN substr(trim(name), 1, instr(trim(name), ' ') - 1) ELSE trim(name) END);

CREATE TRIGGER users_short_name_default
AFTER INSERT ON users
WHEN NEW.short_name IS NULL OR trim(NEW.short_name) = ''
BEGIN
  UPDATE users
     SET short_name = (SELECT CASE
          WHEN w3 <> '' AND lower(w1) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.') AND lower(w2) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.')
            THEN CASE WHEN length(w1 || ' ' || w2 || ' ' || w3) <= 30 THEN w1 || ' ' || w2 || ' ' || w3
                      WHEN length(w2 || ' ' || w3) <= 30 THEN w2 || ' ' || w3
                      ELSE substr(w3, 1, 30) END
          WHEN w2 <> '' AND lower(w1) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.')
            THEN CASE WHEN length(w1 || ' ' || w2) <= 30 THEN w1 || ' ' || w2 ELSE substr(w2, 1, 30) END
          ELSE substr(w1, 1, 30) END
        FROM (SELECT w1, w2, CASE WHEN instr(r2, ' ') > 0 THEN substr(r2, 1, instr(r2, ' ') - 1) ELSE r2 END AS w3
                FROM (SELECT w1, CASE WHEN instr(r1, ' ') > 0 THEN substr(r1, 1, instr(r1, ' ') - 1) ELSE r1 END AS w2,
                             CASE WHEN instr(r1, ' ') > 0 THEN ltrim(substr(r1, instr(r1, ' ') + 1)) ELSE '' END AS r2
                        FROM (SELECT CASE WHEN sp > 0 THEN substr(t, 1, sp - 1) ELSE t END AS w1,
                                     CASE WHEN sp > 0 THEN ltrim(substr(t, sp + 1)) ELSE '' END AS r1
                                FROM (SELECT t, instr(t, ' ') AS sp FROM (SELECT trim(NEW.name) AS t))))))
   WHERE id = NEW.id;
END;

-- A renamed person whose short name was still a default (the new rule's, or the
-- old first-word one) gets the new default. A short name someone chose is kept.
CREATE TRIGGER users_short_name_follows_name
AFTER UPDATE OF name ON users
WHEN NEW.short_name IS OLD.short_name
 AND (OLD.short_name IS NULL
      OR OLD.short_name = (SELECT CASE
          WHEN w3 <> '' AND lower(w1) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.') AND lower(w2) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.')
            THEN CASE WHEN length(w1 || ' ' || w2 || ' ' || w3) <= 30 THEN w1 || ' ' || w2 || ' ' || w3
                      WHEN length(w2 || ' ' || w3) <= 30 THEN w2 || ' ' || w3
                      ELSE substr(w3, 1, 30) END
          WHEN w2 <> '' AND lower(w1) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.')
            THEN CASE WHEN length(w1 || ' ' || w2) <= 30 THEN w1 || ' ' || w2 ELSE substr(w2, 1, 30) END
          ELSE substr(w1, 1, 30) END
        FROM (SELECT w1, w2, CASE WHEN instr(r2, ' ') > 0 THEN substr(r2, 1, instr(r2, ' ') - 1) ELSE r2 END AS w3
                FROM (SELECT w1, CASE WHEN instr(r1, ' ') > 0 THEN substr(r1, 1, instr(r1, ' ') - 1) ELSE r1 END AS w2,
                             CASE WHEN instr(r1, ' ') > 0 THEN ltrim(substr(r1, instr(r1, ' ') + 1)) ELSE '' END AS r2
                        FROM (SELECT CASE WHEN sp > 0 THEN substr(t, 1, sp - 1) ELSE t END AS w1,
                                     CASE WHEN sp > 0 THEN ltrim(substr(t, sp + 1)) ELSE '' END AS r1
                                FROM (SELECT t, instr(t, ' ') AS sp FROM (SELECT trim(OLD.name) AS t))))))
      OR OLD.short_name = (CASE WHEN instr(trim(OLD.name), ' ') > 0 THEN substr(trim(OLD.name), 1, instr(trim(OLD.name), ' ') - 1) ELSE trim(OLD.name) END))
BEGIN
  UPDATE users
     SET short_name = (SELECT CASE
          WHEN w3 <> '' AND lower(w1) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.') AND lower(w2) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.')
            THEN CASE WHEN length(w1 || ' ' || w2 || ' ' || w3) <= 30 THEN w1 || ' ' || w2 || ' ' || w3
                      WHEN length(w2 || ' ' || w3) <= 30 THEN w2 || ' ' || w3
                      ELSE substr(w3, 1, 30) END
          WHEN w2 <> '' AND lower(w1) IN ('aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad', 'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather', 'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío', 'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.')
            THEN CASE WHEN length(w1 || ' ' || w2) <= 30 THEN w1 || ' ' || w2 ELSE substr(w2, 1, 30) END
          ELSE substr(w1, 1, 30) END
        FROM (SELECT w1, w2, CASE WHEN instr(r2, ' ') > 0 THEN substr(r2, 1, instr(r2, ' ') - 1) ELSE r2 END AS w3
                FROM (SELECT w1, CASE WHEN instr(r1, ' ') > 0 THEN substr(r1, 1, instr(r1, ' ') - 1) ELSE r1 END AS w2,
                             CASE WHEN instr(r1, ' ') > 0 THEN ltrim(substr(r1, instr(r1, ' ') + 1)) ELSE '' END AS r2
                        FROM (SELECT CASE WHEN sp > 0 THEN substr(t, 1, sp - 1) ELSE t END AS w1,
                                     CASE WHEN sp > 0 THEN ltrim(substr(t, sp + 1)) ELSE '' END AS r1
                                FROM (SELECT t, instr(t, ' ') AS sp FROM (SELECT trim(NEW.name) AS t))))))
   WHERE id = NEW.id;
END;
