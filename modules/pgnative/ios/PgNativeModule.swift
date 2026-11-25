import ExpoModulesCore
import Photos
import UIKit

struct SmbSettingsRecord: Record {
  @Field var host: String = ""
  @Field var share: String = ""
  @Field var user: String = ""
  @Field var password: String = ""
  @Field var encrypt: Bool = true
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
  private let cancelled = Flag()
  private let resume = ResumeStore()
  private let bgLock = NSLock()
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

    AsyncFunction("verify") { (uri: String, remotePath: String, size: Double, promise: Promise) in
      self.run(promise) { try self.verify(uri, remotePath, Int64(size)) }
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
      self.gallery.remove(uris) { ok, error in
        if let error = error as? PgError {
          promise.reject(error.code, error.message)
        } else {
          promise.resolve(ok)
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

    OnDestroy {
      self.endBackground()
      self.smb.closeAll()
    }
  }

  // Les appels SMB et PhotoKit bloquent : ils tournent sur une file à part, jamais sur le JS.
  private func run(_ promise: Promise, _ body: @escaping () throws -> Any?) {
    work.async {
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
    SmbTarget(host: s.host, share: s.share, user: s.user, password: s.password, encrypt: s.encrypt)
  }

  private func upload(_ uri: String, _ remotePath: String, _ size: Int64, _ transferId: String, _ sourceKey: String) throws -> [String: Any] {
    if cancelled.get() { throw PgError("CANCELLED", "Arrêté") }
    let reader = try gallery.reader(for: uri)
    let key = resume.key(smb.targetKey(), remotePath)
    // Seul un « .part » écrit par ce même original peut être repris.
    let mayResume = resume.claim(key, sourceKey)
    var lastEmit = 0.0
    let box = TransferBox(source: reader, cancelled: { [cancelled] in cancelled.get() }) { [weak self] bytes in
      let now = CACurrentMediaTime()
      if now - lastEmit > 0.2 {
        lastEmit = now
        self?.sendEvent("onProgress", ["id": transferId, "bytes": Double(bytes)])
      }
    }
    do {
      let sent = try smb.upload(box, remotePath, size, keep: true, mayResume: mayResume)
      resume.forget(key)
      sendEvent("onProgress", ["id": transferId, "bytes": Double(sent)])
      return ["bytes": Double(sent)]
    } catch let e as PgError {
      // Arrêt ou coupure : on garde la trace du « .part » pour reprendre ; sinon on l'oublie.
      if e.code != "CANCELLED" && e.code != "CONNECTION" { resume.forget(key) }
      throw e
    }
  }

  // Relit la copie du PC et la compare à l'original du téléphone.
  private func verify(_ uri: String, _ remotePath: String, _ size: Int64) throws -> [String: Any] {
    let local = try gallery.md5(uri, cancelled: { [cancelled] in cancelled.get() })
    let remote = try smb.md5Remote(remotePath, size, cancelled: cancelled)
    return ["same": local == remote, "local": local, "remote": remote ?? NSNull(), "missing": remote == nil]
  }

  private func speedTest(_ dir: String, _ megabytes: Int) throws -> [String: Any] {
    try smb.mkdirs(dir)
    let bytes = Int64(megabytes) << 20
    let target = dir.isEmpty ? ".pixelguard-vitesse" : "\(dir)/.pixelguard-vitesse"
    let box = TransferBox(source: NoiseSource(total: bytes), cancelled: { [cancelled] in cancelled.get() }) { [weak self] done in
      self?.sendEvent("onProgress", ["id": "speed", "bytes": Double(done)])
    }
    let start = CACurrentMediaTime()
    _ = try smb.upload(box, target, bytes, keep: false, mayResume: false)
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

  private func beginBackground() {
    Task { @MainActor in
      self.bgLock.lock()
      defer { self.bgLock.unlock() }
      if self.bgTask != .invalid { return }
      self.bgTask = UIApplication.shared.beginBackgroundTask(withName: "pixelguard-backup") { [weak self] in
        guard let self else { return }
        self.cancelled.set(true)
        self.sendEvent("onStopRequested", [:])
        self.endBackground()
      }
    }
  }

  private func endBackground() {
    Task { @MainActor in
      self.bgLock.lock()
      defer { self.bgLock.unlock() }
      if self.bgTask == .invalid { return }
      UIApplication.shared.endBackgroundTask(self.bgTask)
      self.bgTask = .invalid
    }
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
  private let lock = NSLock()
  private let url = Store.file("resume.json")

  func key(_ target: String, _ remotePath: String) -> String {
    var p = remotePath.replacingOccurrences(of: "/", with: "\\")
    while p.hasPrefix("\\") { p.removeFirst() }
    return "\(target)|\(p.lowercased())"
  }

  private func load() -> [String: String] {
    guard let data = try? Data(contentsOf: url),
          let map = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return [:] }
    return map
  }

  private func save(_ map: [String: String]) {
    if let data = try? JSONSerialization.data(withJSONObject: map) { try? data.write(to: url, options: .atomic) }
  }

  /** Vrai si le « .part » de ce chemin vient de `sourceKey` ; il lui appartient désormais. */
  func claim(_ key: String, _ sourceKey: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    var map = load()
    let ours = map[key] == sourceKey
    map[key] = sourceKey
    save(map)
    return ours
  }

  func forget(_ key: String) {
    lock.lock()
    defer { lock.unlock() }
    var map = load()
    if map.removeValue(forKey: key) != nil { save(map) }
  }
}
