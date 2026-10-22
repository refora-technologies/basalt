/**
 * Puts text on the clipboard. The clipboard API where the page may use it;
 * otherwise the older way, through a hidden field, which Android's WebView
 * still allows when the API is refused. Whether it worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    field.remove()
    return copied
  }
}
