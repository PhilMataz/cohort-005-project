import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

// The route talks to the real schema, in a fresh in-memory database per test.
const testDb = vi.hoisted(() => ({
  current: undefined as unknown as ReturnType<typeof drizzle<typeof schema>>,
}));

vi.mock("~/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const value = Reflect.get(testDb.current, prop);
        return typeof value === "function" ? value.bind(testDb.current) : value;
      },
    }
  ),
}));

import { action } from "./courses.$slug.refund";
import { setCurrentUserId } from "~/lib/session";
import { getRefundEligibility } from "~/lib/refund-eligibility.server";

const {
  users,
  categories,
  courses,
  modules,
  lessons,
  purchases,
  refunds,
  teams,
  coupons,
  lessonProgress,
  videoWatchEvents,
  UserRole,
  CourseStatus,
  LessonProgressStatus,
  RefundStatus,
} = schema;

const SLUG = "intro-to-typescript";
const NOW = new Date(2026, 10, 9, 12, 0, 0);

function daysAgo(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

function seedCourse({ lessonCount }: { lessonCount: number }) {
  const db = testDb.current;
  const instructor = db
    .insert(users)
    .values({
      name: "Ina Instructor",
      email: "ina@example.com",
      role: UserRole.Instructor,
    })
    .returning()
    .get();
  const learner = db
    .insert(users)
    .values({
      name: "Liam Learner",
      email: "liam@example.com",
      role: UserRole.Learner,
    })
    .returning()
    .get();
  const category = db
    .insert(categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  const course = db
    .insert(courses)
    .values({
      title: "Introduction to TypeScript",
      slug: SLUG,
      description: "Types for JavaScript",
      salesCopy: "Learn TypeScript.",
      instructorId: instructor.id,
      categoryId: category.id,
      status: CourseStatus.Published,
      price: 7900,
    })
    .returning()
    .get();
  const mod = db
    .insert(modules)
    .values({ courseId: course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  const lessonIds = Array.from(
    { length: lessonCount },
    (_, i) =>
      db
        .insert(lessons)
        .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
        .returning()
        .get().id
  );

  return { learner, course, lessonIds };
}

function buyCourse(
  learnerId: number,
  courseId: number,
  { purchasedDaysAgo = 0, amountPaid = 7900, country = "US" } = {}
) {
  return testDb.current
    .insert(purchases)
    .values({
      userId: learnerId,
      courseId,
      amountPaid,
      country,
      createdAt: daysAgo(purchasedDaysAgo),
    })
    .returning()
    .get();
}

function changeCoursePrice(courseId: number, price: number) {
  testDb.current
    .update(courses)
    .set({ price })
    .where(eq(courses.id, courseId))
    .run();
}

/** The confirmation email, which goes to the server log. */
function confirmationEmail() {
  const logged = vi
    .mocked(console.log)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith("[email]"));
  expect(logged).toHaveLength(1);
  return logged[0];
}

function completeLessons(learnerId: number, lessonIds: number[]) {
  for (const lessonId of lessonIds) {
    testDb.current
      .insert(lessonProgress)
      .values({
        userId: learnerId,
        lessonId,
        status: LessonProgressStatus.Completed,
      })
      .run();
  }
}

function watch(learnerId: number, lessonId: number, seconds: number) {
  testDb.current
    .insert(videoWatchEvents)
    .values({
      userId: learnerId,
      lessonId,
      eventType: "progress",
      positionSeconds: seconds,
    })
    .run();
}

function claimSeat(purchaseId: number, courseId: number, learnerId: number) {
  const team = testDb.current.insert(teams).values({}).returning().get();
  testDb.current
    .insert(coupons)
    .values({
      teamId: team.id,
      courseId,
      code: "SEAT-1",
      purchaseId,
      redeemedByUserId: learnerId,
      redeemedAt: NOW.toISOString(),
    })
    .run();
}

function openRefundRequest(purchaseId: number) {
  testDb.current
    .insert(refunds)
    .values({
      purchaseId,
      status: RefundStatus.Requested,
      reason: "Not what I expected at all.",
    })
    .run();
}

/** Sends a Refund Request straight to the server, as the given Learner. */
async function requestRefund(learnerId: number) {
  const setCookie = await setCurrentUserId(
    new Request("http://localhost/"),
    learnerId
  );
  const request = new Request(`http://localhost/courses/${SLUG}/refund`, {
    method: "POST",
    headers: {
      Cookie: setCookie.split(";")[0],
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      reason: "This course is not right for me after all.",
    }),
  });

  try {
    const result = await action({
      request,
      params: { slug: SLUG },
      context: {},
    } as Parameters<typeof action>[0]);
    if (result instanceof Response) return { status: result.status };
    return { status: result.init?.status, message: result.data };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status };
    const rejection = thrown as { data: unknown; init: ResponseInit | null };
    return { status: rejection.init?.status, message: rejection.data };
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});

  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb.current = drizzle(sqlite, { schema });
  migrate(testDb.current, { migrationsFolder: "drizzle" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Refund Request, sent to the server", () => {

  it("is accepted for an eligible Purchase", async () => {
    const { learner, course } = seedCourse({ lessonCount: 4 });
    buyCourse(learner.id, course.id);

    const response = await requestRefund(learner.id);

    expect(response.status).toBe(302);
  });

  it("is rejected once the Learner has completed half the lessons", async () => {
    const { learner, course, lessonIds } = seedCourse({ lessonCount: 4 });
    buyCourse(learner.id, course.id);
    completeLessons(learner.id, lessonIds.slice(0, 2));

    const response = await requestRefund(learner.id);

    expect(response).toEqual({
      status: 403,
      message: "You have completed too much of this course to get a refund.",
    });
  });

  it("is accepted while the Learner has completed under half the lessons", async () => {
    const { learner, course, lessonIds } = seedCourse({ lessonCount: 5 });
    buyCourse(learner.id, course.id);
    completeLessons(learner.id, lessonIds.slice(0, 2));

    const response = await requestRefund(learner.id);

    expect(response.status).toBe(302);
  });

  it("is accepted on the last day of the Refund Window", async () => {
    const { learner, course } = seedCourse({ lessonCount: 4 });
    buyCourse(learner.id, course.id, { purchasedDaysAgo: 14 });

    const response = await requestRefund(learner.id);

    expect(response.status).toBe(302);
  });

  it("is rejected once the Refund Window has closed", async () => {
    const { learner, course } = seedCourse({ lessonCount: 4 });
    buyCourse(learner.id, course.id, { purchasedDaysAgo: 15 });

    const response = await requestRefund(learner.id);

    expect(response).toEqual({
      status: 403,
      message: "The 14-day window has closed.",
    });
  });

  it("is accepted while the Learner has watched under 2 hours", async () => {
    const { learner, course, lessonIds } = seedCourse({ lessonCount: 4 });
    buyCourse(learner.id, course.id);
    watch(learner.id, lessonIds[0], 60 * 60);
    watch(learner.id, lessonIds[1], 60 * 60 - 1);

    const response = await requestRefund(learner.id);

    expect(response.status).toBe(302);
  });

  it("is rejected once the Learner has watched 2 hours", async () => {
    const { learner, course, lessonIds } = seedCourse({ lessonCount: 4 });
    buyCourse(learner.id, course.id);
    watch(learner.id, lessonIds[0], 60 * 60);
    watch(learner.id, lessonIds[1], 60 * 60);

    const response = await requestRefund(learner.id);

    expect(response).toEqual({
      status: 403,
      message: "You have watched too much of this course to get a refund.",
    });
  });

  it("is rejected for a claimed Seat", async () => {
    const { learner, course } = seedCourse({ lessonCount: 4 });
    const purchase = buyCourse(learner.id, course.id);
    claimSeat(purchase.id, course.id, learner.id);

    const response = await requestRefund(learner.id);

    expect(response).toEqual({
      status: 403,
      message: "A claimed team seat cannot be refunded.",
    });
  });

  it("is rejected while a Refund Request is already open", async () => {
    const { learner, course } = seedCourse({ lessonCount: 4 });
    const purchase = buyCourse(learner.id, course.id);
    openRefundRequest(purchase.id);

    const response = await requestRefund(learner.id);

    expect(response).toEqual({
      status: 409,
      message: "You already have a refund request open on this purchase.",
    });
  });

  it("is rejected when the Learner has no Purchase", async () => {
    const { learner } = seedCourse({ lessonCount: 4 });

    const response = await requestRefund(learner.id);

    expect(response).toEqual({
      status: 403,
      message: "You have not bought this course.",
    });
  });

  describe("confirmation email", () => {
    it("names the Refund Request in the subject", async () => {
      const { learner, course } = seedCourse({ lessonCount: 4 });
      buyCourse(learner.id, course.id);

      await requestRefund(learner.id);

      expect(confirmationEmail()).toContain(
        "subject=We got your refund request: Introduction to TypeScript"
      );
    });

    it("talks about a refund request in the body", async () => {
      const { learner, course } = seedCourse({ lessonCount: 4 });
      buyCourse(learner.id, course.id);

      await requestRefund(learner.id);

      const email = confirmationEmail();
      expect(email).toContain(
        'We got your refund request for "Introduction to TypeScript".'
      );
      expect(email).toContain("Our team reviews every refund request by hand.");
      expect(email).not.toMatch(/reversal|chargeback|cancel/i);
    });
  });

  describe("after the course price changed", () => {
    it("refunds the amount paid when the price went up", async () => {
      const { learner, course } = seedCourse({ lessonCount: 4 });
      buyCourse(learner.id, course.id, { amountPaid: 7900, country: "US" });
      changeCoursePrice(course.id, 9900);

      const response = await requestRefund(learner.id);

      expect(response.status).toBe(302);
      expect(confirmationEmail()).toContain(
        "your refund will be $79.00, the amount you paid."
      );
    });

    it("refunds the amount paid when the price went down", async () => {
      const { learner, course } = seedCourse({ lessonCount: 4 });
      buyCourse(learner.id, course.id, { amountPaid: 7900, country: "US" });
      changeCoursePrice(course.id, 4900);

      const response = await requestRefund(learner.id);

      expect(response.status).toBe(302);
      expect(confirmationEmail()).toContain(
        "your refund will be $79.00, the amount you paid."
      );
    });

    it("refunds the amount paid at a regional discount", async () => {
      const { learner, course } = seedCourse({ lessonCount: 4 });
      // India gets 50% off: $79.00 → $39.50.
      buyCourse(learner.id, course.id, { amountPaid: 3950, country: "IN" });
      changeCoursePrice(course.id, 9900);

      const response = await requestRefund(learner.id);

      expect(response.status).toBe(302);
      expect(confirmationEmail()).toContain(
        "your refund will be $39.50, the amount you paid."
      );
    });
  });
});

describe("Refund Eligibility, as shown on the course page", () => {
  it("offers the amount paid after the price changed", () => {
    const { learner, course } = seedCourse({ lessonCount: 4 });
    buyCourse(learner.id, course.id, { amountPaid: 7900, country: "US" });
    changeCoursePrice(course.id, 9900);

    const eligibility = getRefundEligibility(learner.id, course.id);

    expect(eligibility).toMatchObject({ eligible: true, refundAmount: 7900 });
  });

  it("offers the amount paid at a regional discount after the price changed", () => {
    const { learner, course } = seedCourse({ lessonCount: 4 });
    buyCourse(learner.id, course.id, { amountPaid: 3950, country: "IN" });
    changeCoursePrice(course.id, 9900);

    const eligibility = getRefundEligibility(learner.id, course.id);

    expect(eligibility).toMatchObject({ eligible: true, refundAmount: 3950 });
  });
});
