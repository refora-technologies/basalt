package app.basalt.android

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build

/**
 * Android 17's permission for the home network.
 *
 * An app that targets Android 17 reaches nothing on the local network without
 * it: no search, no connection, so no Basalt at all. Basalt targets 17, so
 * there it asks first (see LocalNetworkGate); older Androids never ask.
 *
 * Android 16 can turn the same rule on for one app, for developers to try
 * (`adb shell am compat enable RESTRICT_LOCAL_NETWORK <package>`), and there
 * the permission that lets the app back in is "nearby Wi-Fi devices". Only
 * test builds declare that one, in their own manifest, so the way the app
 * asks can be tried on Android 16; a release never carries it.
 */
object LocalNetwork {
  /** Android 17's permission. Spelled out: there is no constant before SDK 37. */
  const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
  const val ALIAS = "localNetwork"
  /** Android 16's, for trying it there. */
  const val TEST_PERMISSION = "android.permission.NEARBY_WIFI_DEVICES"
  const val TEST_ALIAS = "nearbyWifi"

  private const val ANDROID_16 = 36
  private const val ANDROID_17 = 37

  /** Which alias to ask for here, or none when Android does not ask. */
  fun alias(activity: Activity): String? {
    val target = activity.applicationInfo.targetSdkVersion
    if (Build.VERSION.SDK_INT >= ANDROID_17 && target >= ANDROID_17) return ALIAS
    if (Build.VERSION.SDK_INT == ANDROID_16 && declares(activity, TEST_PERMISSION)) return TEST_ALIAS
    return null
  }

  private fun declares(activity: Activity, permission: String): Boolean = runCatching {
    val info = activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_PERMISSIONS)
    info.requestedPermissions?.contains(permission) == true
  }.getOrDefault(false)
}
