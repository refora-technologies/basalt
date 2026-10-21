import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

/*
 * The key releases are signed with. It lives outside the repository, in the
 * home folder of the machine that builds releases, and must be kept: Android
 * installs an update only over an app signed with the same key, so a lost key
 * means everyone reinstalling. Without it, a release build is left unsigned.
 * BASALT_SIGNING points somewhere else if the key is kept elsewhere.
 */
val signing = Properties().apply {
    val where = System.getenv("BASALT_SIGNING")
        ?: "${System.getProperty("user.home")}/.basalt/android-signing/keystore.properties"
    val propFile = file(where)
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "app.basalt.client"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        // The name Android installs the app under, and the one Google Play will
        // keep for good. The code itself still lives in app.basalt.client,
        // which is Tauri's identifier and also the Windows apps'; changing
        // that would make Windows install Basalt a second time beside itself.
        applicationId = "com.reforatech.basalt"
        minSdk = 26
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            // The Google Play build (BASALT_CHANNEL=play) leaves out the
            // permission the GitHub build installs its own updates with.
            if (System.getenv("BASALT_CHANNEL") == "play") {
                sourceSets.getByName("release").manifest.srcFile("src/play/AndroidManifest.xml")
            }
            // 64-bit ARM, which is every phone of the last several years, and
            // 32-bit ARM, which many televisions and TV sticks still run even
            // on 64-bit chips (Chromecast with Google TV among them): without
            // it Google Play shows them Basalt as incompatible. Play sends
            // each device only its own, so phones download nothing more. The
            // player's x86 libraries are only for emulators.
            ndk {
                abiFilters.clear()
                abiFilters.add("arm64-v8a")
                abiFilters.add("armeabi-v7a")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// A release packs the player for every processor in its abiFilters, and the
// app's own code must be built for each of them too, or a device of a missing
// kind is offered an app that cannot start. Tauri builds only the `--target`s
// it is given: npx tauri android build --target aarch64 --target armv7.
if (gradle.startParameter.taskNames.any { it.contains("Release") }) {
    val built = (findProperty("targetList") as? String)?.split(',')
        ?: listOf("aarch64", "armv7", "i686", "x86_64")
    val needs = mapOf("arm64-v8a" to "aarch64", "armeabi-v7a" to "armv7", "x86" to "i686", "x86_64" to "x86_64")
    val missing = android.buildTypes.getByName("release").ndk.abiFilters
        .mapNotNull { needs[it] }
        .filter { it !in built }
    require(missing.isEmpty()) {
        "This release would carry no Basalt code for ${missing.joinToString()}: " +
            "build with " + missing.joinToString(" ") { "--target $it" } + " as well."
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")