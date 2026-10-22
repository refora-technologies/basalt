import { describe, expect, it } from 'vitest'
import { refusedReport } from './refusedReport'

describe('refusedReport', () => {
  const mail = refusedReport({
    app: 'Basalt Host 1.6.0',
    system: 'Windows',
    offered: '1.6.1',
    why: "This download isn't signed by Basalt's publisher",
  })

  it('goes to Refora, and says what was refused', () => {
    expect(mail.to).toBe('reforatech@gmail.com')
    expect(mail.body).toContain('App: Basalt Host 1.6.0, on Windows')
    expect(mail.body).toContain('Offered: 1.6.1')
    expect(mail.body).toContain("It said: This download isn't signed")
  })

  it('is a mailto link to that address, as the app may open', () => {
    expect(mail.mailto.startsWith('mailto:reforatech@gmail.com?subject=')).toBe(true)
    expect(decodeURIComponent(mail.mailto.split('&body=')[1] ?? '')).toBe(mail.body)
  })

  it('says the version was unknown when it was', () => {
    expect(refusedReport({ app: 'Basalt', system: 'Android', why: 'x' }).body).toContain('Offered: unknown')
  })
})
