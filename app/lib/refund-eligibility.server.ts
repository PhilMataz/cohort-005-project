import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refunds,
  RefundStatus,
  videoWatchEvents,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
const MAX_WATCHED_SECONDS = 2 * 60 * 60;
const MAX_COMPLETED_SHARE = 0.5;

type Purchase = typeof purchases.$inferSelect;

/** Why a Purchase cannot get a Refund Request. */
export type RefundIneligibility =
  | "no-purchase"
  | "open-refund-request"
  | "claimed-seat"
  | "outside-refund-window"
  | "watched-too-much"
  | "completed-too-much";

export type RefundEligibility =
  | { eligible: true; purchase: Purchase; lastDayInWindow: string }
  | { eligible: false; reason: RefundIneligibility };

/**
 * Refund Eligibility (see GLOSSARY.md): whether the Learner's latest Purchase
 * of a course can still get a Refund Request. The course page and the server
 * both ask this, so they always agree.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return { eligible: false, reason: "no-purchase" };

  if (hasOpenRefundRequest(purchase.id)) {
    return { eligible: false, reason: "open-refund-request" };
  }

  if (isClaimedSeat(purchase.id)) {
    return { eligible: false, reason: "claimed-seat" };
  }

  const lastDayInWindow = lastDayOfRefundWindow(purchase.createdAt);
  const today = calendarDay(new Date());
  const purchasedDay = calendarDay(new Date(purchase.createdAt));
  if (today < purchasedDay || today > lastDayInWindow) {
    return { eligible: false, reason: "outside-refund-window" };
  }

  const lessonIds = getLessonIdsForCourse(courseId);

  if (getSecondsWatched(userId, lessonIds) >= MAX_WATCHED_SECONDS) {
    return { eligible: false, reason: "watched-too-much" };
  }

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      MAX_COMPLETED_SHARE
  ) {
    return { eligible: false, reason: "completed-too-much" };
  }

  return { eligible: true, purchase, lastDayInWindow };
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasOpenRefundRequest(purchaseId: number) {
  const open = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .get();
  return open !== undefined;
}

// A Seat that came out of a team Purchase, and has been claimed, belongs to
// the team — the Learner cannot hand it back on their own.
function isClaimedSeat(purchaseId: number) {
  const claimed = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
  return claimed !== undefined;
}

// The Refund Window is counted in whole days, not hours — someone who buys at
// 23:00 should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
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
