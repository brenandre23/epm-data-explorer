/** Where the contact, request and suggest-an-edit forms send to. */
export const CONTACT_EMAIL = 'mbaronnet@worldbank.org';

/**
 * Open the visitor's email app with a message addressed to CONTACT_EMAIL.
 *
 * The forms used to post to Formspree and a Google Apps Script. The app is
 * hosted on Design Studio, and visitor data must not go to third-party
 * services, so the message leaves from the visitor's own mailbox instead.
 */
export function openMail(subject, body) {
  window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
