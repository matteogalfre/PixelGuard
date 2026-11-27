package expo.modules.pgnative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

// Garde la sauvegarde en vie écran éteint ou appli en arrière-plan : service de premier plan
// (type dataSync), verrou processeur, et une notification avec la progression et « Arrêter ».
class TransferService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_FINISH) {
      // Fin de la sauvegarde. Les intents arrivent dans l'ordre : celui du démarrage est déjà passé
      // par startForeground, donc s'arrêter ici ne fait jamais planter l'appli (ce que ferait un
      // stopService arrivé avant startForeground).
      finish()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP) {
      val listener = onStopRequested
      // Plus personne pour arrêter la sauvegarde (JS rechargé) : on libère tout nous-mêmes.
      if (listener == null) finish() else listener("user")
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: ""
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val notification = build(this, title, text, 0, 0, true)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // Refusé (Android 15 : les 6 h du jour sont déjà prises) : la sauvegarde continue tant que
      // l'appli reste ouverte, sans service.
      finish()
      return START_NOT_STICKY
    }
    active = true
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pixelguard:transfer").apply {
        setReferenceCounted(false)
        acquire(6 * 60 * 60 * 1000L)
      }
    }
    return START_NOT_STICKY
  }

  // Android 15 : un service « dataSync » a 6 h par jour. Au bout, il doit s'arrêter tout de suite,
  // sinon Android ferme l'appli. On arrête proprement la sauvegarde, qui pourra reprendre.
  override fun onTimeout(startId: Int, fgsType: Int) {
    onStopRequested?.invoke("timeout")
    finish()
  }

  /** Quitte le premier plan, retire la notification « en cours » et s'arrête. */
  private fun finish() {
    active = false
    try {
      stopForeground(Service.STOP_FOREGROUND_REMOVE)
    } catch (_: Exception) {}
    getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    stopSelf()
  }

  override fun onDestroy() {
    active = false
    try { wakeLock?.release() } catch (_: Exception) {}
    wakeLock = null
    getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    super.onDestroy()
  }

  companion object {
    const val CHANNEL = "transfers"
    const val NOTIFICATION_ID = 4711
    const val DONE_ID = 4712
    const val ACTION_STOP = "expo.modules.pgnative.STOP"
    const val ACTION_FINISH = "expo.modules.pgnative.FINISH"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"

    /** Branché par le module : « Arrêter » dans la notification. */
    /** « user » : bouton de la notification ; « timeout » : limite de 6 h d'Android 15. */
    var onStopRequested: ((String) -> Unit)? = null
    var stopLabel: String = "Stop"

    /** Vrai seulement quand le service tient vraiment le premier plan : la notification suit. */
    @Volatile var active = false

    /** Même nom quelle que soit l'opération (sauvegarde ou vérification) qui l'a créé. */
    fun ensureChannel(context: Context) {
      val nm = context.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "PixelGuard", NotificationManager.IMPORTANCE_LOW))
    }

    fun build(context: Context, title: String, text: String, progress: Int, max: Int, ongoing: Boolean): Notification {
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val builder = Notification.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.pg_notification)
        .setContentTitle(title)
        .setContentText(text)
        .setOnlyAlertOnce(true)
        .setOngoing(ongoing)
        .setAutoCancel(!ongoing)
        .setCategory(Notification.CATEGORY_PROGRESS)
      if (open != null) builder.setContentIntent(open)
      if (ongoing) {
        builder.setProgress(max, progress, max == 0)
        val stop = PendingIntent.getService(
          context, 1, Intent(context, TransferService::class.java).setAction(ACTION_STOP),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        builder.addAction(
          Notification.Action.Builder(Icon.createWithResource(context, R.drawable.pg_notification), stopLabel, stop).build()
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
      }
      return builder.build()
    }
  }
}
