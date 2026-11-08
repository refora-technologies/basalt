package app.basalt.android

import android.annotation.SuppressLint
import android.content.Context
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Devices nearby with no network in common (1.6.4): a device ready to
 * receive hosts a small Wi-Fi of its own, named for it ("DIRECT-bs-K7QM
 * Pixel 8"), and a device sharing finds it by that name and joins it. From
 * there it is the same as on any Wi-Fi: the app finds it, offers, and the
 * code is asked.
 *
 * Hosting is a Wi-Fi Direct group with our own name and passphrase
 * (Android 10 and later); a computer or another phone joins it as it would
 * any Wi-Fi. Joining is Android's own "connect to this network?", for this
 * app only, and the app's traffic goes over it until it leaves.
 */
class NearbyWifi(private val context: Context) {
  private val main = Handler(Looper.getMainLooper())
  private val p2p: WifiP2pManager? = context.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager?
  private var channel: WifiP2pManager.Channel? = null
  private var joinedCallback: ConnectivityManager.NetworkCallback? = null
  private var before: Network? = null
  private var hosting = false

  private val connectivity: ConnectivityManager
    get() = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private val wifi: WifiManager
    get() = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

  /** Whether Android will let this phone look at the Wi-Fis around: Location must be on, on every version. */
  fun locationOn(): Boolean {
    val location = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    return if (Build.VERSION.SDK_INT >= 28) location.isLocationEnabled else true
  }

  /** Hosts `name` with `passphrase`; `done` with nothing when it's up, or why not. */
  @SuppressLint("MissingPermission")
  fun host(name: String, passphrase: String, done: (String?) -> Unit) {
    if (Build.VERSION.SDK_INT < 29) {
      done("This needs Android 10 or later.")
      return
    }
    val manager = p2p ?: run {
      done("This phone has no Wi-Fi Direct.")
      return
    }
    val ch = channel ?: manager.initialize(context, Looper.getMainLooper(), null).also { channel = it }
    val config = WifiP2pConfig.Builder()
      .setNetworkName(name)
      .setPassphrase(passphrase)
      .enablePersistentMode(false)
      .setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ)
      .build()
    val create = {
      manager.createGroup(ch, config, object : WifiP2pManager.ActionListener {
        override fun onSuccess() {
          hosting = true
          done(null)
        }

        override fun onFailure(reason: Int) = done(p2pReason(reason))
      })
    }
    // One left from before (another name, a crash) goes first.
    manager.removeGroup(ch, object : WifiP2pManager.ActionListener {
      override fun onSuccess() {
        create()
      }

      override fun onFailure(reason: Int) {
        create()
      }
    })
  }

  /** Stops hosting. */
  fun stopHost() {
    val manager = p2p ?: return
    val ch = channel ?: return
    if (!hosting) return
    hosting = false
    manager.removeGroup(ch, null)
  }

  /** The Basalt Wi-Fis around, from a fresh look: name and signal, strongest first. */
  @SuppressLint("MissingPermission")
  fun scan(done: (List<Pair<String, Int>>) -> Unit) {
    @Suppress("DEPRECATION")
    runCatching { wifi.startScan() }
    main.postDelayed({
      val found = runCatching { wifi.scanResults }.getOrDefault(emptyList())
        .mapNotNull { result ->
          @Suppress("DEPRECATION")
          val ssid = result.SSID ?: return@mapNotNull null
          if (ssid.startsWith(PREFIX)) ssid to result.level else null
        }
        .groupBy({ it.first }, { it.second })
        .map { (ssid, levels) -> ssid to (levels.maxOrNull() ?: -100) }
        .sortedByDescending { it.second }
      done(found)
    }, SCAN_WAIT_MS)
  }

  /**
   * Joins `ssid` with `passphrase`, for this app: Android asks the person
   * first. `done` with nothing once joined, or why not.
   */
  fun join(ssid: String, passphrase: String, done: (String?) -> Unit) {
    if (Build.VERSION.SDK_INT < 29) {
      done("This needs Android 10 or later.")
      return
    }
    leave()
    val specifier = WifiNetworkSpecifier.Builder()
      .setSsid(ssid)
      .setWpa2Passphrase(passphrase)
      .build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifier)
      .build()
    before = connectivity.boundNetworkForProcess
    var answered = false
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        connectivity.bindProcessToNetwork(network)
        if (!answered) {
          answered = true
          // A moment for its routes to apply to this app's connections.
          main.postDelayed({ done(null) }, SETTLE_MS)
        }
      }

      override fun onUnavailable() {
        joinedNow = false
        if (!answered) {
          answered = true
          main.post { done("It couldn't join that device's Wi-Fi.") }
        }
      }
    }
    joinedCallback = callback
    joinedNow = true
    try {
      connectivity.requestNetwork(request, callback, JOIN_WAIT_MS)
    } catch (e: Exception) {
      joinedCallback = null
      joinedNow = false
      done(e.message ?: "It couldn't join that device's Wi-Fi.")
    }
  }

  /** Leaves a Wi-Fi joined for sharing: back to the one before. */
  fun leave() {
    val callback = joinedCallback ?: return
    joinedCallback = null
    joinedNow = false
    runCatching { connectivity.unregisterNetworkCallback(callback) }
    runCatching { connectivity.bindProcessToNetwork(before) }
    before = null
  }

  private fun p2pReason(reason: Int): String = when (reason) {
    WifiP2pManager.BUSY -> "Wi-Fi Direct is busy: try again in a moment."
    WifiP2pManager.P2P_UNSUPPORTED -> "This phone has no Wi-Fi Direct."
    else -> "Wi-Fi Direct couldn't start (is Wi-Fi on?)."
  }

  companion object {
    /** On a nearby device's own Wi-Fi now, to share: the app's binding stays on it. */
    @Volatile
    var joinedNow = false

    /** Every Basalt Wi-Fi is named so. */
    const val PREFIX = "DIRECT-bs-"
    private const val SCAN_WAIT_MS = 3_000L
    private const val JOIN_WAIT_MS = 60_000
    private const val SETTLE_MS = 1_500L
  }
}
