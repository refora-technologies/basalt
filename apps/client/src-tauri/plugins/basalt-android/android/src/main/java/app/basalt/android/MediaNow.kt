package app.basalt.android

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * The song playing, as Android shows it outside the app: the lock screen,
 * the notification's player, the quick settings media controls, Samsung's
 * Now Bar, a car or Bluetooth headphones' buttons.
 *
 * All of those read one thing, a media session: what is playing, whether it
 * is, how far in, and which buttons work. Pressing one comes back here and
 * goes to the page as a `media` event, which moves the music player exactly
 * as its own buttons do. The page plays the music (mpv, through the plugin);
 * this only describes it.
 *
 * The notification itself is the playback one [KeepAliveService] already
 * shows while music plays, drawn as a media notification while there is a
 * session.
 */
object MediaNow {
  data class Info(
    val title: String,
    val artist: String,
    val album: String,
    /** Seconds. */
    val duration: Double,
    val position: Double,
    val playing: Boolean,
    val canPrevious: Boolean,
    val canNext: Boolean,
    val cover: String?,
  )

  private var session: MediaSession? = null
  private var info: Info? = null
  private var art: Bitmap? = null
  private var artFrom: String? = null
  private var tell: ((String, Double) -> Unit)? = null
  private val main = Handler(Looper.getMainLooper())

  /** What is playing, for the notification; null with nothing. */
  fun current(): Info? = info
  fun artwork(): Bitmap? = art
  fun token(): MediaSession.Token? = session?.sessionToken

  /**
   * Shows `now`, and sends the buttons pressed anywhere to `onAction`: one of
   * `play`, `pause`, `next`, `previous`, `stop`, or `seek` with a position.
   */
  fun show(context: Context, now: Info, onAction: (String, Double) -> Unit) {
    main.post {
      tell = onAction
      val session = session ?: MediaSession(context.applicationContext, "Basalt").also {
        it.setCallback(callback)
        session = it
      }
      val coverChanged = now.cover != artFrom
      info = now
      session.setMetadata(metadata(now, if (coverChanged) null else art))
      session.setPlaybackState(state(now))
      if (!session.isActive) session.isActive = true
      KeepAliveService.refresh(context)
      if (coverChanged) loadCover(context, now.cover)
    }
  }

  /** Nothing playing any more: gone from the lock screen and everywhere else. */
  fun end(context: Context) {
    main.post {
      info = null
      art = null
      artFrom = null
      tell = null
      session?.let {
        it.isActive = false
        it.release()
      }
      session = null
      KeepAliveService.refresh(context)
    }
  }

  /** A button on the notification (before Android 13, which uses the session's own). */
  fun press(action: String) {
    main.post { tell?.invoke(action, -1.0) }
  }

  private val callback = object : MediaSession.Callback() {
    override fun onPlay() { tell?.invoke("play", -1.0) }
    override fun onPause() { tell?.invoke("pause", -1.0) }
    override fun onSkipToNext() { tell?.invoke("next", -1.0) }
    override fun onSkipToPrevious() { tell?.invoke("previous", -1.0) }
    override fun onStop() { tell?.invoke("stop", -1.0) }
    override fun onSeekTo(pos: Long) { tell?.invoke("seek", pos / 1000.0) }
  }

  private fun metadata(now: Info, picture: Bitmap?): MediaMetadata =
    MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, now.title)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, now.artist)
      .putString(MediaMetadata.METADATA_KEY_ALBUM, now.album)
      .putLong(MediaMetadata.METADATA_KEY_DURATION, (now.duration * 1000).toLong())
      .apply { if (picture != null) putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, picture) }
      .build()

  private fun state(now: Info): PlaybackState {
    var actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
      PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or PlaybackState.ACTION_SEEK_TO
    if (now.canNext) actions = actions or PlaybackState.ACTION_SKIP_TO_NEXT
    if (now.canPrevious) actions = actions or PlaybackState.ACTION_SKIP_TO_PREVIOUS
    return PlaybackState.Builder()
      .setActions(actions)
      // The position as of now, and the speed: Android moves the lock
      // screen's bar on by itself, so the page need not say every second.
      .setState(
        if (now.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
        (now.position * 1000).toLong(),
        if (now.playing) 1f else 0f,
        SystemClock.elapsedRealtime(),
      )
      .build()
  }

  /**
   * The cover, from the app's own address for it on this phone (the media
   * proxy, which asks the host). Off the main thread; a song that has moved
   * on by the time it arrives keeps whatever it has.
   */
  private fun loadCover(context: Context, url: String?) {
    artFrom = url
    art = null
    if (url.isNullOrEmpty()) return
    thread(name = "basalt-cover") {
      val picture = runCatching {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 5000
        connection.readTimeout = 10000
        try {
          connection.inputStream.use { BitmapFactory.decodeStream(it) }
        } finally {
          connection.disconnect()
        }
      }.getOrNull() ?: return@thread
      main.post {
        val now = info ?: return@post
        if (artFrom != url) return@post
        art = picture
        session?.setMetadata(metadata(now, picture))
        KeepAliveService.refresh(context)
      }
    }
  }

  /** The notification's buttons, as broadcasts to [Buttons]. */
  fun button(context: Context, action: String): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      action.hashCode(),
      Intent(context, Buttons::class.java).setAction("$PREFIX$action"),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  private const val PREFIX = "app.basalt.android.media."

  /** Where the notification's buttons arrive. */
  class Buttons : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val action = intent.action?.removePrefix(PREFIX) ?: return
      press(action)
    }
  }
}
