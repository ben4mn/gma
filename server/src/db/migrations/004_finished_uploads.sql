-- Uploads that finished, for a day (OPS-6). When the last tus response is lost
-- (the phone suspended the app, or the connection dropped after the server
-- made the item), tus-js-client asks where the upload stands. The scratch file
-- is gone by then, so without this it got a 404 and sent the whole file again,
-- making a duplicate. Now it is told the upload is complete, and which item it
-- made. Rows older than a day are swept hourly; deleting the item removes its row.

CREATE TABLE finished_uploads (
  upload_id   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX finished_uploads_created ON finished_uploads (created_at);
