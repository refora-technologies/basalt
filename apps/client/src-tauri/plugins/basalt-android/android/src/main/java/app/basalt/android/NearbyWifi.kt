package app.basalt.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
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
import android.os.SystemClock
import android.provider.Settings
import android.util.Log

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
  /** On a Wi-Fi before joining: the phone goes back to it after, if it can't be on two. */
  private var hadWifi = false
  private var hosting = false
  /** A group this app asked for, up or on its way: the only kind it takes down. */
  private var ours = false
  /** When this app last asked Android for a fresh look: it allows four every two minutes. */
  private var lastScan = 0L

  private val connectivity: ConnectivityManager
    get() = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private val wifi: WifiManager
    get() = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

  /** Whether Android will let this phone look at the Wi-Fis around: Location must be on, on every version. */
  fun locationOn(): Boolean {
    val location = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    return if (Build.VERSION.SDK_INT >= 28) location.isLocationEnabled else true
  }

  /** Whether Wi-Fi is on: hosting, looking and joining all need it. */
  fun wifiOn(): Boolean = runCatching { wifi.isWifiEnabled }.getOrDefault(false)

  /**
   * Turns Wi-Fi on, as far as Android lets an app: before Android 10 it just
   * does; from 10 on, Android's own Wi-Fi panel comes up over the app, one
   * tap away.
   */
  fun turnWifiOn(activity: Activity) {
    if (wifiOn()) return
    if (Build.VERSION.SDK_INT < 29) {
      @Suppress("DEPRECATION")
      runCatching { wifi.isWifiEnabled = true }
      return
    }
    runCatching { activity.startActivity(Intent(Settings.Panel.ACTION_WIFI)) }
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
    ours = true
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
          log("hosting $name")
          done(null)
        }

        override fun onFailure(reason: Int) {
          log("hosting $name failed: $reason")
          done(p2pReason(reason))
        }
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

  /**
   * Stops hosting; `done` once it has. Wi-Fi Direct turns a change away while
   * another is under way ("busy"), so it is asked again a few times: a group
   * left up keeps this phone from looking at the Wi-Fis around, or joining one.
   */
  fun stopHost(done: () -> Unit = {}) {
    val manager = p2p ?: return done()
    val ch = channel ?: return done()
    // Only a group this app asked for: never another app's.
    if (!ours) return done()
    hosting = false
    var tries = 0
    fun attempt() {
      manager.removeGroup(ch, object : WifiP2pManager.ActionListener {
        override fun onSuccess() {
          ours = false
          log("stopped hosting")
          done()
        }

        override fun onFailure(reason: Int) {
          tries += 1
          // No group at all is "done" too (ERROR, after the first try).
          if (reason == WifiP2pManager.BUSY && tries < 8) {
            main.postDelayed({ attempt() }, 400)
          } else {
            if (reason != WifiP2pManager.BUSY) ours = false
            log("stopping hosting: $reason after $tries")
            done()
          }
        }
      })
    }
    attempt()
  }

  /**
   * The Basalt Wi-Fis around: name and signal, strongest first. Android
   * lets an app ask for a fresh look four times every two minutes, and turns
   * the rest away; so a fresh look at most every half minute, and between
   * them what Android last saw (its own looks, and other apps', count too),
   * leaving out what it hasn't seen for a while.
   */
  @SuppressLint("MissingPermission")
  fun scan(done: (List<Pair<String, Int>>) -> Unit) {
    val now = SystemClock.elapsedRealtime()
    if (now - lastScan < SCAN_EVERY_MS) {
      done(seen())
      return
    }
    lastScan = now
    @Suppress("DEPRECATION")
    val asked = runCatching { wifi.startScan() }.getOrDefault(false)
    if (!asked) {
      val found = seen()
      log("a fresh look refused; ${found.size} seen lately")
      done(found)
      return
    }
    main.postDelayed({
      val found = seen()
      log("looked: ${found.size} Basalt Wi-Fi(s) of ${runCatching { wifi.scanResults.size }.getOrDefault(0)} around")
      done(found)
    }, SCAN_WAIT_MS)
  }

  @SuppressLint("MissingPermission")
  private fun seen(): List<Pair<String, Int>> {
    val nowMicros = SystemClock.elapsedRealtime() * 1000
    return runCatching { wifi.scanResults }.getOrDefault(emptyList())
      .filter { nowMicros - it.timestamp < SEEN_FOR_MS * 1000 }
      .mapNotNull { result ->
        @Suppress("DEPRECATION")
        val ssid = result.SSID ?: return@mapNotNull null
        if (ssid.startsWith(PREFIX)) ssid to result.level else null
      }
      .groupBy({ it.first }, { it.second })
      .map { (ssid, levels) -> ssid to (levels.maxOrNull() ?: -100) }
      .sortedByDescending { it.second }
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
    hadWifi = runCatching {
      val now = before ?: connectivity.activeNetwork
      connectivity.getNetworkCapabilities(now)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    }.getOrDefault(false)
    var answered = false
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        val bound = connectivity.bindProcessToNetwork(network)
        log("joined $ssid as $network, this app bound to it: $bound")
        if (!answered) {
          answered = true
          // A moment for its routes to apply to this app's connections.
          main.postDelayed({ done(null) }, SETTLE_MS)
        }
      }

      override fun onLost(network: Network) {
        log("$ssid lost ($network)")
      }

      override fun onUnavailable() {
        log("joining $ssid: unavailable (declined, or not found)")
        joinedNow = false
        joinedCallback = null
        if (!answered) {
          answered = true
          main.post { done("It couldn't join that device's Wi-Fi.") }
        }
      }
    }
    joinedCallback = callback
    joinedNow = true
    log("joining $ssid")
    try {
      // No time limit given to Android: its "Connect to device?" waits for
      // the person, however long they take, and a limit would end the request
      // the moment it ran out, connected or not. Ours is longer, and only
      // for a request still unanswered.
      connectivity.requestNetwork(request, callback)
      main.postDelayed({
        if (!answered && joinedCallback === callback) {
          answered = true
          log("joining $ssid: no answer in time")
          leave()
          done("It couldn't join that device's Wi-Fi.")
        }
      }, JOIN_WAIT_MS)
    } catch (e: Exception) {
      joinedCallback = null
      joinedNow = false
      done(e.message ?: "It couldn't join that device's Wi-Fi.")
    }
  }

  /** Leaves a Wi-Fi joined for sharing: back to the one before. */
  /**
   * Leaves a Wi-Fi joined for sharing; `done` once the phone is back on the
   * Wi-Fi it was on (or after a while without it). A phone that can be on
   * one Wi-Fi only went off it to join, and finds it again by looking: done
   * before its own Wi-Fi opens again, as a phone hosting one may not look.
   */
  fun leave(done: () -> Unit = {}) {
    val callback = joinedCallback ?: return done()
    joinedCallback = null
    joinedNow = false
    runCatching { connectivity.unregisterNetworkCallback(callback) }
    // Back on the Wi-Fi from before if it is still there (it went, on a phone
    // that can't be on two at once: its own binding comes back with it).
    val back = before?.takeIf { it in connectivity.allNetworks }
    runCatching { connectivity.bindProcessToNetwork(back) }
    log("left the joined Wi-Fi, back on ${back ?: "the default"}")
    before = null
    if (back != null || !hadWifi) return done()
    var finished = false
    lateinit var waiting: ConnectivityManager.NetworkCallback
    val finish = { why: String ->
      if (!finished) {
        finished = true
        runCatching { connectivity.unregisterNetworkCallback(waiting) }
        log("after leaving: $why")
        done()
      }
    }
    waiting = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        main.post { finish("home Wi-Fi back ($network)") }
      }
    }
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .build()
    runCatching { connectivity.registerNetworkCallback(request, waiting) }
      .onFailure { return finish("can't watch for it") }
    main.postDelayed({ finish("home Wi-Fi not back in time") }, BACK_WAIT_MS)
  }

  private fun log(line: String) {
    Log.i("BasaltNearby", line)
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
    /** Four fresh looks every two minutes, Android allows. */
    private const val SCAN_EVERY_MS = 30_000L
    /** A Wi-Fi not seen for this long is taken as gone. */
    private const val SEEN_FOR_MS = 90_000L
    private const val JOIN_WAIT_MS = 5 * 60_000L
    /** How long a phone is given to find its own Wi-Fi again after sharing on another's. */
    private const val BACK_WAIT_MS = 20_000L
    private const val SETTLE_MS = 1_500L
  }
}
