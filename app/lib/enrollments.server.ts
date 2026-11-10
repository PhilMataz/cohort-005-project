import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import { courseRatings, enrollments } from "~/db/schema";

/**
 * Only an active Enrollment gives access. A Refund ends an Enrollment rather
 * than deleting it (ADR 0001), so checking that a row exists is not enough.
 */
export const isActiveEnrollment = isNull(enrollments.endedAt);

/**
 * A course rating counts towards the average only while its author still has
 * an active Enrollment: a refunded Learner's rating stops counting (ADR 0001).
 */
export const ratingCounts = sql`exists (
  select 1 from ${enrollments}
  where ${enrollments.userId} = ${courseRatings.userId}
    and ${enrollments.courseId} = ${courseRatings.courseId}
    and ${enrollments.endedAt} is null
)`;

export function findActiveEnrollment(userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        isActiveEnrollment
      )
    )
    .get();
}

export function isUserEnrolled(userId: number, courseId: number) {
  return findActiveEnrollment(userId, courseId) !== undefined;
}
