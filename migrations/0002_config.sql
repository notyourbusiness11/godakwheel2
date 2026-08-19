CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  title TEXT NOT NULL,
  options TEXT NOT NULL
);

INSERT INTO config (id, title, options)
VALUES (1, 'Live Raffle', '["Prize 1","Prize 2","Prize 3","Prize 4"]');
