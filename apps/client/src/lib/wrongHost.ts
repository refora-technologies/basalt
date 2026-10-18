/**
 * What to say when a different Basalt host answers at the address of the one
 * this device paired with: the address was handed to another computer, or the
 * host was reset and has a new identity.
 *
 * Said here once, for the window, the phone and the drive list alike. The
 * client's own message names the hosts by their ids, which tells a person
 * nothing they can act on; this names the host they know.
 *
 * `retrying` says Basalt goes on looking, which the window and the phone do
 * and a single attempt from the drive list does not.
 */
export function wrongHostText(
  hostName: string | null | undefined,
  { retrying = true }: { retrying?: boolean } = {},
): string {
  const name = hostName?.trim() || 'your host'
  return (
    `This isn’t ${name}. Another Basalt host is answering at its address` +
    (retrying ? `, so Basalt keeps looking for ${name}. ` : '. ') +
    `If you reset ${name}, pair it again.`
  )
}
