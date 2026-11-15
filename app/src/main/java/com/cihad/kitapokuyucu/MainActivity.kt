package com.cihad.kitapokuyucu

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : Activity() {

    private lateinit var web: WebView
    private val booksDir: File by lazy { File(filesDir, "books").apply { mkdirs() } }
    private var pageReady = false
    private var pendingImport: Uri? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/books/", WebViewAssetLoader.InternalStoragePathHandler(this, booksDir))
            .build()

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#F8F1E3"))
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            textZoom = 100
        }
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != "appassets.androidplatform.net"

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingImport?.let { importBook(it) }
                pendingImport = null
            }
        }
        web.addJavascriptInterface(Bridge(), "Android")
        setContentView(web)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // okurken ekran kararmasın
        hideSystemBars()

        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_VIEW) {
            val uri = intent.data ?: return
            if (pageReady) importBook(uri) else pendingImport = uri
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.handleBack ? window.handleBack() : false") { handled ->
            if (handled != "true") finish()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK && resultCode == RESULT_OK) data?.data?.let { importBook(it) }
    }

    private fun displayName(uri: Uri): String {
        var name: String? = null
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) name = c.getString(0)
            }
        } catch (_: Exception) {
        }
        return name ?: uri.lastPathSegment ?: "kitap.epub"
    }

    /** Seçilen EPUB ya da PDF'i uygulamanın kendi klasörüne kopyalar; böylece kitap kitaplıkta kalır. */
    private fun importBook(uri: Uri) {
        Thread {
            try {
                val original = displayName(uri)
                val tmp = File(booksDir, "import.tmp")
                contentResolver.openInputStream(uri)!!.use { input ->
                    tmp.outputStream().use { input.copyTo(it) }
                }
                // Tür dosyanın ilk baytlarından anlaşılır: EPUB bir zip'tir ("PK"), PDF "%PDF" ile başlar
                val head = ByteArray(4)
                tmp.inputStream().use { it.read(head) }
                val ext = when {
                    head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte() -> ".epub"
                    String(head, Charsets.ISO_8859_1) == "%PDF" -> ".pdf"
                    else -> null
                }
                if (ext == null) {
                    tmp.delete()
                    js("window.onImportError(${JSONObject.quote("Bu dosya EPUB ya da PDF değil: $original")})")
                    return@Thread
                }
                val safe = original.replace(Regex("\\.(epub|pdf)$", RegexOption.IGNORE_CASE), "")
                    .replace(Regex("[^A-Za-z0-9._-]"), "_").takeLast(50)
                val id = System.currentTimeMillis().toString(36) + "_" + safe + ext
                tmp.renameTo(File(booksDir, id))
                File(booksDir, "$id.name").writeText(original)
                js("window.onBookImported(${JSONObject.quote(id)})")
            } catch (e: Exception) {
                js("window.onImportError(${JSONObject.quote("Dosya eklenemedi")})")
            }
        }.start()
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    inner class Bridge {
        @JavascriptInterface
        fun listBooks(): String {
            val arr = JSONArray()
            booksDir.listFiles { f -> f.name.endsWith(".epub", true) || f.name.endsWith(".pdf", true) }
                ?.sortedByDescending { it.lastModified() }
                ?.forEach { f ->
                    val nameFile = File(booksDir, f.name + ".name")
                    arr.put(JSONObject().put("id", f.name)
                        .put("name", if (nameFile.exists()) nameFile.readText() else f.name))
                }
            return arr.toString()
        }

        @JavascriptInterface
        fun pickBook() = runOnUiThread {
            val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/epub+zip", "application/pdf", "application/octet-stream", "application/zip"))
            }
            @Suppress("DEPRECATION")
            startActivityForResult(i, PICK)
        }

        @JavascriptInterface
        fun deleteBook(id: String) {
            val f = File(booksDir, File(id).name)
            f.delete()
            File(booksDir, f.name + ".name").delete()
        }

        /** PDF'ten üretilen EPUB'u kitaplığa yazar; yeni dosyanın kimliğini döndürür. */
        @JavascriptInterface
        fun saveEpub(name: String, base64: String): String {
            return try {
                val safe = name.replace(Regex("\\.epub$", RegexOption.IGNORE_CASE), "")
                    .replace(Regex("[^A-Za-z0-9._-]"), "_").takeLast(50)
                val id = System.currentTimeMillis().toString(36) + "_" + safe + ".epub"
                File(booksDir, id).writeBytes(android.util.Base64.decode(base64, android.util.Base64.DEFAULT))
                File(booksDir, "$id.name").writeText(name)
                id
            } catch (e: Exception) {
                ""
            }
        }

        @JavascriptInterface
        fun share(text: String) = runOnUiThread {
            val i = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            startActivity(Intent.createChooser(i, "İşaretlerimi paylaş"))
        }
    }

    companion object {
        private const val PICK = 41
    }
}
