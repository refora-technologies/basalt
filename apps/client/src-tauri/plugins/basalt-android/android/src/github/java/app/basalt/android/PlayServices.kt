package app.basalt.android

import android.app.Activity
import app.tauri.plugin.JSObject

/**
 * The GitHub build's stand-in for Google Play's services: the same shape,
 * nothing behind it. This build updates itself from GitHub releases, and
 * carries no Google library. The Play build compiles `src/play` instead.
 */
object PlayServices {
  const val AVAILABLE = false

  fun checkUpdate(activity: Activity, done: (JSObject) -> Unit) {
    done(JSObject().put("available", false).put("error", "not installed from Google Play"))
  }

  fun startUpdate(activity: Activity, done: (JSObject) -> Unit) {
    done(JSObject().put("started", false).put("error", "not installed from Google Play"))
  }

  fun updateState(): JSObject = JSObject().put("status", "idle").put("bytes", 0).put("total", 0)

  fun completeUpdate(activity: Activity) {}

  fun requestReview(activity: Activity, done: (Boolean) -> Unit) {
    done(false)
  }
}
