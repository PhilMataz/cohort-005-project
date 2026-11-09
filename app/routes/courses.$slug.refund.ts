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
import { parseFormData, parseParams } from "~/lib/validation";
import { getDiscountForCountry } from "~/lib/ppp";
import { formatPrice } from "~/lib/utils";

const INELIGIBLE_RESPONSES: Record<
  RefundIneligibility,
  { message: string; status: number }
> = {
  "no-purchase": { message: "You have not bought this course.", status: 403 },
  "open-refund-request": {
    message: "You already have a request open on this purchase.",
    status: 409,
  },
  "claimed-seat": {
    message: "A claimed team seat cannot be cancelled.",
    status: 403,
  },
  "outside-refund-window": {
    message: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
    status: 403,
  },
  "watched-too-much": {
    message: "You have watched too much of this course to cancel it.",
    status: 403,
  },
  "completed-too-much": {
    message: "You have completed too much of this course to cancel it.",
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
    .min(10, "Tell us a little more about why you want to cancel.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

/**
 * The confirmation the learner gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildReversalEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.learnerEmail,
    subject: `Reversal requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your Reversal request for "${input.courseTitle}".`,
      `The Reversal is for ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Our team reviews every Reversal by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to cancel a purchase.", { status: 401 });
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

  const { purchase } = eligibility;

  // A purchase made at a purchasing-power price is given back at that price,
  // not at the list price of the course.
  const pppDiscount = getDiscountForCountry(purchase.country);
  const refundableAmount = pppDiscount > 0 ? purchase.amountPaid : course.price;

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db
    .insert(refunds)
    .values({
      purchaseId: purchase.id,
      status: RefundStatus.Requested,
      reason: parsed.data.reason,
    })
    .returning()
    .get();

  const email = buildReversalEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: refundableAmount,
  });

  console.log(
    `[email] to=${email.to} subject=${email.subject}\n${email.body}`
  );

  return redirect("/settings");
}
