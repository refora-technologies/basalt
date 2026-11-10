package app.basalt.android

import android.app.Activity
import android.os.Build

/**
 * Android 17's permission for the home network.
 *
 * An app that targets Android 17 reaches nothing on the local network without
 * it: no search, no connection, so no Basalt at all. Basalt targets 17, so
 * there it asks first (see LocalNetworkGate); older Androids never ask.
 *
 * Android 16 only does this for one app when a developer turns it on, so
 * there nothing is asked. (It used to ask for "nearby Wi-Fi devices" on 16
 * when the app declared it, to try the screen; every build declares it now,
 * for sending to devices nearby, and Android 16 then stopped at a question
 * about location before the drive.)
 */
object LocalNetwork {
  /** Android 17's permission. Spelled out: there is no constant before SDK 37. */
  const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
  const val ALIAS = "localNetwork"

  private const val ANDROID_17 = 37

  /** Which alias to ask for here, or none when Android does not ask. */
  fun alias(activity: Activity): String? {
    val target = activity.applicationInfo.targetSdkVersion
    if (Build.VERSION.SDK_INT >= ANDROID_17 && target >= ANDROID_17) return ALIAS
    return null
  }
}
