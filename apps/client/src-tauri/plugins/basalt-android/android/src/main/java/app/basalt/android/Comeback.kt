package app.basalt.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * After the phone restarts or Basalt is updated, a Basalt that was ready to
 * receive isn't: its readiness lives in its window, and Android lets no app
 * open its own window from the background. So it says so, quietly, and one
 * tap makes it ready again. Nothing when it wasn't ready.
 *
 * Whether it was ready is kept by [KeepAliveService] (the "ready" and
 * "nearby" holds), and the notice goes once Basalt holds them again.
 */
class Comeback : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val why = when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED -> "Your phone restarted."
      Intent.ACTION_MY_PACKAGE_REPLACED -> "Basalt was updated."
      else -> return
    }
    if (wanted(context).isEmpty()) return
    show(context, why)
  }

  companion object {
    private const val PREFS = "basalt-ready"
    private const val KEY_WANTED = "wanted"
    private const val CHANNEL = "basalt-comeback"
    private const val NOTIFICATION_ID = 7743
    /** The holds that mean "ready to receive", as opposed to music or a transfer. */
    private val READY = setOf("ready", "nearby")

    fun wanted(context: Context): Set<String> =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(KEY_WANTED, emptySet()) ?: emptySet()

    /** Kept as the holds change: what to come back to. */
    fun held(context: Context, reason: String, on: Boolean) {
      if (reason !in READY) return
      val now = wanted(context).toMutableSet()
      val changed = if (on) now.add(reason) else now.remove(reason)
      if (changed) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(KEY_WANTED, now).apply()
      }
      // Ready again: the notice has done its work.
      if (on) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { manager.cancel(NOTIFICATION_ID) }
      }
    }

    private fun show(context: Context, why: String) {
      val allowed = Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
      if (!allowed) return
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL, "Ready to receive again", NotificationManager.IMPORTANCE_LOW).apply {
            description = "After the phone restarts or Basalt updates, one tap to be ready to receive again."
          }
        )
      }
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
      val tap = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val text = "$why Tap to be ready to receive again."
      val notice = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_basalt)
        .setContentTitle("Basalt isn't receiving")
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setAutoCancel(true)
        .setContentIntent(tap)
        .build()
      runCatching { manager.notify(NOTIFICATION_ID, notice) }
    }
  }
}
