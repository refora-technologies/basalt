package app.basalt.android

import android.app.Activity
import app.tauri.plugin.JSObject
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import com.google.android.play.core.review.ReviewManagerFactory

/**
 * Google Play's own services, in the Play build only.
 *
 * Built in when the app is made with BASALT_CHANNEL=play (see the plugin's
 * build.gradle.kts). The GitHub build compiles `src/github` instead, the same
 * object answering "not available", so it carries no Google library: these
 * are not open source, and the GitHub APK is.
 *
 * Updates are Play's "flexible" kind: Play downloads the new version while
 * Basalt stays open, and the app restarts into it when the person says so.
 * The app never installs anything itself, which Play does not allow.
 */
object PlayServices {
  const val AVAILABLE = true

  private var manager: AppUpdateManager? = null
  private var info: AppUpdateInfo? = null
  private var status = "idle"
  private var bytes = 0L
  private var total = 0L

  private val listener = InstallStateUpdatedListener { state ->
    bytes = state.bytesDownloaded()
    total = state.totalBytesToDownload()
    status = when (state.installStatus()) {
      InstallStatus.PENDING -> "pending"
      InstallStatus.DOWNLOADING -> "downloading"
      InstallStatus.DOWNLOADED -> "downloaded"
      InstallStatus.INSTALLING -> "installing"
      InstallStatus.INSTALLED -> "installed"
      InstallStatus.FAILED -> "failed"
      InstallStatus.CANCELED -> "canceled"
      else -> "idle"
    }
  }

  private fun manager(activity: Activity): AppUpdateManager =
    manager ?: AppUpdateManagerFactory.create(activity.applicationContext).also {
      it.registerListener(listener)
      manager = it
    }

  /** Whether Play has a newer version, and its version code. */
  fun checkUpdate(activity: Activity, done: (JSObject) -> Unit) {
    manager(activity).appUpdateInfo
      .addOnSuccessListener { found ->
        info = found
        // A download Play finished while the app was away is ready now.
        if (found.installStatus() == InstallStatus.DOWNLOADED) status = "downloaded"
        val available = found.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE &&
          found.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)
        done(
          JSObject()
            .put("available", available || status == "downloaded")
            .put("versionCode", found.availableVersionCode())
            .put("status", status)
        )
      }
      .addOnFailureListener { e ->
        done(JSObject().put("available", false).put("error", e.message ?: "Google Play did not answer"))
      }
  }

  /** Asks Play to download the update; Play shows its own confirmation. */
  fun startUpdate(activity: Activity, done: (JSObject) -> Unit) {
    val found = info
    if (found == null) {
      done(JSObject().put("started", false).put("error", "check for the update first"))
      return
    }
    val started = runCatching {
      status = "pending"
      manager(activity).startUpdateFlowForResult(
        found,
        activity,
        AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build(),
        REQUEST_CODE,
      )
    }.getOrElse { e ->
      status = "failed"
      done(JSObject().put("started", false).put("error", e.message ?: "could not start the update"))
      return
    }
    done(JSObject().put("started", started))
  }

  /** How the download is going, polled by the app while it shows progress. */
  fun updateState(): JSObject =
    JSObject().put("status", status).put("bytes", bytes).put("total", total)

  /** Restarts into the downloaded version. */
  fun completeUpdate(activity: Activity) {
    manager(activity).completeUpdate()
  }

  /**
   * Google's rating sheet, shown over the app. Google decides whether it
   * actually appears (it limits how often), and never says whether someone
   * rated: the answer is only whether the request went through.
   */
  fun requestReview(activity: Activity, done: (Boolean) -> Unit) {
    val reviews = ReviewManagerFactory.create(activity.applicationContext)
    reviews.requestReviewFlow().addOnCompleteListener { request ->
      if (!request.isSuccessful) {
        done(false)
        return@addOnCompleteListener
      }
      reviews.launchReviewFlow(activity, request.result).addOnCompleteListener { done(true) }
    }
  }

  private const val REQUEST_CODE = 7302
}
