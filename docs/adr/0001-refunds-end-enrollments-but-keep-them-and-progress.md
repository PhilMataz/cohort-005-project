# A Refund ends the Enrollment but keeps it, and keeps the Learner's Progress

When an Admin approves a Refund Request, the Enrollment is marked ended rather than deleted, and the Learner's Progress (lessons completed, time watched, quiz attempts) stays exactly as it was. An ended Enrollment gives no access, so the Progress is out of reach until the Learner buys the course again, at which point it comes back on its own.

We chose this over wiping the Enrollment and Progress because deleting cannot be undone, and the Progress is the evidence behind the Admin's decision. It also lets a Learner who buys again pick up where they left off. A repeat Purchase can never be refunded (see `GLOSSARY.md`, Refund Eligibility), so the kept Progress cannot be used to game the rules.

## Consequences

- Every access check must treat an ended Enrollment as no access. Checking only whether an Enrollment exists is no longer enough.
- Progress records for Learners with no access are expected, not orphaned. Do not "clean them up".
- Instructor student lists and course ratings count only active Enrollments. Comments from refunded Learners stay visible.
