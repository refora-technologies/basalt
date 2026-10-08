package app.basalt.android

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * This device's key, in the phone's hardware key store.
 *
 * Made inside the store and never readable from it: the app asks it to sign,
 * and that is all. Not in StrongBox, the separate security chip some phones
 * have: a device signs once per host every few hours, and StrongBox takes a
 * large part of a second each time; the store's ordinary hardware is as
 * unreadable from the app and quick.
 *
 * Only Rust calls these. They are not in the commands the interface may use,
 * so no page can ask the key to sign anything.
 */
object DeviceKeys {
  private const val STORE = "AndroidKeyStore"

  private fun store(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

  /** Makes a P-256 signing key under [alias], replacing any there. Its public half. */
  fun create(alias: String): ByteArray {
    val store = store()
    if (store.containsAlias(alias)) store.deleteEntry(alias)
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .build()
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE)
    generator.initialize(spec)
    return generator.generateKeyPair().public.encoded
  }

  /** The public half of the key under [alias], as SubjectPublicKeyInfo; null if there is none. */
  fun public(alias: String): ByteArray? {
    val store = store()
    if (!store.containsAlias(alias)) return null
    return store.getCertificate(alias)?.publicKey?.encoded
  }

  /** Signs [message] with SHA-256 and the key under [alias]. The signature in DER. */
  fun sign(alias: String, message: ByteArray): ByteArray {
    val key = store().getKey(alias, null) as? PrivateKey
      ?: throw IllegalStateException("missing")
    return Signature.getInstance("SHA256withECDSA").run {
      initSign(key)
      update(message)
      sign()
    }
  }

  fun delete(alias: String) {
    val store = store()
    if (store.containsAlias(alias)) store.deleteEntry(alias)
  }

  fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

  fun unhex(text: String): ByteArray {
    require(text.length % 2 == 0) { "hex has an odd length" }
    return ByteArray(text.length / 2) { i ->
      text.substring(i * 2, i * 2 + 2).toInt(16).toByte()
    }
  }
}
