import { android } from './android'
import { FEEDBACK_EMAIL, openExternal } from './links'
import { isAndroid } from './platform'

/**
 * A report of an update refused for its signature, for the person to send
 * from their own email: someone may have put up a release that isn't
 * Refora's, and Refora wants to know. Nothing is sent by the app itself.
 */
export function refusedReport(report: {
  /** Which app refused it, and its version: "Basalt Host 1.6.0". */
  app: string
  /** "Windows", "Linux", "Android". */
  system: string
  /** The version that was offered, when known. */
  offered?: string
  /** What the app said. */
  why: string
}): { to: string; subject: string; body: string; mailto: string } {
  const subject = 'Basalt: an update was refused'
  const body = [
    "An update was refused because it isn't signed by Basalt's publisher.",
    '',
    `App: ${report.app}, on ${report.system}`,
    `Offered: ${report.offered ?? 'unknown'}`,
    `It said: ${report.why}`,
    '',
    '--',
    'Sent from my own email. Nothing else was shared.',
  ].join('\n')
  return {
    to: FEEDBACK_EMAIL,
    subject,
    body,
    mailto: `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  }
}

/** Opens the report in the person's email: the mail app on a phone. */
export async function sendRefusedReport(report: Parameters<typeof refusedReport>[0]): Promise<void> {
  const mail = refusedReport(report)
  if (isAndroid()) {
    const opened = await android.composeEmail(mail.to, mail.subject, mail.body)
    if (opened) return
  }
  await openExternal(mail.mailto)
}
