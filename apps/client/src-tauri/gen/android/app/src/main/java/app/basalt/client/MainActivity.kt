package app.basalt.client

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.Lifecycle
import app.basalt.android.BasaltPlugin
import app.basalt.android.Restart

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Opened again in a process that stayed running without a window (ready
    // to receive): started over in a fresh one instead. See Restart.
    if (Restart.instead(this)) {
      super.onCreate(savedInstanceState)
      finish()
      return
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // A film playing goes into a small window when the app is left: see the
  // plugin's Pip. These are the activity's own moments, passed on to it.

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    BasaltPlugin.current?.leaving()
  }

  override fun onPause() {
    super.onPause()
    BasaltPlugin.current?.keepPageRunning()
  }

  override fun onStop() {
    super.onStop()
    BasaltPlugin.current?.stopped()
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    // Out of the small window by its close button, rather than opened back
    // up: the activity is on its way to stopping.
    val closed = !isInPictureInPictureMode && lifecycle.currentState == Lifecycle.State.CREATED
    BasaltPlugin.current?.pictureInPicture(isInPictureInPictureMode, closed)
  }
}
