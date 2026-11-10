import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, refunds, users, RefundStatus } from "~/db/schema";
import { eq } from "drizzle-orm";
import {
  getRefundEligibility,
  REFUND_WINDOW_DAYS,
  type RefundIneligibility,
} from "~/lib/refund-eligibility.server";
import { sendEmail } from "~/lib/email.server";
import { getCourseProgress } from "~/lib/progress.server";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";

const INELIGIBLE_RESPONSES: Record<
  RefundIneligibility,
  { message: string; status: number }
> = {
  "no-purchase": { message: "You have not bought this course.", status: 403 },
  "open-refund-request": {
    message: "You already have a refund request open on this purchase.",
    status: 409,
  },
  "earlier-refund-request": {
    message: "This purchase has already had a refund request.",
    status: 409,
  },
  "repeat-purchase": {
    message: "A course bought again after a refund cannot be refunded.",
    status: 403,
  },
  "claimed-seat": {
    message: "A claimed team seat cannot be refunded.",
    status: 403,
  },
  "outside-refund-window": {
    message: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
    status: 403,
  },
  "watched-too-much": {
    message: "You have watched too much of this course to get a refund.",
    status: 403,
  },
  "completed-too-much": {
    message: "You have completed too much of this course to get a refund.",
    status: 403,
  },
};

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

/** The confirmation the learner gets in their inbox. */
function buildRefundRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.learnerEmail,
    subject: `We got your refund request: ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We got your refund request for "${input.courseTitle}".`,
      `If we approve it, your refund will be ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to ask for a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const eligibility = getRefundEligibility(currentUserId, course.id);

  if (!eligibility.eligible) {
    const { message, status } = INELIGIBLE_RESPONSES[eligibility.reason];
    throw data(message, { status });
  }

  const { purchase, refundAmount } = eligibility;

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  // The Admin weighs the request against what the Learner had done when they
  // asked, as well as what they have done since.
  const progress = getCourseProgress(currentUserId, course.id);

  db.insert(refunds)
    .values({
      purchaseId: purchase.id,
      status: RefundStatus.Requested,
      reason: parsed.data.reason,
      lessonsCompletedAtRequest: progress.lessonsCompleted,
      secondsWatchedAtRequest: progress.secondsWatched,
    })
    .run();

  const email = buildRefundRequestEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: refundAmount,
  });

  sendEmail(email);

  return redirect("/settings");
}
