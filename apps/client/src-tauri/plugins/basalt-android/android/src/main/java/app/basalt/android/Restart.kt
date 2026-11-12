package app.basalt.android

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process

/**
 * Opens Basalt again in a fresh process.
 *
 * Basalt stays running when it is swiped away while it is ready to receive
 * (see KeepAliveService): the line to the host, transfers and the heartbeat
 * carry on without a window. But the app's web layer can't take a second
 * window in the same process: opened again, the page stays empty (Tauri,
 * tauri-apps/tauri#15671). So the main activity, opened in a process that
 * already had one, sends here instead. This runs in a process of its own
 * (`:restart` in the manifest): it ends the old one, opens Basalt, and goes.
 * The old process's work stops for the second it takes; the new one takes it
 * up again as it starts.
 */
class Restart : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val old = intent.getIntExtra(OLD_PROCESS, -1)
    if (old > 0 && old != Process.myPid()) Process.killProcess(old)
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    // What Basalt was opened for goes on to the fresh one: files shared to it
    // (with leave to read them), a notification's Accept or Open.
    @Suppress("DEPRECATION")
    val asked: Intent? =
      if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(ORIGINAL, Intent::class.java)
      else intent.getParcelableExtra(ORIGINAL)
    val open = asked?.apply { component = launch?.component } ?: launch
    open?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      if (asked != null) {
        it.clipData = intent.clipData
        it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      startActivity(it)
    }
    finish()
    Process.killProcess(Process.myPid())
  }

  companion object {
    private const val OLD_PROCESS = "old-process"
    private const val ORIGINAL = "original"

    @Suppress("DEPRECATION")
    private fun sharedUris(asked: Intent): List<Uri> {
      val clip = asked.clipData
      if (clip != null) return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
      return when (asked.action) {
        Intent.ACTION_SEND -> listOfNotNull(asked.getParcelableExtra(Intent.EXTRA_STREAM))
        Intent.ACTION_SEND_MULTIPLE -> asked.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
        else -> emptyList()
      }
    }

    /** Whether this process has opened Basalt's window before. */
    @Volatile
    private var opened = false

    /**
     * Called first thing as Basalt's window opens: true when this process
     * had one before and has been asked to start over, in which case the
     * caller finishes at once.
     */
    fun instead(from: Activity): Boolean {
      if (!opened) {
        opened = true
        return false
      }
      val restart = Intent(from, Restart::class.java)
        .putExtra(OLD_PROCESS, Process.myPid())
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      from.intent?.let { asked ->
        restart.putExtra(ORIGINAL, Intent(asked).setComponent(null))
        // Files shared to Basalt: read leave passed along, as Android gave it
        // to this window only.
        val uris = sharedUris(asked)
        if (uris.isNotEmpty()) {
          val clip = ClipData.newRawUri("shared", uris.first())
          uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
          restart.clipData = clip
          restart.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
      }
      from.startActivity(restart)
      return true
    }
  }
}
