plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// The Google Play build (BASALT_CHANNEL=play) gets Play's own update and
// rating services; every other build gets a stand-in with the same shape and
// no Google library, which is not open source. See PlayServices.kt in each.
val playBuild = System.getenv("BASALT_CHANNEL") == "play"

android {
    namespace = "app.basalt.android"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }

    sourceSets.getByName("main").java.srcDir(if (playBuild) "src/play/java" else "src/github/java")
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    // mpv, built for Android: the same player the desktop uses.
    implementation("dev.jdtech.mpv:libmpv:0.5.1")
    implementation(project(":tauri-android"))
    if (playBuild) {
        implementation("com.google.android.play:app-update:2.1.0")
        implementation("com.google.android.play:review:2.0.2")
    }
}
