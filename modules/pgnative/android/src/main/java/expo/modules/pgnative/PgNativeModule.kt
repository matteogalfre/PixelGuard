package expo.modules.pgnative

import android.app.Activity
import android.app.NotificationManager
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.MediaStore
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions
import com.hierynomus.msdtyp.AccessMask
import com.hierynomus.mserref.NtStatus
import com.hierynomus.msfscc.FileAttributes
import com.hierynomus.mssmb2.SMB2CreateDisposition
import com.hierynomus.mssmb2.SMB2ShareAccess
import com.hierynomus.mssmb2.SMBApiException
import com.hierynomus.protocol.transport.TransportException
import com.hierynomus.smbj.SMBClient
import com.hierynomus.smbj.common.SMBRuntimeException
import com.hierynomus.smbj.auth.AuthenticationContext
import com.hierynomus.smbj.connection.Connection
import com.hierynomus.smbj.session.Session
import com.hierynomus.smbj.share.DiskShare
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.EnumSet
import java.util.concurrent.atomic.AtomicBoolean

class SmbSettings : Record {
  @Field var host: String = ""
  @Field var share: String = ""
  @Field var user: String = ""
  @Field var password: String = ""
  @Field var encrypt: Boolean = true
  /** Nom NetBIOS du PC appairé ("" : pas encore connu). */
  @Field var identity: String = ""
}

/** Une page donnée par le petit serveur web (le fichier de préparation, et sa page). */
class ServedPage : Record {
  @Field var path: String = "/"
  @Field var type: String = "text/plain"
  @Field var body: String = ""
  @Field var download: String = ""
}

private class PgError(code: String, message: String) : CodedException(code, message, null)

// Le natif de PixelGuard : galerie (MediaStore), dossier partagé du PC (SMB 2/3, cœur dans
// SmbCore.java), découverte des PC du réseau, vérification octet par octet et corbeille Android.
class PgNativeModule : Module() {
  private val cancelled = AtomicBoolean(false)
  private val smbLock = Any()
  private var client: SMBClient? = null
  private var connection: Connection? = null
  private var session: Session? = null
  private var share: DiskShare? = null
  private var settings: SmbSettings? = null
  private var maxWrite = SmbCore.CHUNK
  private var maxRead = SmbCore.CHUNK
  private var pendingRemoval: Promise? = null
  private var pendingUris: List<String> = emptyList()
  private var pendingScan: Promise? = null
  private var http: MiniServer? = null
  private val textLock = Any()
  private var wifiLock: WifiManager.WifiLock? = null
  private var wifiLockPerf: WifiManager.WifiLock? = null

  private val httpLock = Any()

  private val context: Context
    get() = appContext.reactContext ?: throw PgError("NO_CONTEXT", "Contexte Android indisponible")

  private val cancel = SmbCore.Cancel { cancelled.get() }

  override fun definition() = ModuleDefinition {
    Name("PgNative")
    Events("onProgress", "onStopRequested")

    OnCreate {
      TransferService.onStopRequested = { reason ->
        cancelled.set(true)
        sendEvent("onStopRequested", mapOf<String, Any?>("reason" to reason))
      }
    }

    // ---------- Galerie

    AsyncFunction("listAlbums") Coroutine { ->
      withContext(Dispatchers.IO) { listAlbums() }
    }

    AsyncFunction("listMedia") Coroutine { bucketIds: List<String> ->
      withContext(Dispatchers.IO) { listMedia(bucketIds) }
    }

    AsyncFunction("galleryVersion") Coroutine { ->
      withContext(Dispatchers.IO) { galleryVersion() }
    }

    // ---------- Trouver le PC

    AsyncFunction("discover") Coroutine { ->
      withContext(Dispatchers.IO) { discover() }
    }

    AsyncFunction("probe") Coroutine { host: String ->
      withContext(Dispatchers.IO) {
        val (h, port) = cleanHost(host)
        try {
          probe(wifi(), localAddress(h).hostAddress ?: h, port, 1500)
        } catch (e: Exception) {
          false
        }
      }
    }

    // ---------- Dossier partagé

    AsyncFunction("login") Coroutine { s: SmbSettings ->
      withContext(Dispatchers.IO) { guard { synchronized(smbLock) { login(s, strict = false) } } }
    }

    AsyncFunction("connect") Coroutine { s: SmbSettings ->
      withContext(Dispatchers.IO) { guard { synchronized(smbLock) { connect(s) } } }
    }

    AsyncFunction("disconnect") Coroutine { ->
      withContext(Dispatchers.IO) {
        synchronized(smbLock) { closeAll() }
        true
      }
    }

    AsyncFunction("list") Coroutine { dir: String ->
      withContext(Dispatchers.IO) {
        guard {
          SmbCore.list(ensureShare(), dir).map {
            mapOf(
              "name" to it.fileName,
              "size" to it.endOfFile.toDouble(),
              "dir" to ((it.fileAttributes and FileAttributes.FILE_ATTRIBUTE_DIRECTORY.value) != 0L),
            )
          }
        }
      }
    }

    AsyncFunction("statFiles") Coroutine { paths: List<String> ->
      withContext(Dispatchers.IO) { guard { SmbCore.stat(ensureShare(), paths).map { it.toDouble() } } }
    }

    AsyncFunction("mkdirs") Coroutine { dir: String ->
      withContext(Dispatchers.IO) {
        guard { SmbCore.mkdirs(ensureShare(), dir) }
        true
      }
    }

    AsyncFunction("testWrite") Coroutine { dir: String ->
      withContext(Dispatchers.IO) { guard { testWrite(dir) } }
    }

    AsyncFunction("speedTest") Coroutine { dir: String, megabytes: Int ->
      withContext(Dispatchers.IO) { guard { speedTest(dir, megabytes) } }
    }

    AsyncFunction("upload") Coroutine { uri: String, remotePath: String, size: Double, transferId: String, sourceKey: String ->
      withContext(Dispatchers.IO) { guard { upload(uri, remotePath, size.toLong(), transferId, sourceKey) } }
    }

    AsyncFunction("verify") Coroutine { uri: String, remotePath: String, size: Double, expectedMd5: String ->
      withContext(Dispatchers.IO) { guard { verify(uri, remotePath, size.toLong(), expectedMd5) } }
    }

    Function("cancel") { cancelled.set(true) }
    Function("resetCancel") { cancelled.set(false) }

    // Sans ce verrou, Android met le Wi-Fi en économie d'énergie entre deux paquets.
    Function("holdWifi") { on: Boolean -> holdWifi(on) }

    // ---------- Écran éteint : service de premier plan

    Function("startTransferService") { title: String, text: String, stopLabel: String ->
      startService(title, text, stopLabel)
    }

    Function("updateTransferService") { text: String, progress: Int, max: Int ->
      val ctx = context
      val title = serviceTitle
      // Seulement tant que le service tient le premier plan : après la limite de 6 h ou un refus,
      // une notification « en cours » resterait affichée sans service derrière.
      if (serviceRunning && TransferService.active) {
        ctx.getSystemService(NotificationManager::class.java)
          .notify(TransferService.NOTIFICATION_ID, TransferService.build(ctx, title, text, progress, max, true))
      }
    }

    Function("stopTransferService") { title: String, finalText: String ->
      stopService(title, finalText)
    }

    // ---------- Libérer de la place

    AsyncFunction("removeFromPhone") { uris: List<String>, toTrash: Boolean, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
        throw PgError("OLD_ANDROID", "Il faut Android 11 ou plus récent")
      }
      val activity = appContext.currentActivity ?: throw PgError("NO_ACTIVITY", "Appli pas au premier plan")
      val list = uris.map { Uri.parse(it) }
      val request = if (toTrash) {
        MediaStore.createTrashRequest(context.contentResolver, list, true)
      } else {
        MediaStore.createDeleteRequest(context.contentResolver, list)
      }
      pendingRemoval?.resolve(emptyList<String>())
      pendingRemoval = promise
      pendingUris = uris
      activity.startIntentSenderForResult(request.intentSender, REMOVE_REQUEST, null, 0, 0, 0)
    }.runOnQueue(Queues.MAIN)

    // Le QR affiché par le PC préparé : le texte lu, ou null si on a annulé.
    AsyncFunction("scanQr") { prompt: String, promise: Promise ->
      val activity = appContext.currentActivity ?: throw PgError("NO_ACTIVITY", "Appli pas au premier plan")
      pendingScan?.resolve(null)
      pendingScan = promise
      val options = ScanOptions()
        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setPrompt(prompt)
        .setBeepEnabled(false)
        .setOrientationLocked(false)
      // Sans ScanContract : il dépend d'androidx.activity, absent de la compilation du module.
      activity.startActivityForResult(options.createScanIntent(activity), SCAN_REQUEST)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode == SCAN_REQUEST) {
        pendingScan?.resolve(ScanIntentResult.parseActivityResult(payload.resultCode, payload.data).contents)
        pendingScan = null
      }
      if (payload.requestCode == REMOVE_REQUEST) {
        // Android supprime tout ou rien : on renvoie ce qui est vraiment parti.
        pendingRemoval?.resolve(if (payload.resultCode == Activity.RESULT_OK) pendingUris else emptyList())
        pendingRemoval = null
        pendingUris = emptyList()
      }
    }

    // Le téléphone donne « Prepare my PC » au navigateur du PC, le temps de la préparation.
    AsyncFunction("startPrepServer") Coroutine { pages: List<ServedPage> ->
      withContext(Dispatchers.IO) {
        synchronized(httpLock) {
          http?.stop()
          http = null
          val map = HashMap<String, MiniServer.Page>()
          for (p in pages) map[p.path] = MiniServer.Page(p.type, p.body.toByteArray(Charsets.UTF_8), p.download)
          // Seulement sur l'adresse du Wi-Fi : pas de Wi-Fi, pas de serveur.
          val own = wifi()?.let { ownIpv4(it.second) }
          if (own == null) {
            mapOf("ip" to null, "port" to 0)
          } else {
            val server = MiniServer(8800, map, own)
            http = server
            mapOf("ip" to own.hostAddress, "port" to server.port())
          }
        }
      }
    }

    AsyncFunction("stopPrepServer") Coroutine { ->
      withContext(Dispatchers.IO) {
        synchronized(httpLock) {
          http?.stop()
          http = null
        }
        true
      }
    }

    OnDestroy {
      synchronized(httpLock) { http?.stop() }
      holdWifi(false)
      TransferService.onStopRequested = null
      synchronized(smbLock) { closeAll() }
    }

    // ---------- Petit stockage de fichiers texte (index des copies)

    AsyncFunction("saveText") Coroutine { name: String, text: String ->
      withContext(Dispatchers.IO) {
        // Une écriture à la fois, chacune dans son propre fichier temporaire, puis remplacement
        // d'un coup : deux enregistrements simultanés ne peuvent plus se mélanger.
        synchronized(textLock) {
          if (!writeAtomic(privateFile(name), text)) throw PgError("SAVE", "Impossible d'enregistrer $name")
        }
        true
      }
    }

    AsyncFunction("loadText") Coroutine { name: String ->
      withContext(Dispatchers.IO) {
        val f = privateFile(name)
        if (f.isFile) f.readText() else null
      }
    }
  }

  // Traduit les erreurs SMB en messages lisibles, avec un code que le JS sait traiter. Seule une
  // vraie coupure réseau ferme la connexion : les autres envois en cours continuent.
  private inline fun <T> guard(block: () -> T): T {
    try {
      return block()
    } catch (e: SMBApiException) {
      // Session fermée par le PC (15 min sans rien, redémarrage du service) : c'est une coupure,
      // le prochain appel rouvre une connexion.
      if (sessionGone(e)) {
        dropConnection()
        throw PgError("CONNECTION", "Connexion au PC perdue")
      }
      throw PgError("SMB", "Le PC refuse : ${e.status}")
    } catch (e: CodedException) {
      throw e
    } catch (e: SmbCore.Exists) {
      throw PgError("EXISTS", e.message ?: "Existe déjà")
    } catch (e: SmbCore.Cancelled) {
      throw PgError("CANCELLED", "Arrêté")
    } catch (e: SmbCore.Busy) {
      throw PgError("BUSY", e.message ?: "Fichier occupé")
    } catch (e: SMBRuntimeException) {
      dropConnection()
      throw PgError("CONNECTION", "Connexion au PC perdue")
    } catch (e: TransportException) {
      dropConnection()
      throw PgError("CONNECTION", "Connexion au PC perdue")
    } catch (e: java.net.SocketException) {
      dropConnection()
      throw PgError("CONNECTION", "Connexion au PC perdue")
    } catch (e: IOException) {
      throw PgError("TRANSFER", e.message ?: "Erreur de transfert")
    } finally {
      used.remove()
    }
  }

  private fun sessionGone(e: SMBApiException): Boolean =
    e.status == NtStatus.STATUS_USER_SESSION_DELETED ||
      e.status == NtStatus.STATUS_NETWORK_SESSION_EXPIRED ||
      e.status == NtStatus.STATUS_NETWORK_NAME_DELETED

  // La connexion qu'utilise l'appel en cours sur ce fil. Quand il échoue, on ne ferme qu'elle :
  // jamais une connexion plus récente qu'un autre envoi vient de rouvrir.
  private val used = ThreadLocal<Connection?>()

  private fun dropConnection() {
    val failed = used.get()
    synchronized(smbLock) { if (failed == null || failed === connection) closeAll() }
  }

  // ===================== Galerie

  private fun mediaRows(selection: String, args: Array<String>?): List<Map<String, Any?>> {
    val projection = arrayOf(
      MediaStore.Files.FileColumns._ID,
      MediaStore.Files.FileColumns.DISPLAY_NAME,
      MediaStore.Files.FileColumns.SIZE,
      MediaStore.Files.FileColumns.DATE_TAKEN,
      MediaStore.Files.FileColumns.DATE_MODIFIED,
      MediaStore.Files.FileColumns.MEDIA_TYPE,
      MediaStore.Files.FileColumns.BUCKET_ID,
      MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME,
      MediaStore.Files.FileColumns.RELATIVE_PATH,
    )
    val out = ArrayList<Map<String, Any?>>()
    val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
    context.contentResolver.query(
      collection, projection, selection, args,
      "${MediaStore.Files.FileColumns.DATE_TAKEN} DESC"
    )?.use { c ->
      val iId = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
      val iName = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DISPLAY_NAME)
      val iSize = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.SIZE)
      val iTaken = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_TAKEN)
      val iMod = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_MODIFIED)
      val iType = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
      val iBucket = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.BUCKET_ID)
      val iBucketName = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME)
      val iRel = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.RELATIVE_PATH)
      while (c.moveToNext()) {
        val id = c.getLong(iId)
        val video = c.getInt(iType) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        val base = if (video) {
          MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
          MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        }
        out.add(
          mapOf(
            "id" to id.toString(),
            "name" to (c.getString(iName) ?: ""),
            "size" to c.getLong(iSize).toDouble(),
            "taken" to (if (c.isNull(iTaken)) 0.0 else c.getLong(iTaken).toDouble()),
            "modified" to c.getLong(iMod).toDouble() * 1000.0,
            "video" to video,
            "bucketId" to (c.getString(iBucket) ?: ""),
            "bucketName" to (c.getString(iBucketName) ?: ""),
            "relativePath" to (c.getString(iRel) ?: ""),
            "uri" to ContentUris.withAppendedId(base, id).toString(),
          )
        )
      }
    }
    return out
  }

  // Change dès qu'une photo arrive, part ou change (compteur de MediaStore, par volume), ou que
  // l'accès aux photos change : tant qu'il ne bouge pas, le JS garde sa copie de la galerie.
  private fun galleryVersion(): String = try {
    val ctx = context
    val volumes = MediaStore.getExternalVolumeNames(ctx).sorted()
      .joinToString(",") { "$it=${MediaStore.getGeneration(ctx, it)}" }
    val access = listOf(
      android.Manifest.permission.READ_MEDIA_IMAGES,
      android.Manifest.permission.READ_MEDIA_VIDEO,
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
      android.Manifest.permission.READ_EXTERNAL_STORAGE,
    ).joinToString("") { if (ctx.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED) "1" else "0" }
    "${MediaStore.getVersion(ctx)}|$volumes|$access"
  } catch (e: Exception) {
    "" // inconnue : le JS relit la galerie à chaque fois
  }

  private val mediaSelection =
    "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (" +
      "${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"

  private fun listAlbums(): List<Map<String, Any?>> {
    data class Acc(val id: String, val name: String, val path: String, val cover: String, var count: Int = 0, var bytes: Double = 0.0)
    val albums = LinkedHashMap<String, Acc>()
    // Seulement les colonnes utiles, sans fiche par média : sur 50 000 photos, ça compte.
    val projection = arrayOf(
      MediaStore.Files.FileColumns._ID,
      MediaStore.Files.FileColumns.SIZE,
      MediaStore.Files.FileColumns.MEDIA_TYPE,
      MediaStore.Files.FileColumns.BUCKET_ID,
      MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME,
      MediaStore.Files.FileColumns.RELATIVE_PATH,
    )
    // Trié du plus récent au plus ancien : la première photo vue sert de couverture.
    context.contentResolver.query(
      MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL), projection, mediaSelection, null,
      "${MediaStore.Files.FileColumns.DATE_TAKEN} DESC"
    )?.use { c ->
      val iId = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
      val iSize = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.SIZE)
      val iType = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
      val iBucket = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.BUCKET_ID)
      val iBucketName = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME)
      val iRel = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.RELATIVE_PATH)
      while (c.moveToNext()) {
        val id = c.getString(iBucket) ?: ""
        var acc = albums[id]
        if (acc == null) {
          val video = c.getInt(iType) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
          val base = if (video) {
            MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
          } else {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
          }
          acc = Acc(id, c.getString(iBucketName) ?: "", c.getString(iRel) ?: "", ContentUris.withAppendedId(base, c.getLong(iId)).toString())
          albums[id] = acc
        }
        acc.count += 1
        acc.bytes += c.getLong(iSize).toDouble()
      }
    }
    return albums.values
      .sortedByDescending { it.count }
      .map {
        mapOf("id" to it.id, "name" to it.name, "path" to it.path, "count" to it.count, "bytes" to it.bytes, "cover" to it.cover)
      }
  }

  private fun listMedia(bucketIds: List<String>): List<Map<String, Any?>> {
    if (bucketIds.isEmpty()) return emptyList()
    val marks = bucketIds.joinToString(",") { "?" }
    val selection = "$mediaSelection AND ${MediaStore.Files.FileColumns.BUCKET_ID} IN ($marks)"
    return mediaRows(selection, bucketIds.toTypedArray())
  }

  // Sans la permission « position des médias », Android retire le GPS des photos qu'on lit.
  // On refuse plutôt que de copier (et vérifier) une version amputée de l'original.
  // `expected` (≥ 0) : la taille donnée par MediaStore, qui peut être périmée (fichier retouché,
  // pas encore relu). Elle est comparée à la vraie, lue sur le fichier qu'on ouvre de toute façon :
  // sinon l'envoi échouerait à chaque fois en « copie incomplète ».
  private fun openOriginal(uriString: String, expected: Long = -1): InputStream {
    val uri = Uri.parse(uriString)
    val original = try {
      MediaStore.setRequireOriginal(uri)
    } catch (e: Exception) {
      throw PgError("NO_ORIGINAL", "Impossible de lire l'original : ${e.message}")
    }
    val fd = try {
      context.contentResolver.openFileDescriptor(original, "r")
    } catch (e: SecurityException) {
      throw PgError("NO_MEDIA_LOCATION", "Autorise l'accès à la position des médias pour garder le GPS des photos")
    } catch (e: java.io.FileNotFoundException) {
      null
    } ?: throw PgError("NO_FILE", "Fichier introuvable sur le téléphone")
    val real = fd.statSize
    if (expected >= 0 && real >= 0 && real != expected) {
      fd.close()
      throw PgError("CHANGED", "Ce fichier a changé sur le téléphone depuis la liste : il partira à la prochaine sauvegarde")
    }
    return android.os.ParcelFileDescriptor.AutoCloseInputStream(fd)
  }

  // ===================== Trouver le PC

  private fun cleanHost(raw: String): Pair<String, Int> {
    val h = raw.trim().removePrefix("\\\\").removePrefix("smb://").trimEnd('/', '\\')
    val colon = h.lastIndexOf(':')
    return if (colon > 0 && h.substring(colon + 1).all { it.isDigit() }) {
      h.substring(0, colon) to h.substring(colon + 1).toInt()
    } else {
      h to 445
    }
  }

  /**
   * Le réseau Wi-Fi, même quand Android passe par ailleurs par défaut (VPN, Wi-Fi « sans
   * Internet » doublé par les données mobiles). Null s'il n'y en a pas : réseau par défaut.
   */
  @Suppress("DEPRECATION")
  private fun wifi(): Pair<Network, LinkProperties>? {
    val cm = context.getSystemService(ConnectivityManager::class.java)
    fun isWifi(n: Network?) = n != null && cm.getNetworkCapabilities(n)?.let {
      it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    } == true
    val active = cm.activeNetwork
    val net = if (isWifi(active)) active else cm.allNetworks.firstOrNull { isWifi(it) }
    val lp = net?.let { cm.getLinkProperties(it) } ?: return null
    return net to lp
  }

  private fun ownIpv4(lp: LinkProperties): Inet4Address? =
    lp.linkAddresses.map { it.address }.filterIsInstance<Inet4Address>().firstOrNull()

  private fun probe(wifi: Pair<Network, LinkProperties>?, host: String, port: Int, timeoutMs: Int): Boolean = try {
    val socket = wifi?.first?.socketFactory?.createSocket() ?: Socket()
    socket.use { it.connect(InetSocketAddress(host, port), timeoutMs) }
    true
  } catch (e: Exception) {
    false
  }

  private fun netbiosName(network: Network?, ip: String): String? = try {
    DatagramSocket().use { s ->
      network?.bindSocket(s)
      s.soTimeout = 700
      val q = SmbCore.nbstatQuery((System.nanoTime() and 0x7fff).toInt())
      s.send(DatagramPacket(q, q.size, InetAddress.getByName(ip), 137))
      val buf = ByteArray(1024)
      val p = DatagramPacket(buf, buf.size)
      s.receive(p)
      SmbCore.nbstatName(buf, p.length)
    }
  } catch (e: SocketTimeoutException) {
    null
  } catch (e: Exception) {
    null
  }

  private fun dnsName(ip: String): String? = try {
    val n = InetAddress.getByName(ip).canonicalHostName
    if (n == ip) null else n.substringBefore('.')
  } catch (e: Exception) {
    null
  }

  // Essaie le port SMB (445) sur toutes les adresses du réseau Wi-Fi, 64 à la fois : le vrai
  // masque du réseau (de /22 à /30), sinon les 254 voisins d'un /24.
  private suspend fun discover(): List<Map<String, Any?>> = coroutineScope {
    val w = wifi() ?: throw PgError("NO_WIFI", "Pas de Wi-Fi : connecte le téléphone au Wi-Fi de la maison")
    val linkAddress = w.second.linkAddresses.firstOrNull { it.address is Inet4Address }
      ?: throw PgError("NO_NETWORK", "Pas d'adresse IPv4 sur ce réseau")
    val own = linkAddress.address as Inet4Address
    val bits = linkAddress.prefixLength.coerceIn(22, 30).let { if (linkAddress.prefixLength < 22) 24 else it }
    val b = own.address
    val ownInt = ((b[0].toInt() and 255) shl 24) or ((b[1].toInt() and 255) shl 16) or
      ((b[2].toInt() and 255) shl 8) or (b[3].toInt() and 255)
    val mask = if (bits == 0) 0 else (-1 shl (32 - bits))
    val base = ownInt and mask
    val hosts = (1 until (1 shl (32 - bits)) - 1).map { base + it }.filter { it != ownInt }
    fun dotted(v: Int) = "${(v ushr 24) and 255}.${(v ushr 16) and 255}.${(v ushr 8) and 255}.${v and 255}"
    val gate = Semaphore(64)
    val open = hosts
      .map { dotted(it) }
      .map { ip -> async(Dispatchers.IO) { gate.withPermit { if (probe(w, ip, 445, 400)) ip else null } } }
      .awaitAll()
      .filterNotNull()
    open.map { ip ->
      async(Dispatchers.IO) {
        // Le DNS inverse peut traîner : il tourne à part et on ne l'attend pas plus d'une seconde.
        val name = netbiosName(w.first, ip) ?: run {
          val dns = CoroutineScope(Dispatchers.IO).async { dnsName(ip) }
          withTimeoutOrNull(1000) { dns.await() }
        }
        mapOf("ip" to ip, "name" to (name ?: ""))
      }
    }.awaitAll()
  }

  // ===================== SMB

  private fun closeAll() {
    try { share?.close() } catch (_: Exception) {}
    try { session?.close() } catch (_: Exception) {}
    try { connection?.close(true) } catch (_: Exception) {}
    try { client?.close() } catch (_: Exception) {}
    share = null
    session = null
    connection = null
    client = null
  }

  // Réseau local seulement : on résout le nom une fois, on vérifie que c'est une adresse
  // privée, et on se connecte à cette adresse-là (pas de seconde résolution).
  private fun localAddress(host: String): InetAddress {
    val network = wifi()?.first
    val all = try {
      (network?.getAllByName(host) ?: InetAddress.getAllByName(host)).toList()
    } catch (e: Exception) {
      throw PgError("UNREACHABLE", "PC introuvable ($host). Il est allumé, sur le même Wi-Fi ?")
    }
    return all.firstOrNull { isLocal(it) }
      ?: throw PgError("NOT_LOCAL", "« $host » n'est pas une adresse de ton réseau local. PixelGuard n'envoie rien sur Internet.")
  }

  private fun isLocal(a: InetAddress): Boolean {
    if (a.isSiteLocalAddress || a.isLinkLocalAddress || a.isLoopbackAddress) return true
    val b = a.address
    // IPv6 locales uniques (fc00::/7)
    return b.size == 16 && (b[0].toInt() and 0xfe) == 0xfc
  }

  // Le nom annoncé par le PC de la dernière connexion, et son adresse : il fait foi tant que
  // l'appli n'a pas encore enregistré le nom de ce PC.
  private var seenName: String? = null
  private var seenHost: String? = null

  /**
   * `strict` (tout sauf l'appairage) : le PC doit annoncer le nom retenu à l'appairage avant de
   * recevoir l'utilisateur et la réponse au mot de passe. Le chiffrement est contrôlé par connect().
   */
  private fun login(s: SmbSettings, strict: Boolean): Map<String, Any?> {
    closeAll()
    val expected = when {
      !strict -> ""
      s.identity.isNotBlank() -> s.identity
      seenHost == s.host -> seenName ?: ""
      else -> ""
    }
    val pin = SmbCore.Pin(expected)
    // Signature exigée dès qu'il y a un compte, et les sockets du Wi-Fi (pas d'un VPN).
    val c = SMBClient(SmbCore.config(s.encrypt, pin, s.user.isNotBlank(), wifi()?.first?.socketFactory))
    val (host, port) = cleanHost(s.host)
    val address = try {
      localAddress(host)
    } catch (e: Exception) {
      c.close()
      throw e
    }
    val conn = try {
      c.connect(address.hostAddress, port)
    } catch (e: IOException) {
      c.close()
      throw PgError("UNREACHABLE", "PC injoignable ($host). Il est allumé, sur le même Wi-Fi ?")
    }
    val user = s.user.trim()
    val auth = when {
      user.isEmpty() -> AuthenticationContext.guest()
      user.contains('\\') -> AuthenticationContext(
        user.substringAfter('\\'), s.password.toCharArray(), user.substringBefore('\\')
      )
      else -> AuthenticationContext(user, s.password.toCharArray(), null)
    }
    val sess = try {
      conn.authenticate(auth)
    } catch (e: Exception) {
      try { conn.close(true) } catch (_: Exception) {}
      c.close()
      if (pin.mismatch) {
        throw PgError(
          "PC_CHANGED",
          "Ce n'est pas le PC appairé (il s'annonce comme « ${pin.seen} ») : ni ton mot de passe ni tes photos ne sont partis. Si tu as renommé ton PC, refais l'appairage."
        )
      }
      throw PgError("AUTH", "Utilisateur ou mot de passe refusé par le PC")
    }
    seenName = pin.seen
    seenHost = s.host
    client = c
    connection = conn
    session = sess
    settings = s
    val proto = conn.connectionContext.negotiatedProtocol
    maxWrite = proto.maxWriteSize
    maxRead = proto.maxReadSize
    val shares = try {
      SmbCore.listShares(sess, host)
    } catch (e: Exception) {
      null // le PC ne veut pas lister : on tapera le nom à la main
    }
    return mapOf(
      "dialect" to proto.dialect.name,
      "signed" to sess.isSigningRequired,
      "encrypted" to encrypted(sess),
      "shares" to shares,
      "identity" to pin.seen?.ifEmpty { null },
    )
  }

  private fun encrypted(sess: Session?): Boolean = try {
    sess?.shouldEncryptData() == true
  } catch (e: Exception) {
    false
  }

  private fun notEncrypted(): Nothing {
    closeAll()
      throw PgError(
        "NOT_ENCRYPTED",
        "Ce PC n'a pas accepté le chiffrement : rien n'a été envoyé. Chez toi, tu peux couper le chiffrement dans les réglages de ce PC."
      )
  }

  private fun shareName(s: SmbSettings) = s.share.trim().trim('\\', '/')

  // smbj ne voit pas qu'un PC a fermé la connexion (15 min sans rien sous Windows) : un aller-retour
  // le dit, et il échoue tout de suite dans ce cas. Une réponse, même un refus, prouve qu'elle vit.
  // Borné à 5 s : une connexion à moitié ouverte (Wi-Fi changé) ferait sinon attendre 60 à 90 s
  // tous les autres appels, bloqués derrière smbLock.
  private val checker = java.util.concurrent.Executors.newCachedThreadPool { r ->
    Thread(r, "pixelguard-check").apply { isDaemon = true }
  }

  private fun answers(sh: DiskShare): Boolean {
    val f = checker.submit<Boolean> {
      try {
        sh.folderExists("")
        true
      } catch (e: SMBApiException) {
        !sessionGone(e)
      }
    }
    return try {
      f.get(5, java.util.concurrent.TimeUnit.SECONDS)
    } catch (e: Exception) {
      f.cancel(true)
      false
    }
  }

  private fun connect(s: SmbSettings): Map<String, Any?> {
    val sameLogin = settings?.let { it.host == s.host && it.user == s.user && it.password == s.password && it.encrypt == s.encrypt } == true
    val current = share
    val sameIdentity = s.identity.isBlank() || s.identity.equals(seenName, ignoreCase = true)
    if (sameLogin && sameIdentity && connection?.isConnected == true && session != null && current != null && current.isConnected &&
      settings?.let { shareName(it) } == shareName(s)
    ) {
      if (answers(current)) {
        if (s.encrypt && !encrypted(session)) notEncrypted()
        // Déjà connecté à ce partage : on le garde. Le fermer ferait tomber les envois en cours
        // (une comparaison lancée pendant une sauvegarde, par exemple).
        val proto = connection!!.connectionContext.negotiatedProtocol
        return mapOf(
          "dialect" to proto.dialect.name,
          "signed" to session!!.isSigningRequired,
          "encrypted" to encrypted(session),
          "shares" to null,
          "identity" to seenName?.ifEmpty { null },
        )
      }
      closeAll() // fermée par le PC entre-temps : on en refait une
    }
    val alive = sameLogin && sameIdentity && connection?.isConnected == true && session != null
    if (!alive) login(s, strict = true)
    try { share?.close() } catch (_: Exception) {}
    share = null
    val sess = session ?: throw PgError("NOT_CONNECTED", "Pas connecté au PC")
    // smbj continue seulement signé si le PC ne chiffre pas : jamais de repli silencieux.
    if (s.encrypt && !encrypted(sess)) notEncrypted()
    val sh = try {
      sess.connectShare(shareName(s)) as? DiskShare
        ?: throw PgError("NOT_DISK", "« ${s.share} » n'est pas un dossier partagé")
    } catch (e: SMBApiException) {
      throw PgError("SHARE", "Partage « ${s.share} » introuvable ou refusé")
    }
    share = sh
    settings = s
    val proto = connection!!.connectionContext.negotiatedProtocol
    return mapOf(
      "dialect" to proto.dialect.name,
      "signed" to sess.isSigningRequired,
      "encrypted" to encrypted(sess),
      "shares" to null,
      "identity" to seenName?.ifEmpty { null },
    )
  }

  // Rouvre la connexion si le Wi-Fi a coupé entre deux envois.
  private fun ensureShare(): DiskShare = synchronized(smbLock) {
    val sh = share
    if (sh != null && connection?.isConnected == true && sh.isConnected) {
      used.set(connection)
      return sh
    }
    val s = settings ?: throw PgError("NOT_CONNECTED", "Pas connecté au PC")
    closeAll()
    connect(s)
    used.set(connection)
    share ?: throw PgError("NOT_CONNECTED", "Pas connecté au PC")
  }

  private fun testWrite(dir: String): Map<String, Any?> {
    val sh = ensureShare()
    SmbCore.mkdirs(sh, dir)
    val probePath = SmbCore.smbPath(if (dir.isBlank()) ".pixelguard-test" else "$dir/.pixelguard-test")
    val f = sh.openFile(
      probePath,
      EnumSet.of(AccessMask.GENERIC_WRITE, AccessMask.DELETE),
      EnumSet.of(FileAttributes.FILE_ATTRIBUTE_NORMAL),
      SMB2ShareAccess.ALL,
      SMB2CreateDisposition.FILE_OVERWRITE_IF,
      null
    )
    try {
      f.write("ok".toByteArray(), 0)
      f.deleteOnClose()
    } finally {
      f.close()
    }
    return mapOf("ok" to true)
  }

  private fun speedTest(dir: String, megabytes: Int): Map<String, Any?> {
    val sh = ensureShare()
    SmbCore.mkdirs(sh, dir)
    val bytes = megabytes.toLong() shl 20
    val target = if (dir.isBlank()) ".pixelguard-vitesse" else "$dir/.pixelguard-vitesse"
    holdWifi(true)
    val start = System.nanoTime()
    try {
      SmbCore.upload(sh, { SmbCore.noise(bytes) }, target, bytes, maxWrite, false, false, { done ->
        sendEvent("onProgress", mapOf("id" to "speed", "bytes" to done.toDouble()))
      }, cancel)
    } finally {
      holdWifi(false)
    }
    val seconds = (System.nanoTime() - start) / 1e9
    val proto = connection!!.connectionContext.negotiatedProtocol
    val crypto = HybridSecurityProvider().describe("AesCmac")
    return mapOf(
      "bytes" to bytes.toDouble(),
      "seconds" to seconds,
      "dialect" to proto.dialect.name,
      "signed" to (session?.isSigningRequired == true),
      "encrypted" to encrypted(session),
      "signingCrypto" to crypto,
      "maxWrite" to maxWrite,
    )
  }

  // Quel original a écrit chaque « .part » encore sur un PC : on ne reprend que celui-là.
  private val resumeLock = Any()

  private fun resumeKey(remotePath: String): String {
    val s = settings
    return "${s?.host}|${s?.share}|${SmbCore.smbPath(remotePath).lowercase()}"
  }

  // Gardée en mémoire (lue une fois), écrite d'un coup sur le disque à chaque changement.
  private var resumeCache: HashMap<String, String>? = null

  private fun resumeMap(): MutableMap<String, String> {
    resumeCache?.let { return it }
    val f = privateFile("resume.json")
    val out = HashMap<String, String>()
    if (f.isFile) {
      try {
        val json = org.json.JSONObject(f.readText())
        json.keys().forEach { k -> out[k] = json.getString(k) }
      } catch (_: Exception) {}
    }
    resumeCache = out
    return out
  }

  private fun saveResumeMap(map: Map<String, String>) {
    val json = org.json.JSONObject()
    map.forEach { (k, v) -> json.put(k, v) }
    writeAtomic(privateFile("resume.json"), json.toString())
  }

  private fun upload(uri: String, remotePath: String, expected: Long, transferId: String, sourceKey: String): Map<String, Any?> {
    if (cancelled.get()) throw PgError("CANCELLED", "Arrêté")
    val sh = ensureShare()
    val key = resumeKey(remotePath)
    // Sous 8 Mo, un envoi coupé ne garde pas de « .part » (recommencer coûte moins) : rien à noter.
    // Les photos ne touchent donc jamais au disque du téléphone, seules les vidéos y passent.
    val tracked = expected >= SmbCore.RESUME_MIN
    val mayResume = tracked && synchronized(resumeLock) {
      val map = resumeMap()
      val ours = map[key] == sourceKey
      if (!ours) {
        map[key] = sourceKey
        saveResumeMap(map)
      }
      ours
    }
    val digest = SmbCore.newMd5()
    var lastEmit = 0L
    var done = false
    try {
      val sent = SmbCore.upload(sh, { openOriginal(uri, expected) }, remotePath, expected, maxWrite, true, mayResume, { bytes ->
        val now = System.currentTimeMillis()
        if (now - lastEmit > 200) {
          lastEmit = now
          sendEvent("onProgress", mapOf("id" to transferId, "bytes" to bytes.toDouble()))
        }
      }, cancel, digest)
      done = true
      sendEvent("onProgress", mapOf("id" to transferId, "bytes" to sent.toDouble()))
      return mapOf("bytes" to sent.toDouble(), "md5" to SmbCore.hex(digest.digest()))
    } catch (e: SmbCore.Cancelled) {
      throw e
    } catch (e: com.hierynomus.protocol.transport.TransportException) {
      throw e
    } catch (e: com.hierynomus.smbj.common.SMBRuntimeException) {
      // Refus du PC : pas de reprise à garder. Session expirée : si, c'est une coupure.
      if (e is SMBApiException && !sessionGone(e)) done = true
      throw e
    } catch (e: Exception) {
      done = true
      throw e
    } finally {
      // Fini (ou échec sans reprise possible) : on oublie ce « .part ».
      if (done && tracked) synchronized(resumeLock) {
        val map = resumeMap()
        if (map.remove(key) != null) saveResumeMap(map)
      }
    }
  }

  // Relit la copie du PC et la compare à l'original du téléphone. Avec l'empreinte prise pendant
  // l'envoi (`expectedMd5`), l'original n'est pas relu : seulement la copie.
  private fun verify(uri: String, remotePath: String, size: Long, expectedMd5: String): Map<String, Any?> {
    val local = expectedMd5.ifBlank { openOriginal(uri).use { SmbCore.md5(it, cancel) } }
    val remote = SmbCore.md5Remote(ensureShare(), remotePath, size, maxRead, cancel)
    return mapOf("same" to (local == remote), "local" to local, "remote" to remote, "missing" to (remote == null))
  }

  private var serviceRunning = false
  private var serviceTitle = ""

  private fun startService(title: String, text: String, stopLabel: String) {
    val ctx = context
    TransferService.stopLabel = stopLabel
    TransferService.ensureChannel(ctx)
    // Android 13+ : la notification a besoin de cette permission (le service tourne sans).
    if (Build.VERSION.SDK_INT >= 33 &&
      ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      appContext.currentActivity?.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 4713)
    }
    ctx.getSystemService(NotificationManager::class.java).cancel(TransferService.DONE_ID)
    val intent = Intent(ctx, TransferService::class.java)
      .putExtra(TransferService.EXTRA_TITLE, title)
      .putExtra(TransferService.EXTRA_TEXT, text)
    try {
      ctx.startForegroundService(intent)
      serviceRunning = true
      serviceTitle = title
    } catch (e: Exception) {
      // Démarrage refusé (appli déjà en arrière-plan) : la sauvegarde continue écran allumé.
      serviceRunning = false
    }
  }

  private fun stopService(title: String, finalText: String) {
    val ctx = context
    if (serviceRunning) {
      // Par un intent, jamais stopService : il passerait parfois avant startForeground (connexion
      // refusée en quelques millisecondes), et Android fermerait l'appli.
      try {
        ctx.startService(Intent(ctx, TransferService::class.java).setAction(TransferService.ACTION_FINISH))
      } catch (e: Exception) {
        ctx.stopService(Intent(ctx, TransferService::class.java))
      }
    }
    serviceRunning = false
    ctx.getSystemService(NotificationManager::class.java).cancel(TransferService.NOTIFICATION_ID)
    if (finalText.isNotEmpty()) {
      ctx.getSystemService(NotificationManager::class.java)
        .notify(TransferService.DONE_ID, TransferService.build(ctx, title, finalText, 0, 0, false))
    }
  }

  @Suppress("DEPRECATION")
  private fun holdWifi(on: Boolean) {
    if (on) {
      if (wifiLock?.isHeld == true) return
      val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "pixelguard-transfer").apply {
        setReferenceCounted(false)
        acquire()
      }
      // Basse latence ne vaut qu'écran allumé et appli au premier plan. Écran éteint, ce verrou-ci
      // garde le Wi-Fi hors économie d'énergie (jusqu'à Android 13 ; ensuite Android l'ignore).
      wifiLockPerf = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "pixelguard-transfer-perf").apply {
        setReferenceCounted(false)
        acquire()
      }
    } else {
      try { wifiLock?.release() } catch (_: Exception) {}
      try { wifiLockPerf?.release() } catch (_: Exception) {}
      wifiLock = null
      wifiLockPerf = null
    }
  }

  // ===================== Divers

  /** Fichier temporaire écrit jusqu'au disque, puis remplacement d'un coup : jamais à moitié écrit. */
  private fun writeAtomic(target: File, text: String): Boolean {
    val tmp = File.createTempFile(target.name, ".tmp", target.parentFile)
    try {
      java.io.FileOutputStream(tmp).use { out ->
        out.write(text.toByteArray(Charsets.UTF_8))
        out.fd.sync()
      }
      if (tmp.renameTo(target)) return true
      target.delete()
      return tmp.renameTo(target)
    } finally {
      if (tmp.exists()) tmp.delete()
    }
  }

  private fun privateFile(name: String): File {
    val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
    return File(context.filesDir, safe)
  }

  companion object {
    private const val REMOVE_REQUEST = 47_211
    private const val SCAN_REQUEST = 47_212
  }
}
