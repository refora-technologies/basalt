package app.basalt.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.FileObserver
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import java.io.File

/**
 * Notifications for shares: an offer with Accept and Decline, a file passed
 * on to take here, one that arrived.
 *
 * Rust can't ask the plugin for one with Basalt swiped away (there is no
 * window, and the call fails), and that is when they matter most. So Rust
 * writes each to a small file instead, and this, run by the service that
 * keeps Basalt up, watches the file and shows each new one while Basalt
 * isn't on screen. The page's own (`notifyShare`) go through [post] too.
 */
object ShareNotices {
  const val ACTION_EXTRA = "basalt.action"
  private const val CHANNEL = "basalt-shares"
  private const val FIRST_ID = 0x10000
  private const val PREFS = "basalt-notices"
  private const val KEY_PATH = "path"
  private const val KEY_SEEN = "seen"

  @Volatile
  private var observer: FileObserver? = null

  /** Shows one, replacing any with the same tag; false when Android won't. */
  fun post(context: Context, tag: String, title: String, text: String, actions: List<String>): Boolean {
    val allowed = Build.VERSION.SDK_INT < 33 ||
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    if (!allowed) return false
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Shared files", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Files your other devices and your home send you."
        }
      )
    }
    val id = FIRST_ID + (tag.hashCode() and 0xffff)
    fun opening(action: String, code: Int): PendingIntent? {
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        putExtra(ACTION_EXTRA, action)
        addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      } ?: return null
      return PendingIntent.getActivity(context, code, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_basalt)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setContentIntent(opening("share:$tag", id))
    actions.forEachIndexed { n, button ->
      val label = button.substringBefore('|')
      val action = button.substringAfter('|', "")
      if (label.isNotEmpty() && action.isNotEmpty()) {
        builder.addAction(0, label, opening("share-$action:$tag", id * 8 + n + 1))
      }
    }
    manager.notify(id, builder.build())
    return true
  }

  /** Where Rust writes them, told as Basalt starts (with a window): remembered, and watched. */
  fun setPath(context: Context, path: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (prefs.getString(KEY_PATH, null) != path) prefs.edit().putString(KEY_PATH, path).apply()
    watch(context)
  }

  /** Watches the file Rust writes, while the service runs. */
  fun watch(context: Context) {
    if (observer != null) return
    val app = context.applicationContext
    val path = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PATH, null) ?: return
    val file = File(path)
    val folder = file.parentFile ?: return
    folder.mkdirs()
    @Suppress("DEPRECATION")
    val watching = object : FileObserver(folder.path, CLOSE_WRITE or MOVED_TO) {
      override fun onEvent(event: Int, name: String?) {
        if (name == file.name) showNew(app, file)
      }
    }
    watching.startWatching()
    observer = watching
  }

  fun stop() {
    observer?.stopWatching()
    observer = null
  }

  /** Each written since the last seen, shown unless Basalt is on screen (the page says it there). */
  @Synchronized
  private fun showNew(context: Context, file: File) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val seen = prefs.getLong(KEY_SEEN, 0)
    val list = runCatching { JSONArray(file.readText()) }.getOrNull() ?: return
    var newest = seen
    for (i in 0 until list.length()) {
      val notice = list.optJSONObject(i) ?: continue
      val at = notice.optLong("at")
      if (at <= seen) continue
      if (at > newest) newest = at
      if (BasaltPlugin.onScreenNow()) continue
      val actions = notice.optJSONArray("actions")
      post(
        context,
        notice.optString("tag"),
        notice.optString("title"),
        notice.optString("text"),
        (0 until (actions?.length() ?: 0)).map { actions!!.optString(it) },
      )
    }
    if (newest > seen) prefs.edit().putLong(KEY_SEEN, newest).apply()
  }
}
