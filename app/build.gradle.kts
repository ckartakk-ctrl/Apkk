plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cihad.kitapokuyucu"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.cihad.kitapokuyucu"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    signingConfigs {
        // Her derlemede aynı imza kullanılsın ki güncelleme eskisinin üstüne kurulabilsin.
        create("app") {
            storeFile = file("../keystore/app.jks")
            storePassword = "kitapokuyucu"
            keyAlias = "app"
            keyPassword = "kitapokuyucu"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("app")
        }
        debug { signingConfig = signingConfigs.getByName("app") }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
