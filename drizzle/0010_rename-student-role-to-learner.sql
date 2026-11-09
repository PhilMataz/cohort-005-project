-- The person who buys and takes courses is a Learner (see GLOSSARY.md).
UPDATE `users` SET `role` = 'learner' WHERE `role` = 'student';
