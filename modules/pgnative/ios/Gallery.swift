import CryptoKit
import Foundation
import Photos

/**
 * La galerie de l'iPhone. Une photo iPhone peut avoir plusieurs fichiers ; chacun devient un
 * média à part, nommé comme lors d'une copie par câble vers Windows :
 * - l'original tel que pris (IMG_1234.HEIC, .JPG, .PNG, .MOV), octet pour octet ;
 * - la vidéo d'une Live Photo (IMG_1234.MOV), rangée avec la photo ;
 * - la version retouchée si la photo a été modifiée dans Photos (IMG_E1234.HEIC) ;
 * - le RAW d'une paire RAW + JPEG.
 * Pour libérer de la place, une photo n'est supprimée que si tous ses fichiers sont vérifiés.
 */
final class Gallery {
  struct Part: Codable {
    var k: String // main, alt, live, edit, editlive
    var n: String
    var s: Int64
    var v: Bool
  }

  struct Cached: Codable {
    var m: Double
    var p: [Part]
  }

  private let lock = NSLock()
  private var cache: [String: Cached] = [:]
  private var loaded = false
  private var dirty = false
  private let cacheURL = Store.file("assets-cache.json")

  // Albums intelligents utiles. Pas « Masqués », « Supprimés », « Ajouts récents » (doublon).
  private static let smart: Set<Int> = [209, 203, 211, 220, 210, 213, 202, 201, 208, 204, 207, 212, 217, 218, 214, 215, 219]
  private static let libraryPath = "photos://library"

  private func authorized() throws {
    let st = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard st == .authorized || st == .limited else {
      throw PgError("NO_PERMISSION", "Autorise l'accès aux photos dans les réglages de l'iPhone")
    }
  }

  private static func fetchOptions() -> PHFetchOptions {
    let o = PHFetchOptions()
    o.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    o.includeAssetSourceTypes = [.typeUserLibrary]
    // Chaque image d'une rafale est son propre média : sans ça, seule l'image représentative
    // était listée, et les autres n'arrivaient jamais sur le PC.
    o.includeAllBurstAssets = true
    return o
  }

  // ---------------------------------------------------------------- fichiers d'une photo

  static func resources(of asset: PHAsset) -> [(kind: String, res: PHAssetResource)] {
    let all = PHAssetResource.assetResources(for: asset)
    func first(_ t: PHAssetResourceType) -> PHAssetResource? { all.first { $0.type == t } }
    let video = asset.mediaType == .video
    guard let main = video ? (first(.video) ?? first(.fullSizeVideo)) : (first(.photo) ?? first(.fullSizePhoto)) else { return [] }
    var out: [(String, PHAssetResource)] = [("main", main)]
    if let alt = first(.alternatePhoto) { out.append(("alt", alt)) }
    if let live = first(.pairedVideo) { out.append(("live", live)) }
    if let edit = video ? first(.fullSizeVideo) : first(.fullSizePhoto), edit !== main { out.append(("edit", edit)) }
    if let editLive = first(.fullSizePairedVideo) { out.append(("editlive", editLive)) }
    return out
  }

  private static func split(_ name: String) -> (String, String) {
    guard let dot = name.lastIndex(of: "."), dot > name.startIndex else { return (name, "") }
    return (String(name[..<dot]), String(name[dot...]))
  }

  /** IMG_1234.HEIC retouchée devient IMG_E1234.HEIC, comme une copie par câble. */
  private static func editedBase(_ base: String) -> String {
    if base.hasPrefix("IMG_"), base.dropFirst(4).allSatisfy(\.isNumber) { return "IMG_E" + base.dropFirst(4) }
    return base + "_E"
  }

  private static func name(_ kind: String, _ res: PHAssetResource, main: PHAssetResource) -> String {
    let (base, mainExt) = split(main.originalFilename)
    var ext = split(res.originalFilename).1
    if mainExt == mainExt.uppercased() { ext = ext.uppercased() }
    switch kind {
    case "live": return base + ext
    case "edit", "editlive": return editedBase(base) + ext
    default: return res.originalFilename
    }
  }

  private static func size(_ res: PHAssetResource) -> Int64 {
    (res.value(forKey: "fileSize") as? NSNumber)?.int64Value ?? 0
  }

  private static func stamp(_ a: PHAsset) -> Double {
    (a.modificationDate ?? a.creationDate)?.timeIntervalSince1970 ?? 0
  }

  private static func compute(_ asset: PHAsset) -> Cached {
    let list = resources(of: asset)
    guard let main = list.first?.res else { return Cached(m: stamp(asset), p: []) }
    let video = asset.mediaType == .video
    let parts = list.map { kind, res in
      // La vidéo d'une Live Photo suit la photo (filtre « Photos », dossier Photos).
      Part(k: kind, n: name(kind, res, main: main), s: size(res), v: video)
    }
    return Cached(m: stamp(asset), p: parts)
  }

  private func loadCache() {
    if loaded { return }
    loaded = true
    if let data = try? Data(contentsOf: cacheURL), let c = try? JSONDecoder().decode([String: Cached].self, from: data) {
      cache = c
    }
  }

  private func saveCache() {
    lock.lock()
    guard dirty else { lock.unlock(); return }
    dirty = false
    let copy = cache
    lock.unlock()
    if let data = try? JSONEncoder().encode(copy) { try? data.write(to: cacheURL, options: .atomic) }
  }

  /**
   * Les fichiers de chaque photo. Lire la liste des fichiers d'une photo prend du temps sur une
   * grosse galerie : le résultat est gardé (sur le disque aussi) tant que la photo ne change pas.
   */
  private func parts(_ assets: [PHAsset]) -> [[Part]] {
    lock.lock()
    loadCache()
    var missing: [Int] = []
    for (i, a) in assets.enumerated() where cache[a.localIdentifier]?.m != Self.stamp(a) { missing.append(i) }
    lock.unlock()
    if !missing.isEmpty {
      var computed = [Cached?](repeating: nil, count: missing.count)
      computed.withUnsafeMutableBufferPointer { buf in
        DispatchQueue.concurrentPerform(iterations: missing.count) { j in buf[j] = Self.compute(assets[missing[j]]) }
      }
      lock.lock()
      for (j, i) in missing.enumerated() { cache[assets[i].localIdentifier] = computed[j] }
      dirty = true
      lock.unlock()
    }
    lock.lock()
    defer { lock.unlock() }
    return assets.map { cache[$0.localIdentifier]?.p ?? [] }
  }

  private static func list(_ result: PHFetchResult<PHAsset>) -> [PHAsset] {
    var out: [PHAsset] = []
    out.reserveCapacity(result.count)
    result.enumerateObjects { a, _, _ in out.append(a) }
    return out
  }

  // ---------------------------------------------------------------- albums

  private func collections() -> [(PHAssetCollection, String)] {
    var out: [(PHAssetCollection, String)] = []
    PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .any, options: nil).enumerateObjects { c, _, _ in
      let raw = c.assetCollectionSubtype.rawValue
      if Self.smart.contains(raw) { out.append((c, raw == 209 ? Self.libraryPath : "photos://smart/\(raw)")) }
    }
    PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil).enumerateObjects { c, _, _ in
      if c.assetCollectionSubtype == .albumRegular || c.assetCollectionSubtype == .albumImported {
        out.append((c, "photos://album"))
      }
    }
    return out
  }

  func albums() throws -> [[String: Any]] {
    try authorized()
    // Toute la galerie d'un coup, en parallèle : les albums ne font ensuite que lire le cache.
    _ = parts(Self.list(PHAsset.fetchAssets(with: Self.fetchOptions())))
    var out: [(dict: [String: Any], count: Int, library: Bool)] = []
    for (c, path) in collections() {
      let assets = Self.list(PHAsset.fetchAssets(in: c, options: Self.fetchOptions()))
      if assets.isEmpty { continue }
      let ps = parts(assets)
      let count = ps.reduce(0) { $0 + $1.count }
      let bytes = ps.reduce(Int64(0)) { acc, p in acc + p.reduce(Int64(0)) { $0 + $1.s } }
      out.append(([
        "id": c.localIdentifier,
        "name": c.localizedTitle ?? "",
        "path": path,
        "count": count,
        "bytes": Double(bytes),
        "cover": "ph://\(assets[0].localIdentifier)",
      ], count, path == Self.libraryPath))
    }
    saveCache()
    out.sort { a, b in a.library != b.library ? a.library : a.count > b.count }
    return out.map(\.dict)
  }

  /**
   * Les fichiers des albums choisis. Une photo peut être dans plusieurs albums : elle ne sort
   * qu'une fois, avec l'album le plus précis (la Pellicule passe en dernier).
   */
  func media(_ ids: [String]) throws -> [[String: Any]] {
    try authorized()
    if ids.isEmpty { return [] }
    var found: [String: PHAssetCollection] = [:]
    PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: ids, options: nil).enumerateObjects { c, _, _ in
      found[c.localIdentifier] = c
    }
    let ordered = ids.compactMap { found[$0] }.sorted { a, b in
      (a.assetCollectionSubtype != .smartAlbumUserLibrary) && (b.assetCollectionSubtype == .smartAlbumUserLibrary)
    }
    var seen = Set<String>()
    var rows: [(taken: Double, item: [String: Any])] = []
    for c in ordered {
      let assets = Self.list(PHAsset.fetchAssets(in: c, options: Self.fetchOptions())).filter { !seen.contains($0.localIdentifier) }
      let path = c.assetCollectionSubtype == .smartAlbumUserLibrary ? Self.libraryPath
        : c.assetCollectionType == .smartAlbum ? "photos://smart/\(c.assetCollectionSubtype.rawValue)" : "photos://album"
      for (asset, ps) in zip(assets, parts(assets)) {
        seen.insert(asset.localIdentifier)
        let id = asset.localIdentifier
        let taken = (asset.creationDate?.timeIntervalSince1970 ?? 0) * 1000
        let modified = asset.modificationDate.map { $0.timeIntervalSince1970 * 1000 } ?? taken
        for p in ps {
          let main = p.k == "main"
          rows.append((taken, [
            "id": main ? id : "\(id)#\(p.k)",
            "name": p.n,
            "size": Double(p.s),
            "taken": taken,
            "modified": modified,
            "video": p.v,
            "bucketId": c.localIdentifier,
            "bucketName": c.localizedTitle ?? "",
            "relativePath": path,
            "uri": main ? "ph://\(id)" : "ph://\(id)#\(p.k)",
          ]))
        }
      }
    }
    saveCache()
    return rows.enumerated().sorted { a, b in
      a.element.taken != b.element.taken ? a.element.taken > b.element.taken : a.offset < b.offset
    }.map(\.element.item)
  }

  // ---------------------------------------------------------------- lecture des originaux

  private static func parse(_ uri: String) -> (id: String, kind: String)? {
    guard uri.hasPrefix("ph://") else { return nil }
    let rest = uri.dropFirst(5)
    if let hash = rest.firstIndex(of: "#") { return (String(rest[..<hash]), String(rest[rest.index(after: hash)...])) }
    return (String(rest), "main")
  }

  func reader(for uri: String) throws -> AssetReader {
    try authorized()
    guard let (id, kind) = Self.parse(uri),
          let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
          let res = Self.resources(of: asset).first(where: { $0.kind == kind })?.res else {
      throw PgError("NO_FILE", "Fichier introuvable sur le téléphone")
    }
    return AssetReader(res)
  }

  func md5(_ uri: String, cancelled: () -> Bool) throws -> String {
    let reader = try reader(for: uri)
    guard reader.open() else { throw PgError("NO_FILE", "Fichier introuvable sur le téléphone") }
    defer { reader.close() }
    var md5 = Insecure.MD5()
    let cap = 1 << 20
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: cap)
    defer { buf.deallocate() }
    while true {
      if cancelled() { throw PgError("CANCELLED", "Arrêté") }
      let n = reader.read(buf, cap)
      if n < 0 { throw PgError("TRANSFER", "Lecture de l'original impossible") }
      if n == 0 { break }
      md5.update(bufferPointer: UnsafeRawBufferPointer(start: buf, count: n))
    }
    return md5.finalize().map { String(format: "%02x", $0) }.joined()
  }

  // ---------------------------------------------------------------- libérer de la place

  /**
   * Supprime les photos dont tous les fichiers sont dans `uris` (iOS demande confirmation), et
   * renvoie les uri vraiment supprimées. Une rafale n'est touchée que si toutes ses images sont
   * dans la liste : PhotoKit pourrait sinon emporter des images jamais vérifiées.
   */
  func remove(_ uris: [String], completion: @escaping ([String], Error?) -> Void) {
    do { try authorized() } catch { return completion([], error) }
    var kinds: [String: Set<String>] = [:]
    var urisOf: [String: [String]] = [:]
    for uri in uris {
      if let (id, kind) = Self.parse(uri) {
        kinds[id, default: []].insert(kind)
        urisOf[id, default: []].append(uri)
      }
    }
    var whole: [PHAsset] = []
    PHAsset.fetchAssets(withLocalIdentifiers: Array(kinds.keys), options: nil).enumerateObjects { a, _, _ in
      let needed = Set(Self.resources(of: a).map(\.kind))
      if !needed.isEmpty && needed.isSubset(of: kinds[a.localIdentifier] ?? []) { whole.append(a) }
    }
    let wholeIds = Set(whole.map(\.localIdentifier))
    let burstOptions = PHFetchOptions()
    burstOptions.includeAllBurstAssets = true
    let safe = whole.filter { a in
      guard let burst = a.burstIdentifier else { return true }
      var complete = true
      PHAsset.fetchAssets(withBurstIdentifier: burst, options: burstOptions).enumerateObjects { m, _, stop in
        if !wholeIds.contains(m.localIdentifier) {
          complete = false
          stop.pointee = true
        }
      }
      return complete
    }
    if safe.isEmpty { return completion([], nil) }
    PHPhotoLibrary.shared().performChanges({
      PHAssetChangeRequest.deleteAssets(safe as NSArray)
    }) { ok, _ in
      completion(ok ? safe.flatMap { urisOf[$0.localIdentifier] ?? [] } : [], nil)
    }
  }
}

/**
 * Lit un fichier de la galerie en flux, même s'il est sur iCloud (« Optimiser le stockage ») :
 * PhotoKit pousse les octets, l'envoi SMB les tire. Au-delà de 8 Mo d'avance, PhotoKit attend.
 */
final class AssetReader: ByteSource {
  private static let maxBuffered = 8 << 20
  private let resource: PHAssetResource
  private let cond = NSCondition()
  private var chunks: [Data] = []
  private var head = 0
  private var buffered = 0
  private var finished = false
  private var failed = false
  private var stopped = true
  private var generation = 0
  private var request: PHAssetResourceDataRequestID = 0

  init(_ resource: PHAssetResource) {
    self.resource = resource
  }

  deinit { close() }

  func open() -> Bool {
    close()
    cond.lock()
    generation += 1
    let gen = generation
    chunks = []
    head = 0
    buffered = 0
    finished = false
    failed = false
    stopped = false
    cond.unlock()
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true
    let id = PHAssetResourceManager.default().requestData(for: resource, options: options, dataReceivedHandler: { [weak self] data in
      guard let self else { return }
      self.cond.lock()
      while self.generation == gen && !self.stopped && self.buffered >= Self.maxBuffered { self.cond.wait() }
      if self.generation == gen && !self.stopped {
        self.chunks.append(data)
        self.buffered += data.count
        self.cond.broadcast()
      }
      self.cond.unlock()
    }, completionHandler: { [weak self] error in
      guard let self else { return }
      self.cond.lock()
      if self.generation == gen {
        self.finished = true
        self.failed = error != nil
      }
      self.cond.broadcast()
      self.cond.unlock()
    })
    cond.lock()
    request = id
    cond.unlock()
    return true
  }

  func read(_ buf: UnsafeMutablePointer<UInt8>, _ max: Int) -> Int {
    cond.lock()
    defer { cond.unlock() }
    while chunks.isEmpty && !finished && !stopped { cond.wait() }
    if chunks.isEmpty { return failed || stopped ? -1 : 0 }
    var copied = 0
    while copied < max, let c = chunks.first {
      let n = min(c.count - head, max - copied)
      c.withUnsafeBytes { raw in _ = memcpy(buf + copied, raw.baseAddress! + head, n) }
      copied += n
      head += n
      if head == c.count {
        chunks.removeFirst()
        head = 0
      }
    }
    buffered -= copied
    cond.broadcast()
    return copied
  }

  func close() {
    cond.lock()
    let running = !stopped && !finished
    stopped = true
    chunks = []
    buffered = 0
    let id = request
    cond.broadcast()
    cond.unlock()
    if running { PHAssetResourceManager.default().cancelDataRequest(id) }
  }
}

/**
 * Compte les changements de la photothèque (photo prise, supprimée, sélection limitée modifiée) :
 * tant que ce numéro ne bouge pas, le JS garde sa copie de la galerie au lieu de tout relire.
 */
final class LibraryWatch: NSObject, PHPhotoLibraryChangeObserver {
  private let lock = NSLock()
  private var changes = 0
  private var registered = false

  func version() -> String {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    lock.lock()
    // On ne s'abonne qu'une fois l'accès donné : s'abonner avant ne voit rien.
    let start = !registered && (status == .authorized || status == .limited)
    if start { registered = true }
    let n = changes
    let on = registered
    lock.unlock()
    if start { PHPhotoLibrary.shared().register(self) }
    // Pas encore abonné : version inconnue, le JS relit à chaque fois.
    return on ? "\(status.rawValue):\(n)" : ""
  }

  func photoLibraryDidChange(_ changeInstance: PHChange) {
    lock.lock()
    changes += 1
    lock.unlock()
  }
}

