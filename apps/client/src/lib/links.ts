import { inTauri } from '@/lib/api'

/**
 * The places Basalt sends people, in one list.
 *
 * Every address here must also be allowed in the app's capability files
 * (`src-tauri/capabilities`): the opener plugin opens nothing it was not
 * told it may, and a button pointing elsewhere silently does nothing.
 */
export const WEBSITE = 'https://basalt.reforatech.com'
export const REPO = 'https://github.com/refora-technologies/basalt'
/** Where Basalt Host is downloaded: the website's own download route, always the newest. */
export const HOST_DOWNLOAD = `${WEBSITE}/download/host`
export const PLAY_LISTING = 'https://play.google.com/store/apps/details?id=com.reforatech.basalt'
export const FEEDBACK_EMAIL = 'reforatech@gmail.com'

/**
 * Opens a link in the default browser, or the mail app for `mailto:`.
 *
 * Only the addresses listed in the app's capability files may be opened: the
 * opener plugin's `allow-open-url` allows none by itself, which is how these
 * buttons came to do nothing at all. A link added here needs adding there.
 */
export async function openExternal(url: string): Promise<void> {
  if (!inTauri()) {
    window.open(url, '_blank')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}
