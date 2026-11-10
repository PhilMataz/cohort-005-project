export type Email = { to: string; subject: string; body: string };

/**
 * There is no mail transport wired up yet, so every email goes to the server
 * log instead.
 */
export function sendEmail(email: Email) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
