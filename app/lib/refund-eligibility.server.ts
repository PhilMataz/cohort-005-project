import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import { coupons, purchases, refunds, RefundStatus } from "~/db/schema";
import { getCourseProgress } from "~/lib/progress.server";

export const REFUND_WINDOW_DAYS = 14;
const MAX_WATCHED_SECONDS = 2 * 60 * 60;
const MAX_COMPLETED_SHARE = 0.5;

type Purchase = typeof purchases.$inferSelect;

/** Why a Purchase cannot get a Refund Request. */
export type RefundIneligibility =
  | "no-purchase"
  | "open-refund-request"
  | "earlier-refund-request"
  | "repeat-purchase"
  | "claimed-seat"
  | "outside-refund-window"
  | "watched-too-much"
  | "completed-too-much";

export type RefundEligibility =
  | {
      eligible: true;
      purchase: Purchase;
      lastDayInWindow: string;
      /** The Refund, in cents: always the amount paid for the Purchase. */
      refundAmount: number;
    }
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

  // A Purchase gets at most one Refund Request, even if it was declined.
  const earlierRequest = getRefundRequest(purchase.id);
  if (earlierRequest) {
    return {
      eligible: false,
      reason:
        earlierRequest.status === RefundStatus.Requested
          ? "open-refund-request"
          : "earlier-refund-request",
    };
  }

  if (wasRefundedBefore(userId, courseId)) {
    return { eligible: false, reason: "repeat-purchase" };
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

  const progress = getCourseProgress(userId, courseId);

  if (progress.secondsWatched >= MAX_WATCHED_SECONDS) {
    return { eligible: false, reason: "watched-too-much" };
  }

  if (
    progress.lessonCount > 0 &&
    progress.lessonsCompleted / progress.lessonCount >= MAX_COMPLETED_SHARE
  ) {
    return { eligible: false, reason: "completed-too-much" };
  }

  return {
    eligible: true,
    purchase,
    lastDayInWindow,
    refundAmount: purchase.amountPaid,
  };
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getRefundRequest(purchaseId: number) {
  return db
    .select({ status: refunds.status })
    .from(refunds)
    .where(eq(refunds.purchaseId, purchaseId))
    .get();
}

// Buying a course again after it was refunded does not open a second chance.
function wasRefundedBefore(userId: number, courseId: number) {
  const refunded = db
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        eq(refunds.status, RefundStatus.Approved)
      )
    )
    .get();
  return refunded !== undefined;
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
