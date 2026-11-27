import Foundation

struct SmbTarget: Equatable {
  var host: String
  var share: String
  var user: String
  var password: String
  var encrypt: Bool
  /** Nom NetBIOS du PC appairé : un PC qui s'annonce autrement ne reçoit rien. "" : pas encore connu. */
  var identity: String
}

/** Tampon d'erreur pour les fonctions C. */
final class CErr {
  static let size = 512
  let p = UnsafeMutablePointer<CChar>.allocate(capacity: CErr.size)
  init() { p.initialize(repeating: 0, count: CErr.size) }
  deinit { p.deallocate() }
  var text: String { String(cString: p) }
}

/** Une source d'octets lue par PgSmb.c pendant un envoi. */
protocol ByteSource: AnyObject {
  func open() -> Bool
  func read(_ buf: UnsafeMutablePointer<UInt8>, _ max: Int) -> Int
  func close()
}

final class TransferBox {
  let source: ByteSource
  let isCancelled: () -> Bool
  let onProgress: (Int64) -> Void

  init(source: ByteSource, cancelled: @escaping () -> Bool, progress: @escaping (Int64) -> Void) {
    self.source = source
    self.isCancelled = cancelled
    self.onProgress = progress
  }

  func cSource() -> pgs_source {
    pgs_source(ctx: Unmanaged.passUnretained(self).toOpaque(), open: boxOpen, read: boxRead, close: boxClose,
               progress: boxProgress, cancelled: boxCancelled)
  }
}

private func transferBox(_ ctx: UnsafeMutableRawPointer?) -> TransferBox {
  Unmanaged<TransferBox>.fromOpaque(ctx!).takeUnretainedValue()
}
private let boxOpen: @convention(c) (UnsafeMutableRawPointer?) -> Int32 = { transferBox($0).source.open() ? 0 : -1 }
private let boxRead: @convention(c) (UnsafeMutableRawPointer?, UnsafeMutablePointer<UInt8>?, Int32) -> Int32 = { ctx, buf, max in
  Int32(transferBox(ctx).source.read(buf!, Int(max)))
}
private let boxClose: @convention(c) (UnsafeMutableRawPointer?) -> Void = { transferBox($0).source.close() }
private let boxProgress: @convention(c) (UnsafeMutableRawPointer?, Int64) -> Void = { transferBox($0).onProgress($1) }
private let boxCancelled: @convention(c) (UnsafeMutableRawPointer?) -> Int32 = { transferBox($0).isCancelled() ? 1 : 0 }
private let flagCancelled: @convention(c) (UnsafeMutableRawPointer?) -> Int32 = {
  Unmanaged<Flag>.fromOpaque($0!).takeUnretainedValue().get() ? 1 : 0
}

/** Arrêter et progression d'un retour vers le téléphone, lus par PgSmb.c. */
private final class DownloadBox {
  let cancelled: Flag
  let onProgress: (Int64) -> Void

  init(cancelled: Flag, progress: @escaping (Int64) -> Void) {
    self.cancelled = cancelled
    onProgress = progress
  }
}

private func downloadBox(_ ctx: UnsafeMutableRawPointer?) -> DownloadBox {
  Unmanaged<DownloadBox>.fromOpaque(ctx!).takeUnretainedValue()
}
private let downloadProgress: @convention(c) (UnsafeMutableRawPointer?, Int64) -> Void = { downloadBox($0).onProgress($1) }
private let downloadCancelled: @convention(c) (UnsafeMutableRawPointer?) -> Int32 = { downloadBox($0).cancelled.get() ? 1 : 0 }

/** `total` octets aléatoires : le test de vitesse n'a rien à lire sur le téléphone. */
final class NoiseSource: ByteSource {
  private let total: Int64
  private var left: Int64 = 0
  private let block: [UInt8]

  init(total: Int64) {
    self.total = total
    var b = [UInt8](repeating: 0, count: 1 << 20)
    for i in b.indices { b[i] = UInt8.random(in: 0...255) }
    block = b
  }

  func open() -> Bool {
    left = total
    return true
  }

  func read(_ buf: UnsafeMutablePointer<UInt8>, _ max: Int) -> Int {
    if left <= 0 { return 0 }
    let n = Int(min(Int64(max), min(left, Int64(block.count))))
    block.withUnsafeBufferPointer { _ = memcpy(buf, $0.baseAddress!, n) }
    left -= Int64(n)
    return n
  }

  func close() {}
}

private final class NamesBox { var names: [String] = [] }
private final class EntriesBox { var items: [[String: Any]] = [] }

private func code(_ rc: Int32) -> Int { Int(rc) }

/**
 * Une connexion ouverte, avec la cible pour laquelle elle a été ouverte (PC, partage, compte) et
 * la génération du pool à ce moment-là. Elle ne sert que si les deux sont encore les bonnes.
 */
private final class PooledConn {
  let ptr: OpaquePointer
  let host: String
  let share: String
  let user: String
  let generation: Int

  init(_ ptr: OpaquePointer, _ t: SmbTarget, _ generation: Int) {
    self.ptr = ptr
    host = t.host
    share = t.share
    user = t.user
    self.generation = generation
  }

  func fits(_ t: SmbTarget?, _ g: Int) -> Bool {
    guard let t else { return false }
    return generation == g && host == t.host && share == t.share && user == t.user
  }
}

/**
 * Les connexions au dossier partagé : jusqu'à 4 à la fois (une par envoi en parallèle), chacune
 * utilisée par un seul fil. Une connexion coupée est refaite au prochain appel.
 */
final class SmbPool {
  private static let maxConnections = 4
  /** login et connect, un seul à la fois : deux appairages croisés ne mélangent pas leurs PC. */
  private let setup = NSLock()
  private let cond = NSCondition()
  private var target: SmbTarget?
  private var server = ""
  private var idle: [PooledConn] = []
  private var open = 0
  private var generation = 0
  private var lastInfo = pgs_info()
  private var lastIdentity = ""

  func info() -> pgs_info {
    cond.lock()
    defer { cond.unlock() }
    return lastInfo
  }

  func targetKey() -> String {
    cond.lock()
    defer { cond.unlock() }
    return "\(target?.host ?? "")|\(target?.share ?? "")"
  }

  // Le nom est résolu une fois, l'adresse doit être locale, et on vérifie vite que le port répond.
  private static func serverAddress(_ host: String) throws -> String {
    let (h, port) = Net.cleanHost(host)
    let addr = try Net.resolveLocal(h)
    if !Net.probeMany([(addr.ip, port)], timeoutMs: 3000)[0] {
      throw PgError("UNREACHABLE", "PC injoignable (\(h)). Il est allumé, sur le même Wi-Fi ?")
    }
    return addr.family == AF_INET6 ? "[\(addr.ip)]:\(port)" : "\(addr.ip):\(port)"
  }

  private static func splitUser(_ raw: String) -> (domain: String, user: String) {
    let u = raw.trimmingCharacters(in: .whitespaces)
    if let i = u.firstIndex(of: "\\") {
      return (String(u[..<i]), String(u[u.index(after: i)...]))
    }
    return ("", u)
  }

  private static func error(_ rc: Int, _ err: CErr, host: String = "", share: String = "") -> PgError {
    let msg = err.text
    switch rc {
    case Int(PGS_UNREACHABLE): return PgError("UNREACHABLE", "PC injoignable (\(host)). Il est allumé, sur le même Wi-Fi ?")
    case Int(PGS_AUTH): return PgError("AUTH", "Utilisateur ou mot de passe refusé par le PC")
    case Int(PGS_SHARE): return PgError("SHARE", "Partage « \(share) » introuvable ou refusé")
    case Int(PGS_CONNECTION): return PgError("CONNECTION", "Connexion au PC perdue")
    case Int(PGS_TRANSFER): return PgError("TRANSFER", msg.isEmpty ? "Erreur de transfert" : msg)
    case Int(PGS_EXISTS): return PgError("EXISTS", "Déjà sur le PC sous ce nom")
    case Int(PGS_CANCELLED): return PgError("CANCELLED", "Arrêté")
    case Int(PGS_NOT_ENCRYPTED):
      return PgError("NOT_ENCRYPTED", "Ce PC n'a pas accepté le chiffrement : rien n'a été envoyé. Chez toi, tu peux couper le chiffrement dans les réglages de ce PC.")
    case Int(PGS_BUSY):
      return PgError("BUSY", "Le PC garde ce fichier ouvert (autre appareil, ou envoi coupé à l'instant) : il repartira à la prochaine sauvegarde")
    case Int(PGS_PC_CHANGED):
      return PgError("PC_CHANGED", "Ce n'est pas le PC appairé (il s'annonce comme « \(msg) ») : ni ton mot de passe ni tes photos ne sont partis. Si tu as renommé ton PC, refais l'appairage.")
    default: return PgError("SMB", msg.isEmpty ? "Le PC refuse" : msg)
    }
  }

  /**
   * `strict` (tout sauf l'appairage) : chiffrement exigé s'il est demandé, et le PC doit annoncer
   * le nom retenu à l'appairage avant de recevoir l'utilisateur et la réponse au mot de passe.
   */
  private static func openConn(_ server: String, _ t: SmbTarget, share: String, strict: Bool) throws -> (OpaquePointer, pgs_info, String) {
    let (domain, user) = splitUser(t.user)
    var conn: OpaquePointer?
    let err = CErr()
    let seen = CErr()
    let seal = !t.encrypt ? Int32(PGS_SEAL_NO) : strict ? Int32(PGS_SEAL_MUST) : Int32(PGS_SEAL_IF_POSSIBLE)
    let expected = strict ? t.identity : ""
    let rc = code(pgs_connect2(server, share, domain, user, t.password, seal, expected, seen.p, CErr.size, &conn, err.p, CErr.size))
    guard rc == Int(PGS_OK), let c = conn else {
      throw error(rc, err, host: Net.cleanHost(t.host).0, share: share)
    }
    var info = pgs_info()
    pgs_get_info(c, &info)
    return (c, info, seen.text)
  }

  private static func describe(_ info: pgs_info, shares: Any, identity: String) -> [String: Any] {
    [
      "dialect": info.dialect == 0 ? "" : String(cString: pgs_dialect_name(info.dialect)),
      "signed": info.sign != 0,
      "encrypted": info.seal != 0,
      "shares": shares,
      "identity": identity.isEmpty ? (NSNull() as Any) : (identity as Any),
    ]
  }

  /** Connexion au PC et liste de ses dossiers partagés (null si le PC refuse de les lister). */
  func login(_ t: SmbTarget) throws -> [String: Any] {
    setup.lock()
    defer { setup.unlock() }
    closeAll()
    let server = try Self.serverAddress(t.host)
    do {
      let (c, info, seen) = try Self.openConn(server, t, share: "IPC$", strict: false)
      defer { pgs_close(c) }
      let box = NamesBox()
      let err = CErr()
      let rc = withExtendedLifetime(box) {
        code(pgs_list_shares(c, { ctx, name in
          Unmanaged<NamesBox>.fromOpaque(ctx!).takeUnretainedValue().names.append(String(cString: name!))
        }, Unmanaged.passUnretained(box).toOpaque(), err.p, CErr.size))
      }
      return Self.describe(info, shares: rc == Int(PGS_OK) ? box.names : NSNull(), identity: seen)
    } catch let e as PgError where e.code == "SHARE" {
      // Compte accepté mais IPC$ refusé : on tapera le nom du partage à la main.
      return ["dialect": "", "signed": true, "encrypted": false, "shares": NSNull(), "identity": NSNull()]
    }
  }

  func connect(_ t: SmbTarget) throws -> [String: Any] {
    setup.lock()
    defer { setup.unlock() }
    cond.lock()
    if target == t && (open > idle.count || idle.contains(where: { pgs_alive($0.ptr) != 0 })) {
      let info = lastInfo
      let identity = lastIdentity
      cond.unlock()
      return Self.describe(info, shares: NSNull(), identity: identity)
    }
    cond.unlock()
    closeAll()
    let server = try Self.serverAddress(t.host)
    let (c, info, seen) = try Self.openConn(server, t, share: t.share.trimmingCharacters(in: CharacterSet(charactersIn: "\\/ ")), strict: true)
    cond.lock()
    // Nouvelle génération : une connexion ouverte entre-temps pour l'ancienne cible ne servira pas.
    generation += 1
    let stale = idle
    target = t
    self.server = server
    idle = [PooledConn(c, t, generation)]
    open = 1
    lastInfo = info
    lastIdentity = seen
    cond.broadcast()
    cond.unlock()
    stale.forEach { pgs_close($0.ptr) }
    return Self.describe(info, shares: NSNull(), identity: seen)
  }

  func closeAll() {
    cond.lock()
    let list = idle
    idle = []
    open = 0
    generation += 1
    cond.broadcast()
    cond.unlock()
    list.forEach { pgs_close($0.ptr) }
  }

  /**
   * Emprunte une connexion vers la cible actuelle. Une connexion d'une autre génération ou vers
   * une autre cible (PC, partage, compte) n'est jamais rendue : elle est fermée.
   */
  private func checkout() throws -> PooledConn {
    cond.lock()
    while true {
      guard let t = target else {
        cond.unlock()
        throw PgError("NOT_CONNECTED", "Pas connecté au PC")
      }
      let g = generation
      if let c = idle.popLast() {
        if c.fits(t, g) && pgs_alive(c.ptr) != 0 {
          cond.unlock()
          return c
        }
        if c.generation == g { open -= 1 }
        cond.unlock()
        pgs_close(c.ptr)
        cond.lock()
        continue
      }
      if open < Self.maxConnections {
        open += 1
        let server = self.server
        let pinned = lastIdentity
        cond.unlock()
        let conn: PooledConn
        let info: pgs_info
        do {
          // Wi-Fi coupé entre deux envois : on rouvre une connexion.
          // Si le PC n'était pas encore identifié, le nom vu à la première connexion fait foi.
          var known = t
          if known.identity.isEmpty { known.identity = pinned }
          let opened = try Self.openConn(server, known, share: known.share.trimmingCharacters(in: CharacterSet(charactersIn: "\\/ ")), strict: true)
          conn = PooledConn(opened.0, t, g)
          info = opened.1
        } catch {
          cond.lock()
          if g == generation { open -= 1 }
          cond.broadcast()
          cond.unlock()
          throw error
        }
        cond.lock()
        if conn.fits(target, generation) {
          lastInfo = info
          cond.unlock()
          return conn
        }
        // La cible a changé pendant l'ouverture : cette connexion vise l'ancienne, on la ferme.
        // (La nouvelle génération a remis le compte à zéro, rien à décompter.)
        cond.broadcast()
        cond.unlock()
        pgs_close(conn.ptr)
        cond.lock()
        continue
      }
      cond.wait()
    }
  }

  private func checkin(_ c: PooledConn) {
    cond.lock()
    let keep = c.fits(target, generation) && pgs_alive(c.ptr) != 0
    if keep {
      idle.append(c)
    } else if c.generation == generation {
      open -= 1
    }
    cond.broadcast()
    cond.unlock()
    if !keep { pgs_close(c.ptr) }
  }

  private func with<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
    let c = try checkout()
    defer { checkin(c) }
    return try body(c.ptr)
  }

  func list(_ dir: String) throws -> [[String: Any]] {
    try with { c in
      let box = EntriesBox()
      let err = CErr()
      let rc = withExtendedLifetime(box) {
        code(pgs_list(c, dir, { ctx, name, size, isDir in
          Unmanaged<EntriesBox>.fromOpaque(ctx!).takeUnretainedValue().items.append(
            ["name": String(cString: name!), "size": Double(size), "dir": isDir != 0])
        }, Unmanaged.passUnretained(box).toOpaque(), err.p, CErr.size))
      }
      if rc != Int(PGS_OK) { throw Self.error(rc, err) }
      return box.items
    }
  }

  /** Taille lue sur chaque fichier (pas dans la liste du dossier), -1 s'il n'existe pas. */
  func statFiles(_ paths: [String]) throws -> [Double] {
    try with { c in
      try paths.map { path in
        var size: Int64 = -1
        let err = CErr()
        let rc = code(pgs_stat(c, path, &size, err.p, CErr.size))
        if rc != Int(PGS_OK) { throw Self.error(rc, err) }
        return Double(size)
      }
    }
  }

  func mkdirs(_ dir: String) throws {
    try with { c in
      let err = CErr()
      let rc = code(pgs_mkdirs(c, dir, err.p, CErr.size))
      if rc != Int(PGS_OK) { throw Self.error(rc, err) }
    }
  }

  func testWrite(_ dir: String) throws {
    try with { c in
      let err = CErr()
      let rc = code(pgs_test_write(c, dir, err.p, CErr.size))
      if rc != Int(PGS_OK) { throw Self.error(rc, err) }
    }
  }

  /**
   * Octets envoyés, et MD5 (hexadécimal minuscule) de tout l'original tel que lu et envoyé ("" si
   * `md5` vaut false : le test de vitesse n'en a pas besoin).
   */
  func upload(_ box: TransferBox, _ target: String, _ expected: Int64, keep: Bool, mayResume: Bool, md5 wantMd5: Bool = true) throws -> (bytes: Int64, md5: String) {
    try with { c in
      var src = box.cSource()
      var sent: Int64 = 0
      let md5 = UnsafeMutablePointer<CChar>.allocate(capacity: 33)
      defer { md5.deallocate() }
      md5.initialize(repeating: 0, count: 33)
      let err = CErr()
      let rc = withExtendedLifetime(box) {
        code(pgs_upload(c, &src, target, expected, keep ? 1 : 0, mayResume ? 1 : 0, &sent, wantMd5 ? md5 : nil, err.p, CErr.size))
      }
      if rc != Int(PGS_OK) { throw Self.error(rc, err) }
      return (sent, String(cString: md5))
    }
  }

  /** MD5 de la copie du PC, nil si elle n'existe pas. */
  func md5Remote(_ path: String, _ size: Int64, cancelled: Flag) throws -> String? {
    try with { c in
      let out = UnsafeMutablePointer<CChar>.allocate(capacity: 64)
      defer { out.deallocate() }
      out.initialize(repeating: 0, count: 64)
      let err = CErr()
      let rc = withExtendedLifetime(cancelled) {
        code(pgs_md5_remote(c, path, size, flagCancelled, Unmanaged.passUnretained(cancelled).toOpaque(), out, err.p, CErr.size))
      }
      if rc == Int(PGS_NOT_FOUND) { return nil }
      if rc != Int(PGS_OK) { throw Self.error(rc, err) }
      return String(cString: out)
    }
  }

  /**
   * Au plus `length` octets (plafonné à 1 Mo) lus à partir de `offset` : l'EXIF d'une copie sans
   * la ramener en entier. Vide au-delà de la fin, nil si le fichier n'existe pas.
   */
  func readRemote(_ path: String, _ offset: Int64, _ length: Int64) throws -> Data? {
    try with { c in
      let want = Int(max(0, min(length, Int64(PGS_READ_MAX))))
      var buf = [UInt8](repeating: 0, count: max(want, 1))
      var got: Int32 = 0
      let err = CErr()
      let rc = buf.withUnsafeMutableBufferPointer { b in
        code(pgs_read_remote(c, path, offset, Int64(want), b.baseAddress, &got, err.p, CErr.size))
      }
      if rc == Int(PGS_NOT_FOUND) { return nil }
      if rc != Int(PGS_OK) { throw Self.error(rc, err) }
      return Data(buf[0..<Int(got)])
    }
  }

  /**
   * Renomme `from` en `to` dans le partage, dossiers parents créés, sans jamais écraser (EXISTS).
   * `from` absent : erreur SMB « Introuvable sur le PC ».
   */
  func move(_ from: String, _ to: String) throws {
    try with { c in
      let err = CErr()
      let rc = code(pgs_move(c, from, to, err.p, CErr.size))
      if rc != Int(PGS_OK) { throw Self.error(rc, err) }
    }
  }

  /**
   * Ramène la copie du PC dans le fichier local `local` et rend les octets reçus. Elle doit faire
   * `expected` octets (sinon TRANSFER « Copie incomplète »). En cas d'échec ou d'arrêt, le
   * fichier local est effacé par PgSmb.c.
   */
  func download(_ path: String, to local: URL, _ expected: Int64, cancelled: Flag, progress: @escaping (Int64) -> Void) throws -> Int64 {
    try with { c in
      let box = DownloadBox(cancelled: cancelled, progress: progress)
      var got: Int64 = 0
      let err = CErr()
      let rc = withExtendedLifetime(box) {
        code(pgs_download(c, path, local.path, expected, downloadProgress, downloadCancelled,
                          Unmanaged.passUnretained(box).toOpaque(), &got, err.p, CErr.size))
      }
      if rc != Int(PGS_OK) { throw Self.error(rc, err) }
      return got
    }
  }
}
