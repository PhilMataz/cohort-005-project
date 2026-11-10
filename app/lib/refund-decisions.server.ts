import { and, asc, eq } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  purchases,
  refunds,
  RefundStatus,
  users,
} from "~/db/schema";
import { sendEmail, type Email } from "~/lib/email.server";
import { isActiveEnrollment } from "~/lib/enrollments.server";
import { getCourseProgress } from "~/lib/progress.server";
import { formatPrice } from "~/lib/utils";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Refund Requests still waiting on an Admin, oldest first, with the Learner's
 * Progress both when they asked and now.
 */
export function listOpenRefundRequests(now: Date = new Date()) {
  return db
    .select({
      id: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      lessonsCompletedAtRequest: refunds.lessonsCompletedAtRequest,
      secondsWatchedAtRequest: refunds.secondsWatchedAtRequest,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all()
    .map(
      ({ lessonsCompletedAtRequest, secondsWatchedAtRequest, ...request }) => {
        const { lessonCount, ...progressNow } = getCourseProgress(
          request.learnerId,
          request.courseId
        );
        return {
          ...request,
          hoursWaiting: Math.floor(
            (now.getTime() - Date.parse(request.requestedAt)) / HOUR_MS
          ),
          lessonCount,
          // Requests made before the snapshot was recorded have none.
          progressWhenRequested:
            lessonsCompletedAtRequest === null ||
            secondsWatchedAtRequest === null
              ? null
              : {
                  lessonsCompleted: lessonsCompletedAtRequest,
                  secondsWatched: secondsWatchedAtRequest,
                },
          progressNow,
        };
      }
    );
}

export type OpenRefundRequest = ReturnType<
  typeof listOpenRefundRequests
>[number];

export type RefundDecision =
  | { outcome: "approve"; reason: string | null }
  | { outcome: "decline"; reason: string };

/** Why a Refund Request could not be decided. */
export type NotDecided = {
  decided: false;
  why: "not-found" | "already-decided";
};

export type RefundDecisionResult = { decided: true } | NotDecided;

/**
 * An Admin decides a Refund Request. Approving records a Refund of the amount
 * paid and ends the Learner's Enrollment, keeping it and their Progress
 * (ADR 0001). Declining refunds nothing and leaves the Enrollment alone.
 * Either way the Learner is emailed the outcome.
 *
 * Refund Eligibility is not checked again: Progress made while the request
 * waited does not count against it.
 */
export function decideRefundRequest(
  refundRequestId: number,
  adminId: number,
  decision: RefundDecision,
  now: Date = new Date()
): RefundDecisionResult {
  const result = db.transaction(
    (tx): NotDecided | Email => {
      const request = tx
        .select({
          amountPaid: purchases.amountPaid,
          learnerId: users.id,
          learnerName: users.name,
          learnerEmail: users.email,
          courseId: courses.id,
          courseTitle: courses.title,
        })
        .from(refunds)
        .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
        .innerJoin(users, eq(purchases.userId, users.id))
        .innerJoin(courses, eq(purchases.courseId, courses.id))
        .where(eq(refunds.id, refundRequestId))
        .get();

      if (!request) return { decided: false, why: "not-found" };

      const decidedAt = now.toISOString();
      const approved = decision.outcome === "approve";

      // Only a request still Requested can be decided: a decision is final.
      const updated = tx
        .update(refunds)
        .set({
          status: approved ? RefundStatus.Approved : RefundStatus.Declined,
          amountRefunded: approved ? request.amountPaid : null,
          decisionReason: decision.reason,
          resolvedAt: decidedAt,
          resolvedByUserId: adminId,
        })
        .where(
          and(
            eq(refunds.id, refundRequestId),
            eq(refunds.status, RefundStatus.Requested)
          )
        )
        .run();

      if (updated.changes === 0) {
        return { decided: false, why: "already-decided" };
      }

      if (decision.outcome === "decline") {
        return buildDeclinedEmail({ ...request, reason: decision.reason });
      }

      tx.update(enrollments)
        .set({ endedAt: decidedAt })
        .where(
          and(
            eq(enrollments.userId, request.learnerId),
            eq(enrollments.courseId, request.courseId),
            isActiveEnrollment
          )
        )
        .run();

      return buildApprovedEmail(request);
    }
  );

  if ("decided" in result) return result;

  sendEmail(result);
  return { decided: true };
}

type DecisionEmailInput = {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
};

function buildApprovedEmail(
  input: DecisionEmailInput & { amountPaid: number }
): Email {
  return {
    to: input.learnerEmail,
    subject: `Your refund is approved: ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have refunded ${formatPrice(input.amountPaid)}, the amount you paid for "${input.courseTitle}".`,
      "",
      "You no longer have access to the course, but your progress is kept: if you buy it again, you will pick up where you left off.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function buildDeclinedEmail(
  input: DecisionEmailInput & { reason: string }
): Email {
  return {
    to: input.learnerEmail,
    subject: `Your refund request was declined: ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have declined your refund request for "${input.courseTitle}". Here is why:`,
      "",
      input.reason,
      "",
      "You keep your access to the course, and your progress, as before.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
