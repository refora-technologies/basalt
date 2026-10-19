package app.basalt.client

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.Lifecycle
import app.basalt.android.BasaltPlugin

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
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

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    // Out of the small window by its close button, rather than opened back
    // up: the activity is on its way to stopping.
    val closed = !isInPictureInPictureMode && lifecycle.currentState == Lifecycle.State.CREATED
    BasaltPlugin.current?.pictureInPicture(isInPictureInPictureMode, closed)
  }
}
