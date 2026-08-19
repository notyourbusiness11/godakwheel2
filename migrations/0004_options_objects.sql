-- Options used to be a plain array of strings; they're now an array of
-- {value, customUrl?, customLabel?, customUrl2?, customLabel2?} objects.
-- Only rewrites the row if it's still in the old (string) shape.
UPDATE config
SET options = (
  SELECT json_group_array(json_object('value', je.value))
  FROM json_each(config.options) je
)
WHERE id = 1
  AND (SELECT je.type FROM json_each(config.options) je LIMIT 1) = 'text';
