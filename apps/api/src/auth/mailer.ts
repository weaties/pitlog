/**
 * Magic-link delivery.
 *
 * `console` is the only transport implemented in M0 and is what local dev and
 * CI use: the link is printed to the API log and you copy it out. An SMTP
 * transport is an M1 task — it needs a real sending domain, which is bound up
 * with the undecided hosting question (SPEC §6.4).
 */

export interface Mailer {
  sendMagicLink(to: string, url: string): Promise<void>
}

export function createConsoleMailer(): Mailer {
  return {
    async sendMagicLink(to, url) {
      // biome-ignore lint/suspicious/noConsole: this IS the transport
      console.log(`\n  magic link for ${to}:\n  ${url}\n`)
    },
  }
}

export function createMailer(transport: 'console' | 'smtp'): Mailer {
  if (transport === 'smtp') {
    throw new Error('MAIL_TRANSPORT=smtp is not implemented in M0 — see ROADMAP.md (M1)')
  }
  return createConsoleMailer()
}
