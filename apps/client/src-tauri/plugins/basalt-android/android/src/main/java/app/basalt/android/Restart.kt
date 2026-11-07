package app.basalt.android

import android.app.Activity
import android.content.Intent
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
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      startActivity(it)
    }
    finish()
    Process.killProcess(Process.myPid())
  }

  companion object {
    private const val OLD_PROCESS = "old-process"

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
      from.startActivity(
        Intent(from, Restart::class.java)
          .putExtra(OLD_PROCESS, Process.myPid())
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
      return true
    }
  }
}
