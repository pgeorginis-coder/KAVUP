-- Προσθήκη ονόματος προσωπικού (μπάρμαν) στις συνεδρίες και στο ιστορικό
-- Κάθε φορά που κάποιος συνδέεται, μπορεί να δηλώσει το όνομά του.
-- Το όνομα αυτό καταγράφεται σε κάθε κίνηση που κάνει, ώστε ο διαχειριστής
-- να βλέπει ποιος έκανε τι.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS staff_name text;
ALTER TABLE history ADD COLUMN IF NOT EXISTS staff_name text;
