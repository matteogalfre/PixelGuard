import ExpoModulesCore
import Photos
import UIKit

struct SmbSettingsRecord: Record {
  @Field var host: String = ""
  @Field var share: String = ""
  @Field var user: String = ""
  @Field var password: String = ""
  @Field var encrypt: Bool = true
  /** Nom NetBIOS du PC appairé ("" : pas encore connu). */
  @Field var identity: String = ""
}

/** Une page donnée par le petit serveur web (le fichier de préparation, et sa page). */
struct ServedPageRecord: Record {
  @Field var path: String = "/"
  @Field var type: String = "text/plain"
  @Field var body: String = ""
  @Field var download: String = ""
}

struct PgError: Error {
  let code: String
  let message: String
  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}

final class Flag {
  private let lock = NSLock()
  private var value = false
  func set(_ v: Bool) { lock.lock(); value = v; lock.unlock() }
  func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}

// Le natif de PixelGuard sur iPhone : même API JS que le module Android. Galerie avec PhotoKit,
// dossier partagé du PC avec libsmb2 (cœur dans PgSmb.c), découverte des PC du Wi-Fi.
// Pas de sauvegarde longue en arrière-plan : iOS ne le permet pas pour du SMB.
public final class PgNativeModule: Module {
  private let work = DispatchQueue(label: "pixelguard.work", qos: .userInitiated, attributes: .concurrent)
  private let smb = SmbPool()
  private let gallery = Gallery()
  private let watch = LibraryWatch()
  private let cancelled = Flag()
  private let resume = ResumeStore()
  /** Le petit serveur web : démarrer et arrêter passent un par un, dans l'ordre des appels. */
  private let prep = DispatchQueue(label: "pixelguard.prep", qos: .userInitiated)
  /** Lu et écrit seulement sur le fil principal. */
  private var bgTask: UIBackgroundTaskIdentifier = .invalid

  public func definition() -> ModuleDefinition {
    Name("PgNative")
    Events("onProgress", "onStopRequested")

    // ---------- Galerie

    AsyncFunction("listAlbums") { (promise: Promise) in
      self.run(promise) { try self.gallery.albums() }
    }

    AsyncFunction("listMedia") { (bucketIds: [String], promise: Promise) in
      self.run(promise) { try self.gallery.media(bucketIds) }
    }

    AsyncFunction("galleryVersion") { (promise: Promise) in
      self.run(promise) { self.watch.version() }
    }

    // ---------- Trouver le PC

    AsyncFunction("discover") { (promise: Promise) in
      self.run(promise) { try Net.discover() }
    }

    AsyncFunction("probe") { (host: String, promise: Promise) in
      self.run(promise) { Net.probe(host) }
    }

    // ---------- Dossier partagé

    AsyncFunction("login") { (s: SmbSettingsRecord, promise: Promise) in
      self.run(promise) { try self.smb.login(Self.target(s)) }
    }

    AsyncFunction("connect") { (s: SmbSettingsRecord, promise: Promise) in
      self.run(promise) { try self.smb.connect(Self.target(s)) }
    }

    AsyncFunction("disconnect") { (promise: Promise) in
      self.run(promise) {
        self.smb.closeAll()
        return true
      }
    }

    AsyncFunction("list") { (dir: String, promise: Promise) in
      self.run(promise) { try self.smb.list(dir) }
    }

    AsyncFunction("statFiles") { (paths: [String], promise: Promise) in
      self.run(promise) { try self.smb.statFiles(paths) }
    }

    AsyncFunction("mkdirs") { (dir: String, promise: Promise) in
      self.run(promise) {
        try self.smb.mkdirs(dir)
        return true
      }
    }

    AsyncFunction("testWrite") { (dir: String, promise: Promise) in
      self.run(promise) {
        try self.smb.testWrite(dir)
        return ["ok": true]
      }
    }

    AsyncFunction("speedTest") { (dir: String, megabytes: Int, promise: Promise) in
      self.run(promise) { try self.speedTest(dir, megabytes) }
    }

    AsyncFunction("upload") { (uri: String, remotePath: String, size: Double, transferId: String, sourceKey: String, promise: Promise) in
      self.run(promise) { try self.upload(uri, remotePath, Int64(size), transferId, sourceKey) }
    }

    // `expectedMd5` : le MD5 rendu par upload. Donné, on ne relit pas l'original du téléphone.
    AsyncFunction("verify") { (uri: String, remotePath: String, size: Double, expectedMd5: String?, promise: Promise) in
      self.run(promise) { try self.verify(uri, remotePath, Int64(size), expectedMd5 ?? "") }
    }

    // ---------- Fichiers déjà sur le PC

    // Au plus 1 Mo, en base64 (l'EXIF : date de prise de vue, vignette). nil si absent.
    AsyncFunction("readRemote") { (path: String, offset: Double, length: Double, promise: Promise) in
      self.run(promise) { () -> Any? in
        guard let data = try self.smb.readRemote(path, Self.bytes(offset), Self.bytes(length)) else { return nil }
        return data.base64EncodedString()
      }
    }

    // MD5 de la copie du PC : nil si absente, « taille:N » si elle n'a pas `size` octets.
    AsyncFunction("remoteMd5") { (path: String, size: Double, promise: Promise) in
      self.run(promise) { () -> Any? in
        if self.cancelled.get() { throw PgError("CANCELLED", "Arrêté") }
        return try self.smb.md5Remote(path, Self.bytes(size), cancelled: self.cancelled)
      }
    }

    AsyncFunction("move") { (from: String, to: String, promise: Promise) in
      self.run(promise) {
        try self.smb.move(from, to)
        return true
      }
    }

    AsyncFunction("download") { (remotePath: String, size: Double, name: String, video: Bool, transferId: String, promise: Promise) in
      self.run(promise) { try self.download(remotePath, Self.bytes(size), name, video, transferId) }
    }

    Function("cancel") { self.cancelled.set(true) }
    Function("resetCancel") { self.cancelled.set(false) }

    // Android garde le Wi-Fi en basse latence ; iOS n'a pas d'équivalent.
    Function("holdWifi") { (_: Bool) in }

    // Pas de service de premier plan sur iPhone : l'écran reste allumé pendant l'envoi
    // (expo-keep-awake). Si l'appli passe en arrière-plan, iOS laisse une trentaine de secondes :
    // on s'en sert pour arrêter proprement (un « .part » de vidéo reste repris la fois suivante).
    Function("startTransferService") { (_: String, _: String, _: String) in self.beginBackground() }
    Function("updateTransferService") { (_: String, _: Int, _: Int) in }
    Function("stopTransferService") { (_: String, _: String) in self.endBackground() }

    // ---------- Libérer de la place

    AsyncFunction("removeFromPhone") { (uris: [String], _: Bool, promise: Promise) in
      // iOS demande lui-même la confirmation et range tout dans « Supprimés récemment » (30 jours).
      // Renvoie les uri vraiment supprimées : une photo gardée (fichier pas vérifié, rafale
      // incomplète) doit rester connue comme « sur le PC ».
      self.gallery.remove(uris) { removed, error in
        if let error = error as? PgError {
          promise.reject(error.code, error.message)
        } else {
          promise.resolve(removed)
        }
      }
    }

    // ---------- Petit stockage de fichiers texte (index des copies)

    AsyncFunction("saveText") { (name: String, text: String, promise: Promise) in
      self.run(promise) {
        try Data(text.utf8).write(to: Store.file(name), options: .atomic)
        return true
      }
    }

    AsyncFunction("loadText") { (name: String, promise: Promise) in
      self.run(promise) { () -> Any? in
        guard let data = try? Data(contentsOf: Store.file(name)) else { return nil }
        return String(decoding: data, as: UTF8.self)
      }
    }

    // Le téléphone donne « Prepare my PC » au navigateur du PC, le temps de la préparation.
    AsyncFunction("startPrepServer") { (pages: [ServedPageRecord], promise: Promise) in
      self.run(promise, on: self.prep) {
        pgh_stop()
        pgh_clear()
        for p in pages {
          let bytes = Array(p.body.utf8)
          let rc = bytes.withUnsafeBufferPointer { buf in pgh_add(p.path, p.type, p.download, buf.baseAddress, buf.count) }
          if rc < 0 { throw PgError("SERVER", "Page refusée par le petit serveur : \(p.path)") }
        }
        // Le serveur n'écoute que sur l'adresse du Wi-Fi, et c'est celle-là qu'on montre.
        var ip = [CChar](repeating: 0, count: 64)
        let port = pgh_start(8800, &ip, ip.count)
        if port < 0 { throw PgError("SERVER", "Impossible de proposer le fichier sur le Wi-Fi") }
        let address = String(cString: ip)
        let result: [String: Any] = ["ip": address.isEmpty ? (NSNull() as Any) : (address as Any), "port": Int(port)]
        return result
      }
    }

    AsyncFunction("stopPrepServer") { (promise: Promise) in
      self.run(promise, on: self.prep) {
        pgh_stop()
        return true
      }
    }

    OnDestroy {
      self.prep.async { pgh_stop() }
      self.endBackground()
      self.smb.closeAll()
    }
  }

  // Les appels SMB et PhotoKit bloquent : ils tournent sur une file à part, jamais sur le JS.
  private func run(_ promise: Promise, on queue: DispatchQueue? = nil, _ body: @escaping () throws -> Any?) {
    (queue ?? work).async {
      do {
        promise.resolve(try body())
      } catch let e as PgError {
        promise.reject(e.code, e.message)
      } catch {
        promise.reject("ERROR", error.localizedDescription)
      }
    }
  }

  private static func target(_ s: SmbSettingsRecord) -> SmbTarget {
    SmbTarget(host: s.host, share: s.share, user: s.user, password: s.password, encrypt: s.encrypt, identity: s.identity)
  }

  private func upload(_ uri: String, _ remotePath: String, _ size: Int64, _ transferId: String, _ sourceKey: String) throws -> [String: Any] {
    if cancelled.get() { throw PgError("CANCELLED", "Arrêté") }
    let reader = try gallery.reader(for: uri)
    // Une lecture qui attend PhotoKit rend la main dès Arrêter.
    reader.isCancelled = { [cancelled] in cancelled.get() }
    let key = resume.key(smb.targetKey(), remotePath)
    // Sous 8 Mo (PGS_RESUME_MIN), un envoi coupé ne garde pas de « .part » : rien à noter, les
    // photos ne touchent jamais au disque du téléphone. Seul un « .part » écrit par ce même
    // original peut être repris.
    let tracked = size >= ResumeStore.minSize
    let mayResume = tracked && resume.claim(key, sourceKey)
    var lastEmit = 0.0
    let box = TransferBox(source: reader, cancelled: { [cancelled] in cancelled.get() }) { [weak self] bytes in
      let now = CACurrentMediaTime()
      if now - lastEmit > 0.2 {
        lastEmit = now
        self?.sendEvent("onProgress", ["id": transferId, "bytes": Double(bytes)])
      }
    }
    do {
      let (sent, md5) = try smb.upload(box, remotePath, size, keep: true, mayResume: mayResume)
      if tracked { resume.forget(key) }
      sendEvent("onProgress", ["id": transferId, "bytes": Double(sent)])
      // Le MD5 de l'original tel qu'envoyé : « Libérer de la place » n'aura pas à le relire.
      return ["bytes": Double(sent), "md5": md5]
    } catch let e as PgError {
      // Arrêt ou coupure : on garde la trace du « .part » pour reprendre.
      // BUSY : le PC tient encore le « .part » ouvert. S'il était à nous (envoi coupé à l'instant),
      // la trace reste pour reprendre ; sinon il est à un autre appareil, on ne le revendique pas.
      // Tout autre échec : on l'oublie.
      let keepTrace = e.code == "CANCELLED" || e.code == "CONNECTION" || (e.code == "BUSY" && mayResume)
      if tracked && !keepTrace { resume.forget(key) }
      throw e
    }
  }

  /**
   * Compare la copie du PC à l'original. Avec `expectedMd5` (rendu par upload), seul le MD5 du PC
   * est calculé, l'original n'est pas relu ; sans, on relit l'original du téléphone.
   */
  private func verify(_ uri: String, _ remotePath: String, _ size: Int64, _ expectedMd5: String) throws -> [String: Any] {
    if !expectedMd5.isEmpty {
      let remote = try smb.md5Remote(remotePath, size, cancelled: cancelled)
      return ["same": remote == expectedMd5.lowercased(), "local": expectedMd5, "remote": remote ?? NSNull(), "missing": remote == nil]
    }
    let local = try gallery.md5(uri, cancelled: { [cancelled] in cancelled.get() })
    let remote = try smb.md5Remote(remotePath, size, cancelled: cancelled)
    return ["same": local == remote, "local": local, "remote": remote ?? NSNull(), "missing": remote == nil]
  }

  /** Un nombre d'octets venu du JS : négatif, NaN ou infini ne doivent pas planter la conversion. */
  private static func bytes(_ d: Double) -> Int64 {
    d.isFinite ? Int64(max(0, min(d, 9e18))) : 0
  }

  /**
   * Ramène un fichier du PC dans la photothèque : lu vers un fichier temporaire qui porte son nom
   * (Photos en tire le type), contrôlé à la taille, puis confié à PhotoKit. Le temporaire est
   * effacé dans tous les cas.
   */
  private func download(_ remotePath: String, _ size: Int64, _ name: String, _ video: Bool, _ transferId: String) throws -> [String: Any] {
    if cancelled.get() { throw PgError("CANCELLED", "Arrêté") }
    // Un dossier par appel : deux retours du même nom en parallèle ne se marchent pas dessus.
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pixelguard-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent(Self.localName(name))
    var lastEmit = 0.0
    let got = try smb.download(remotePath, to: file, size, cancelled: cancelled) { [weak self] bytes in
      let now = CACurrentMediaTime()
      if now - lastEmit > 0.2 {
        lastEmit = now
        self?.sendEvent("onProgress", ["id": transferId, "bytes": Double(bytes)])
      }
    }
    sendEvent("onProgress", ["id": transferId, "bytes": Double(got)])
    // Arrêter juste à la fin de la lecture : rien n'entre dans la photothèque.
    if cancelled.get() { throw PgError("CANCELLED", "Arrêté") }
    let uri = try gallery.add(file, name: name, video: video)
    return ["uri": uri]
  }

  /** Le nom du fichier temporaire : celui du PC, extension gardée, sans séparateur de dossier. */
  private static func localName(_ name: String) -> String {
    let safe = String(name.map { "/\\:".contains($0) ? "_" : $0 }).trimmingCharacters(in: .whitespaces)
    return safe.isEmpty || safe == "." || safe == ".." ? "fichier" : safe
  }

  private func speedTest(_ dir: String, _ megabytes: Int) throws -> [String: Any] {
    try smb.mkdirs(dir)
    let bytes = Int64(megabytes) << 20
    let target = dir.isEmpty ? ".pixelguard-vitesse" : "\(dir)/.pixelguard-vitesse"
    let box = TransferBox(source: NoiseSource(total: bytes), cancelled: { [cancelled] in cancelled.get() }) { [weak self] done in
      self?.sendEvent("onProgress", ["id": "speed", "bytes": Double(done)])
    }
    let start = CACurrentMediaTime()
    _ = try smb.upload(box, target, bytes, keep: false, mayResume: false, md5: false)
    let seconds = CACurrentMediaTime() - start
    let info = smb.info()
    return [
      "bytes": Double(bytes),
      "seconds": seconds,
      "dialect": String(cString: pgs_dialect_name(info.dialect)),
      "signed": info.sign != 0,
      "encrypted": info.seal != 0,
      "signingCrypto": "ARMv8", // AES matériel du processeur, dans libsmb2
      "maxWrite": Int(info.max_write),
    ]
  }

  // Début et fin passent par la file principale, dans l'ordre des appels : une fin ne peut pas
  // doubler le début qu'elle doit clore.
  private func beginBackground() {
    DispatchQueue.main.async {
      if self.bgTask != .invalid { return }
      self.bgTask = UIApplication.shared.beginBackgroundTask(withName: "pixelguard-backup") {
        // iOS appelle ce gestionnaire sur le fil principal, et veut la fin avant qu'il ne rende la
        // main : on arrête l'envoi et on clôt tout de suite, sans repasser par la file.
        self.cancelled.set(true)
        self.sendEvent("onStopRequested", ["reason": "background"])
        self.endBackgroundNow()
      }
    }
  }

  private func endBackground() {
    DispatchQueue.main.async { self.endBackgroundNow() }
  }

  /** Sur le fil principal seulement. */
  private func endBackgroundNow() {
    if bgTask == .invalid { return }
    UIApplication.shared.endBackgroundTask(bgTask)
    bgTask = .invalid
  }
}

enum Store {
  static let dir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let url = base.appendingPathComponent("PixelGuard", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }()

  static func file(_ name: String) -> URL {
    let safe = String(name.unicodeScalars.map { c -> Character in
      let ok = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "." || c == "_" || c == "-"
      return ok ? Character(c) : "_"
    })
    return dir.appendingPathComponent(safe)
  }
}

/** Quel original a écrit chaque « .part » encore sur un PC : on ne reprend que celui-là. */
final class ResumeStore {
  /** Même seuil que PGS_RESUME_MIN dans PgSmb.h : en dessous, pas de reprise. */
  static let minSize: Int64 = 8 << 20

  private let lock = NSLock()
  private let url = Store.file("resume.json")
  // Lue une fois, gardée en mémoire ; seul un vrai changement réécrit le fichier.
  private var cache: [String: String]?

  func key(_ target: String, _ remotePath: String) -> String {
    var p = remotePath.replacingOccurrences(of: "/", with: "\\")
    while p.hasPrefix("\\") { p.removeFirst() }
    return "\(target)|\(p.lowercased())"
  }

  private func load() -> [String: String] {
    if let cache { return cache }
    guard let data = try? Data(contentsOf: url),
          let map = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
      cache = [:]
      return [:]
    }
    cache = map
    return map
  }

  private func save(_ map: [String: String]) {
    cache = map
    if let data = try? JSONSerialization.data(withJSONObject: map) { try? data.write(to: url, options: .atomic) }
  }

  /** Vrai si le « .part » de ce chemin vient de `sourceKey` ; il lui appartient désormais. */
  func claim(_ key: String, _ sourceKey: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    var map = load()
    let ours = map[key] == sourceKey
    if !ours {
      map[key] = sourceKey
      save(map)
    }
    return ours
  }

  func forget(_ key: String) {
    lock.lock()
    defer { lock.unlock() }
    var map = load()
    if map.removeValue(forKey: key) != nil { save(map) }
  }
}
