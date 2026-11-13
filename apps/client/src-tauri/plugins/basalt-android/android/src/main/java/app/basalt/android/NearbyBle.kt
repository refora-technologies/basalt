package app.basalt.android

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.util.UUID

/**
 * Devices nearby found by Bluetooth (1.6.4), so that a device ready to
 * receive needn't keep a Wi-Fi of its own open all the time: that made the
 * device's own Wi-Fi several times slower, the one radio hopping between two
 * channels all day.
 *
 * Ready: this device says over Bluetooth Low Energy that it is here (SERVICE),
 * and answers two things there: who it is (INFO: its id, name, kind and the
 * Wi-Fi it would open), and "open your Wi-Fi" (OPEN). Only then does it open
 * its own Wi-Fi (see [NearbyWifi]), and closes it once nobody is on it.
 *
 * Sharing: this device looks for those, reads each one's INFO, and lists
 * them; one chosen is asked to OPEN, and joined over its Wi-Fi as before. It
 * also says "sharing nearby" (BEACON) and answers HERE: a device that can't be
 * found by Bluetooth (some computers' can only look) hears it, opens its own
 * Wi-Fi while someone nearby is sharing, and writes its INFO to HERE, so it's
 * listed with its Wi-Fi already open. A ready device that can't say it's here
 * listens so too. The same ids as the computer's (`nearby_ble.rs`).
 *
 * Bluetooth's calls come back on its own threads; everything here is moved
 * onto the main thread, one GATT conversation at a time, as Android's GATT
 * stack falls over with several at once.
 */
@SuppressLint("MissingPermission")
object NearbyBle {
  val SERVICE: UUID = UUID.fromString("e5795d3a-c372-4b39-a44e-b20b2422a26b")
  val INFO: UUID = UUID.fromString("c93fb84e-04a4-4001-8827-b05e8e879009")
  val OPEN: UUID = UUID.fromString("7387b09a-e6eb-4948-a7e1-cc09f9f36479")
  val BEACON: UUID = UUID.fromString("52f5ac84-78b4-4fa7-b2c6-3c245c2f96be")
  val HERE: UUID = UUID.fromString("1ee8afff-ceb1-4ef5-a210-8e00471b34d6")

  private const val TAG = "BasaltNearbyBle"
  /** How long a step with another device's Bluetooth may take. */
  private const val STEP_MS = 12_000L
  /** A device not heard from for this long leaves the list. */
  private const val SEEN_FOR_MS = 20_000L
  /** Its INFO read again after this long (a name changed, a device restarted). */
  private const val INFO_AGAIN_MS = 60_000L
  /** Our own Wi-Fi, opened for someone, closes if nobody joins it within this. */
  private const val NOBODY_CAME_MS = 3 * 60_000L
  /** And once everyone has left it, after this. */
  private const val ALL_LEFT_MS = 45_000L
  /** Listening, our own Wi-Fi stays open this long after the last "sharing nearby". */
  private const val SHARING_GONE_MS = 60_000L
  /** A device sharing is told we're here again after this long. */
  private const val TELL_AGAIN_MS = 15_000L
  /** How long a device heard sharing is given to find this phone on its Wi-Fi first. */
  private const val LAN_FIRST_MS = 5_000L
  /** The packet size asked for before writing a device's details. */
  private const val MTU = 247
  /** One that told us it's here is listed this long after it last did. */
  private const val HERE_FOR_MS = 45_000L

  private val main = Handler(Looper.getMainLooper())
  private lateinit var context: Context

  private fun manager(): BluetoothManager? = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?

  fun init(context: Context) {
    if (this::context.isInitialized) return
    this.context = context.applicationContext
    // Asked to open while swiped away, and Android wouldn't: opened as soon
    // as Basalt is shown (the notification brings it).
    (this.context as? Application)?.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityResumed(activity: Activity) {
        main.post { openIfAsked() }
      }

      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
      override fun onActivityStarted(activity: Activity) {}
      override fun onActivityPaused(activity: Activity) {}
      override fun onActivityStopped(activity: Activity) {}
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
      override fun onActivityDestroyed(activity: Activity) {}
    })
  }

  /** How long the asking device keeps trying (see useNearby's send). */
  private const val ASKED_FOR_MS = 2 * 60_000L
  private const val ASKED_KEY = "nearby.askedAt"

  /**
   * When someone asked us to open while Android wouldn't let us, in wall
   * time; kept on disk, as Basalt shown again starts in a fresh process
   * (see Restart) and this one is gone.
   */
  private fun prefs() = context.getSharedPreferences("basalt-nearby", Context.MODE_PRIVATE)

  private fun markAsked() {
    prefs().edit().putLong(ASKED_KEY, System.currentTimeMillis()).apply()
  }

  /** Asked a moment ago, and ready to open (its Wi-Fi's name known): opened now. */
  private fun openIfAsked() {
    if (ssid.isEmpty()) return
    val at = prefs().getLong(ASKED_KEY, 0L)
    if (at == 0L) return
    prefs().edit().remove(ASKED_KEY).apply()
    if (System.currentTimeMillis() - at > ASKED_FOR_MS) return
    log("shown again after being asked: opening its Wi-Fi")
    openOwnWifi(listening = false) { why -> log(if (why == null) "its Wi-Fi is open" else "still couldn't open its Wi-Fi: $why") }
  }

  /** `unsupported` (no Bluetooth LE), `off`, or `on`. */
  fun state(): String {
    val adapter = manager()?.adapter ?: return "unsupported"
    if (!context.packageManager.hasSystemFeature("android.hardware.bluetooth_le")) return "unsupported"
    return if (adapter.isEnabled) "on" else "off"
  }

  // ---------------------------------------------------------------------------
  // One GATT server for both: SERVICE while ready, BEACON while sharing
  // ---------------------------------------------------------------------------

  private var server: BluetoothGattServer? = null
  private val services = mutableSetOf<UUID>()
  /** Runs once a service asked for is added. */
  private val added = HashMap<UUID, (Boolean) -> Unit>()

  private fun addService(service: BluetoothGattService, done: (Boolean) -> Unit) {
    if (service.uuid in services) return done(true)
    val s = server ?: manager()?.openGattServer(context, serverCallback)?.also { server = it }
    if (s == null) return done(false)
    added[service.uuid] = done
    if (!s.addService(service)) {
      added.remove(service.uuid)
      done(false)
    }
  }

  private fun removeService(uuid: UUID) {
    val s = server ?: return
    s.getService(uuid)?.let { runCatching { s.removeService(it) } }
    services.remove(uuid)
    if (services.isEmpty()) {
      runCatching { s.close() }
      server = null
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onServiceAdded(status: Int, service: BluetoothGattService) {
      main.post {
        val ok = status == BluetoothGatt.GATT_SUCCESS
        if (ok) services.add(service.uuid)
        added.remove(service.uuid)?.invoke(ok)
      }
    }

    override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, characteristic: BluetoothGattCharacteristic) {
      val s = server ?: return
      if (characteristic.uuid != INFO) {
        s.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null)
        return
      }
      val bytes = info
      if (offset > bytes.size) {
        s.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
        return
      }
      s.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, bytes.copyOfRange(offset, bytes.size))
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      val s = server ?: return
      // Longer than one packet (a device's details, from a phone that didn't
      // ask for bigger ones): it comes in pieces, each echoed back, and is
      // taken whole when the writer says to (onExecuteWrite).
      if (preparedWrite) {
        val key = "${device.address}/${characteristic.uuid}"
        val parts = pieces.getOrPut(key) { java.io.ByteArrayOutputStream() }
        if (offset != parts.size()) {
          pieces.remove(key)
          if (responseNeeded) runCatching { s.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null) }
          return
        }
        parts.write(value ?: ByteArray(0))
        if (responseNeeded) runCatching { s.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value) }
        return
      }
      written(device, characteristic.uuid, value) { ok ->
        if (responseNeeded) {
          runCatching { s.sendResponse(device, requestId, if (ok) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE, 0, null) }
        }
      }
    }

    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
      val s = server ?: return
      val mine = pieces.keys.filter { it.startsWith("${device.address}/") }
      val whole = mine.mapNotNull { key -> pieces.remove(key)?.let { key to it.toByteArray() } }
      val (key, value) = whole.firstOrNull() ?: run {
        runCatching { s.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null) }
        return
      }
      if (!execute) {
        runCatching { s.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null) }
        return
      }
      written(device, UUID.fromString(key.substringAfter('/')), value) { ok ->
        runCatching { s.sendResponse(device, requestId, if (ok) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE, 0, null) }
      }
    }
  }

  /** Pieces of a long write, by device and characteristic, until it's executed. */
  private val pieces = java.util.concurrent.ConcurrentHashMap<String, java.io.ByteArrayOutputStream>()

  /** A write to one of ours, whole: `answer` says whether it was done. */
  private fun written(device: BluetoothDevice, which: UUID, value: ByteArray?, answer: (Boolean) -> Unit) {
    when (which) {
      OPEN -> {
        log("asked to open its Wi-Fi by ${value?.let { String(it) } ?: "?"}")
        main.post {
          openOwnWifi(listening = false) { why ->
            log(if (why == null) "its Wi-Fi is open" else "couldn't open its Wi-Fi: $why")
            if (why != null && Build.VERSION.SDK_INT <= 32) {
              // Android 10 to 12 open Wi-Fi Direct only for an app on
              // screen: the person is asked to bring Basalt up, and it opens
              // then; the asking device keeps trying meanwhile.
              markAsked()
              ShareNotices.post(
                context,
                "nearby-asked",
                "Someone nearby wants to send you a file",
                "Tap to open Basalt and receive it.",
                emptyList(),
              )
            }
            answer(why == null)
          }
        }
      }
      HERE -> {
        val said = value?.let { String(it) } ?: ""
        main.post {
          val id = runCatching { JSONObject(said).optString("id") }.getOrNull()
          if (!id.isNullOrEmpty()) {
            log("$id says it's here")
            here[id] = said to SystemClock.elapsedRealtime()
          }
        }
        answer(true)
      }
      else -> answer(false)
    }
  }

  private fun advertise(uuid: UUID, done: (String?) -> Unit): AdvertiseCallback? {
    val advertiser = manager()?.adapter?.bluetoothLeAdvertiser ?: run {
      done("This device can't be found by Bluetooth.")
      return null
    }
    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) = done(null)

      override fun onStartFailure(errorCode: Int) = done("Bluetooth couldn't say so ($errorCode).")
    }
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .setConnectable(true)
      .setTimeout(0)
      .build()
    val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(uuid)).build()
    return try {
      advertiser.startAdvertising(settings, data, callback)
      callback
    } catch (e: Exception) {
      done(e.message ?: "Bluetooth couldn't say so.")
      null
    }
  }

  private fun stopAdvertising(callback: AdvertiseCallback?) {
    callback ?: return
    runCatching { manager()?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(callback) }
  }

  // ---------------------------------------------------------------------------
  // Ready: saying it's here, and opening its Wi-Fi when asked
  // ---------------------------------------------------------------------------

  private var readyOn = false
  private var advertising: AdvertiseCallback? = null
  private var info = ByteArray(0)
  private var ssid = ""
  private var passphrase = ""
  /** Our own Wi-Fi is open for someone, since when. */
  private var openedAt = 0L
  private var lastSomeoneOn = 0L
  private var watching = false
  /** Ready but can't be found: listening for devices sharing nearby. */
  private var listening: ScanCallback? = null
  private var sharingHeard = 0L
  /** When "sharing nearby" was last heard from anyone. */
  private var lastSharingAd = 0L
  /** When this phone, unable to open its Wi-Fi from the background, last said someone is sharing. */
  private var toldSharingAt = 0L
  private val told = HashMap<String, Long>()

  /**
   * Ready, with what it says about itself (`infoJson`) and the Wi-Fi it
   * opens when asked. `done` with nothing once it's saying so (or listening,
   * where it can't), or why not.
   */
  fun ready(infoJson: String, ssid: String, passphrase: String, done: (String?) -> Unit) {
    main.post {
      info = infoJson.toByteArray()
      this.ssid = ssid
      this.passphrase = passphrase
      if (readyOn) {
        openIfAsked()
        return@post done(null)
      }
      val adapter = manager()?.adapter
      if (adapter == null || !adapter.isEnabled) return@post done("Bluetooth is off.")
      readyOn = true
      val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
      service.addCharacteristic(
        BluetoothGattCharacteristic(INFO, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ),
      )
      service.addCharacteristic(
        BluetoothGattCharacteristic(OPEN, BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE),
      )
      addService(service) { ok ->
        if (!ok) {
          log("can't answer over Bluetooth: listening instead")
          listen()
          return@addService done(null)
        }
        advertising = advertise(SERVICE) { why ->
          main.post {
            if (why == null) {
              log("saying it's here")
            } else {
              log("can't say it's here ($why): listening instead")
              advertising = null
              listen()
            }
            // Brought up by the notification: someone nearby is waiting.
            openIfAsked()
            done(null)
          }
        }
      }
    }
  }

  /** Not ready any more: says nothing, answers nothing, and closes a Wi-Fi it opened. */
  fun stopReady() {
    main.post {
      readyOn = false
      stopAdvertising(advertising)
      advertising = null
      removeService(SERVICE)
      listening?.let { cb -> runCatching { manager()?.adapter?.bluetoothLeScanner?.stopScan(cb) } }
      listening = null
      closeOwnWifi("not ready")
    }
  }

  /** Ready, but can't be found: hears devices sharing nearby, and tells each it's here. */
  private fun listen() {
    if (listening != null) return
    val scanner = manager()?.adapter?.bluetoothLeScanner ?: return
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        main.post { heardSharing(result.device) }
      }
    }
    try {
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(BEACON)).build()
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
      scanner.startScan(listOf(filter), settings, callback)
      listening = callback
    } catch (e: Exception) {
      log("can't listen either: ${e.message}")
    }
  }

  private fun heardSharing(device: BluetoothDevice) {
    val now = SystemClock.elapsedRealtime()
    lastSharingAd = now
    val last = told[device.address] ?: 0L
    if (now - last < TELL_AGAIN_MS) return
    told[device.address] = now
    // A device sharing on this phone's Wi-Fi looks for it there within
    // moments and finds it: then there's nothing to open, and a Wi-Fi of its
    // own would only slow this phone's (as it did a computer's, which then
    // missed a send). Rust touches a file when it's looked for.
    main.postDelayed({
      val looked = ShareNotices.beside(context, "nearby-looked-for")?.lastModified() ?: 0L
      if (looked > 0 && System.currentTimeMillis() - looked < LAN_FIRST_MS + 3_000L) {
        log("someone nearby is sharing, and found this phone on its Wi-Fi")
        return@postDelayed
      }
      // And only if it's still sharing: the last word of one that just
      // stopped (its app left the screen) isn't a reason.
      if (lastSharingAd <= now + 1_000L) return@postDelayed
      sharingHeard = SystemClock.elapsedRealtime()
      openForSharing(device)
    }, LAN_FIRST_MS)
  }

  private fun openForSharing(device: BluetoothDevice) {
    openOwnWifi(listening = true) { why ->
      if (why != null) {
        log("couldn't open its Wi-Fi for someone sharing nearby: $why")
        // Android 10 to 12 open Wi-Fi Direct only for an app on screen: the
        // person is told, now and then, so the one sharing can find them.
        val now = SystemClock.elapsedRealtime()
        if (Build.VERSION.SDK_INT <= 32 && (toldSharingAt == 0L || now - toldSharingAt > 10 * 60_000L)) {
          toldSharingAt = now
          ShareNotices.post(
            context,
            "nearby-sharing",
            "Someone nearby is sharing files",
            "Tap to open Basalt so they can find you.",
            emptyList(),
          )
        }
        return@openOwnWifi
      }
      enqueue { next ->
        talk(device, BEACON, HERE, write = info) { _, said ->
          log("told ${device.address} it's here: ${said ?: "done"}")
          next()
        }
      }
    }
  }

  private fun openOwnWifi(listening: Boolean, done: (String?) -> Unit) {
    val wifi = NearbyWifi.shared(context)
    if (openedAt > 0 && wifi.isHosting()) {
      // Already open (another asked a moment ago): longer, for this one too.
      if (!listening) openedAt = SystemClock.elapsedRealtime()
      return done(null)
    }
    wifi.host(ssid, passphrase) { why ->
      if (why == null) {
        openedAt = SystemClock.elapsedRealtime()
        lastSomeoneOn = 0L
        watchOwnWifi()
      }
      done(why)
    }
  }

  private fun closeOwnWifi(why: String) {
    if (openedAt == 0L) return
    openedAt = 0L
    log("closing its Wi-Fi: $why")
    NearbyWifi.shared(context).stopHost()
  }

  /** Every so often while it's open: closed once nobody came, or everyone left, and nobody nearby is sharing. */
  private fun watchOwnWifi() {
    if (watching) return
    watching = true
    fun look() {
      if (openedAt == 0L) {
        watching = false
        return
      }
      NearbyWifi.shared(context).clients { count ->
        val now = SystemClock.elapsedRealtime()
        if (count != null && count > 0) lastSomeoneOn = now
        val sharingNearby = listening != null && now - sharingHeard < SHARING_GONE_MS
        when {
          sharingNearby -> {}
          lastSomeoneOn == 0L && now - openedAt > NOBODY_CAME_MS -> closeOwnWifi("nobody came")
          lastSomeoneOn > 0L && (count ?: 0) == 0 && now - lastSomeoneOn > ALL_LEFT_MS -> closeOwnWifi("everyone left")
        }
        main.postDelayed({ look() }, 10_000L)
      }
    }
    main.postDelayed({ look() }, 10_000L)
  }

  // ---------------------------------------------------------------------------
  // Sharing: finding the devices that are ready, and asking one to open
  // ---------------------------------------------------------------------------

  class Found(val address: String, var info: String?, var rssi: Int, var seenAt: Long, var infoAt: Long)

  private val found = LinkedHashMap<String, Found>()
  /** Devices that can't be found, that told us they're here: id to (INFO, when). */
  private val here = LinkedHashMap<String, Pair<String, Long>>()
  private var scanning: ScanCallback? = null
  private var beaconing: AdvertiseCallback? = null
  /** GATT steps, one at a time. */
  private val queue = ArrayDeque<(() -> Unit) -> Unit>()
  private var busy = false

  /** Looks for devices that are ready while `on`, and says "sharing nearby". */
  fun look(on: Boolean): String? {
    val adapter = manager()?.adapter
    if (!on) {
      scanning?.let { cb -> runCatching { adapter?.bluetoothLeScanner?.stopScan(cb) } }
      scanning = null
      stopAdvertising(beaconing)
      beaconing = null
      removeService(BEACON)
      here.clear()
      return null
    }
    if (scanning != null) return null
    if (adapter == null || !adapter.isEnabled) return "Bluetooth is off."
    val scanner = adapter.bluetoothLeScanner ?: return "Bluetooth is off."
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        main.post { heard(result) }
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        main.post { results.forEach { heard(it) } }
      }

      override fun onScanFailed(errorCode: Int) {
        log("looking failed: $errorCode")
        scanning = null
      }
    }
    try {
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
      scanner.startScan(listOf(filter), settings, callback)
      scanning = callback
      log("looking")
    } catch (e: Exception) {
      return e.message ?: "Bluetooth couldn't look for devices."
    }
    // "Sharing nearby", for devices that can't be found to come forward.
    val beacon = BluetoothGattService(BEACON, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    beacon.addCharacteristic(
      BluetoothGattCharacteristic(HERE, BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE),
    )
    addService(beacon) { ok ->
      if (ok && scanning != null) {
        beaconing = advertise(BEACON) { why -> if (why != null) log("can't say it's sharing: $why") }
      }
    }
    return null
  }

  private fun heard(result: ScanResult) {
    val address = result.device.address
    val now = SystemClock.elapsedRealtime()
    val known = found[address]
    if (known != null) {
      known.rssi = result.rssi
      known.seenAt = now
      if (known.info != null && now - known.infoAt < INFO_AGAIN_MS) return
    } else {
      found[address] = Found(address, null, result.rssi, now, 0L)
      log("heard $address (${result.rssi} dBm)")
    }
    val entry = found[address] ?: return
    if (entry.infoAt != 0L && entry.info == null && now - entry.infoAt < 10_000L) return
    entry.infoAt = now
    enqueue { next ->
      talk(result.device, SERVICE, INFO, write = null) { info, why ->
        if (info != null) {
          entry.info = info
          entry.infoAt = SystemClock.elapsedRealtime()
          log("$address is $info")
        } else {
          log("couldn't ask $address who it is: $why")
        }
        next()
      }
    }
  }

  /**
   * The devices heard lately whose INFO was read: (address, info JSON,
   * signal, open). Those that told us they're here come as `here:<id>`, open.
   */
  fun seen(): List<Array<Any>> {
    val now = SystemClock.elapsedRealtime()
    if (!busy) found.entries.removeAll { now - it.value.seenAt > SEEN_FOR_MS }
    here.entries.removeAll { now - it.value.second > HERE_FOR_MS }
    val out = ArrayList<Array<Any>>()
    for (f in found.values) f.info?.let { out.add(arrayOf(f.address, it, f.rssi, false)) }
    for ((id, said) in here) out.add(arrayOf("here:$id", said.first, -60, true))
    return out
  }

  /** Asks the device at `address` to open its Wi-Fi; `done` with nothing once it has. */
  fun wake(address: String, from: String, done: (String?) -> Unit) {
    main.post {
      val adapter = manager()?.adapter
      if (adapter == null || !adapter.isEnabled) return@post done("Bluetooth is off.")
      val device = runCatching { adapter.getRemoteDevice(address) }.getOrNull() ?: return@post done("That device has gone.")
      enqueue { next ->
        talk(device, SERVICE, OPEN, write = from.toByteArray()) { _, why ->
          next()
          done(why)
        }
      }
    }
  }

  private fun enqueue(step: (() -> Unit) -> Unit) {
    queue.addLast(step)
    pump()
  }

  private fun pump() {
    if (busy) return
    val step = queue.removeFirstOrNull() ?: return
    busy = true
    step {
      main.post {
        busy = false
        pump()
      }
    }
  }

  /**
   * One GATT conversation: connect, find `service`, then read `which`
   * (`write` null) or write it and wait for its answer. `done(read, why)` once.
   */
  private fun talk(device: BluetoothDevice, service: UUID, which: UUID, write: ByteArray?, done: (String?, String?) -> Unit) {
    var finished = false
    var gatt: BluetoothGatt? = null
    lateinit var timeout: Runnable
    fun end(read: String?, why: String?) {
      if (finished) return
      finished = true
      main.removeCallbacks(timeout)
      runCatching { gatt?.disconnect() }
      runCatching { gatt?.close() }
      done(read, why)
    }
    val callback = object : BluetoothGattCallback() {
      override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
        main.post {
          if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
            // Bigger packets first, so a device's details go in one write
            // (Windows asks by itself); looked at once they're agreed.
            if (write == null || !g.requestMtu(MTU)) {
              if (!g.discoverServices()) end(null, "Bluetooth couldn't look at that device.")
            }
          } else {
            end(null, "Bluetooth lost that device ($status).")
          }
        }
      }

      override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
        main.post {
          if (!finished && !g.discoverServices()) end(null, "Bluetooth couldn't look at that device.")
        }
      }

      override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
        main.post {
          val ch = g.getService(service)?.getCharacteristic(which)
          if (status != BluetoothGatt.GATT_SUCCESS || ch == null) {
            end(null, "That device isn't ready for Basalt any more.")
            return@post
          }
          if (write == null) {
            if (!g.readCharacteristic(ch)) end(null, "Bluetooth couldn't ask who it is.")
          } else {
            ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            @Suppress("DEPRECATION")
            ch.value = write
            @Suppress("DEPRECATION")
            if (!g.writeCharacteristic(ch)) end(null, "Bluetooth couldn't ask that device.")
          }
        }
      }

      @Deprecated("Deprecated in Java")
      override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
        @Suppress("DEPRECATION")
        val value = characteristic.value
        main.post {
          if (status == BluetoothGatt.GATT_SUCCESS && value != null) end(String(value), null)
          else end(null, "Bluetooth couldn't read who it is ($status).")
        }
      }

      override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
        main.post {
          if (status == BluetoothGatt.GATT_SUCCESS) end(null, null)
          else end(null, "That device couldn't open its Wi-Fi.")
        }
      }
    }
    timeout = Runnable { end(null, "That device didn't answer over Bluetooth.") }
    // Opening its Wi-Fi takes the other device a few seconds more.
    main.postDelayed(timeout, if (which == OPEN) 40_000L else STEP_MS)
    gatt = runCatching {
      if (Build.VERSION.SDK_INT >= 23) device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
      else device.connectGatt(context, false, callback)
    }.getOrNull()
    if (gatt == null) end(null, "Bluetooth couldn't reach that device.")
  }

  private fun log(line: String) {
    Log.i(TAG, line)
  }
}
