package app.basalt.android

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import androidx.core.content.ContextCompat

/**
 * A film in a small window over other apps, when the person leaves Basalt
 * while it plays.
 *
 * The page says when a film is playing and what shape it is; Android does the
 * rest. On Android 12 and later it shrinks the app itself as the person goes
 * home. Before that, the activity asks as it is left. The small window has
 * one button, play and pause, which goes to mpv directly: the page may not be
 * running to hear it. Closed from the small window, the film pauses, as it
 * would in any player, rather than playing on unseen.
 */
class Pip(
  private val activity: Activity,
  /** Play or pause, in mpv. */
  private val togglePause: () -> Unit,
  /** Pause, in mpv. */
  private val pause: () -> Unit,
  /** Tells the page whether it is in the small window. */
  private val tell: (Boolean) -> Unit,
) {
  /** A film is playing: leaving the app should shrink it. */
  private var playing = false
  /** What mpv says, for the button's icon. */
  private var paused = false
  private var ratio = Rational(16, 9)
  private var receiver: BroadcastReceiver? = null

  /** Whether this Android has a small window for apps at all. */
  private val supported =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      activity.packageManager.hasSystemFeature("android.software.picture_in_picture")

  fun start() {
    if (!supported || receiver != null) return
    val button = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        togglePause()
      }
    }
    ContextCompat.registerReceiver(
      activity,
      button,
      IntentFilter(ACTION_TOGGLE),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    receiver = button
  }

  fun stop() {
    receiver?.let { runCatching { activity.unregisterReceiver(it) } }
    receiver = null
  }

  /** From the page: whether a film plays, and its picture's size. */
  fun set(playing: Boolean, width: Int, height: Int) {
    this.playing = playing
    if (width > 0 && height > 0) ratio = fit(width, height)
    apply()
  }

  /** From mpv: paused or playing, so the button shows the other. */
  fun paused(paused: Boolean) {
    if (this.paused == paused) return
    this.paused = paused
    if (inPip()) apply()
  }

  /** Leaving the app, on an Android that does not shrink it by itself. */
  fun leaving() {
    if (!supported || !playing || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
    runCatching { activity.enterPictureInPictureMode(params()) }
  }

  /**
   * Into the small window or out of it. `closed` is out of it by its close
   * button, rather than opened back up into the app.
   */
  fun changed(active: Boolean, closed: Boolean) {
    tell(active)
    if (closed) pause()
  }

  fun inPip(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && activity.isInPictureInPictureMode

  private fun apply() {
    if (!supported) return
    activity.runOnUiThread { runCatching { activity.setPictureInPictureParams(params()) } }
  }

  private fun params(): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder()
      .setAspectRatio(ratio)
      .setActions(listOf(button()))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(playing).setSeamlessResizeEnabled(true)
    }
    return builder.build()
  }

  private fun button(): RemoteAction {
    val label = if (paused) "Play" else "Pause"
    val icon = Icon.createWithResource(
      activity,
      if (paused) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause,
    )
    val intent = PendingIntent.getBroadcast(
      activity,
      0,
      Intent(ACTION_TOGGLE).setPackage(activity.packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return RemoteAction(icon, label, label, intent)
  }

  companion object {
    private const val ACTION_TOGGLE = "app.basalt.android.PIP_TOGGLE"

    /**
     * The picture's shape, within what Android allows a small window: no
     * wider than 2.39 to 1, no taller than 1 to 2.39. A film wider than that
     * is shown a little cropped, as every player's small window does.
     */
    fun fit(width: Int, height: Int): Rational {
      val r = width.toDouble() / height
      return when {
        r > 2.39 -> Rational(239, 100)
        r < 1 / 2.39 -> Rational(100, 239)
        else -> Rational(width, height)
      }
    }
  }
}
