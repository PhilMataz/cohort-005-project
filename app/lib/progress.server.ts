import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  videoWatchEvents,
} from "~/db/schema";

/** A Learner's Progress in one course (see GLOSSARY.md). */
export type CourseProgress = {
  lessonsCompleted: number;
  /** The furthest point reached in each lesson's video, added up. */
  secondsWatched: number;
  /** How many lessons the course has, to read lessonsCompleted against. */
  lessonCount: number;
};

/**
 * Progress belongs to the Learner, not the Enrollment, so this reads the same
 * whether or not they currently have access.
 */
export function getCourseProgress(
  userId: number,
  courseId: number
): CourseProgress {
  const lessonIds = getLessonIdsForCourse(courseId);
  return {
    lessonsCompleted: getCompletedLessonCount(userId, lessonIds),
    secondsWatched: getSecondsWatched(userId, lessonIds),
    lessonCount: lessonIds.length,
  };
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();
  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}
