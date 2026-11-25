import Darwin
import Foundation

/** Trouver le PC : réseau local seulement, comme côté Android. */
enum Net {
  struct Address {
    let ip: String
    let family: Int32
  }

  /** « \\PC », « smb://PC/ », « 192.168.1.20:4445 », « [fe80::1]:445 ». */
  static func cleanHost(_ raw: String) -> (String, Int) {
    var h = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while h.hasPrefix("\\") { h.removeFirst() }
    if h.lowercased().hasPrefix("smb://") { h.removeFirst(6) }
    while h.hasSuffix("/") || h.hasSuffix("\\") { h.removeLast() }
    if h.hasPrefix("["), let close = h.firstIndex(of: "]") {
      let inner = String(h[h.index(after: h.startIndex)..<close])
      let rest = h[h.index(after: close)...]
      if rest.hasPrefix(":"), let p = Int(rest.dropFirst()) { return (inner, p) }
      return (inner, 445)
    }
    if h.filter({ $0 == ":" }).count == 1, let i = h.lastIndex(of: ":"), i > h.startIndex,
       let p = Int(h[h.index(after: i)...]) {
      return (String(h[..<i]), p)
    }
    return (h, 445)
  }

  static func isLocal(_ sa: UnsafePointer<sockaddr>) -> Bool {
    if sa.pointee.sa_family == sa_family_t(AF_INET) {
      let a = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
      let b0 = a >> 24, b1 = (a >> 16) & 0xff
      return b0 == 10 || (b0 == 172 && b1 >= 16 && b1 <= 31) || (b0 == 192 && b1 == 168) || (b0 == 169 && b1 == 254) || b0 == 127
    }
    if sa.pointee.sa_family == sa_family_t(AF_INET6) {
      let b = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { p in withUnsafeBytes(of: p.pointee.sin6_addr) { Array($0) } }
      if b[0] == 0xfe && (b[1] & 0xc0) == 0x80 { return true } // fe80::/10
      if (b[0] & 0xfe) == 0xfc { return true } // fc00::/7
      if b[0..<15].allSatisfy({ $0 == 0 }) && b[15] == 1 { return true } // ::1
    }
    return false
  }

  private static func numeric(_ sa: UnsafePointer<sockaddr>, _ len: socklen_t) -> String {
    var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    getnameinfo(sa, len, &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST)
    return String(cString: buf)
  }

  /** Le nom est résolu une fois ; seule une adresse privée est acceptée. */
  static func resolveLocal(_ host: String) throws -> Address {
    var hints = addrinfo()
    hints.ai_family = AF_UNSPEC
    hints.ai_socktype = SOCK_STREAM
    var res: UnsafeMutablePointer<addrinfo>?
    guard !host.isEmpty, getaddrinfo(host, nil, &hints, &res) == 0, let first = res else {
      throw PgError("UNREACHABLE", "PC introuvable (\(host)). Il est allumé, sur le même Wi-Fi ?")
    }
    defer { freeaddrinfo(first) }
    var p: UnsafeMutablePointer<addrinfo>? = first
    while let ai = p {
      if let sa = ai.pointee.ai_addr, isLocal(sa) {
        return Address(ip: numeric(sa, ai.pointee.ai_addrlen), family: ai.pointee.ai_family)
      }
      p = ai.pointee.ai_next
    }
    throw PgError("NOT_LOCAL", "« \(host) » n'est pas une adresse de ton réseau local. PixelGuard n'envoie rien sur Internet.")
  }

  /** Essaie d'ouvrir une connexion TCP vers chaque adresse, toutes en même temps. */
  static func probeMany(_ targets: [(String, Int)], timeoutMs: Int) -> [Bool] {
    var fds = [Int32](repeating: -1, count: targets.count)
    var result = [Bool](repeating: false, count: targets.count)
    defer { fds.filter { $0 >= 0 }.forEach { Darwin.close($0) } }
    for (i, (ip, port)) in targets.enumerated() {
      var hints = addrinfo()
      hints.ai_flags = AI_NUMERICHOST
      hints.ai_socktype = SOCK_STREAM
      var res: UnsafeMutablePointer<addrinfo>?
      guard getaddrinfo(ip, String(port), &hints, &res) == 0, let ai = res else { continue }
      defer { freeaddrinfo(ai) }
      let fd = socket(ai.pointee.ai_family, SOCK_STREAM, IPPROTO_TCP)
      if fd < 0 { continue }
      fds[i] = fd
      var on: Int32 = 1
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
      if connect(fd, ai.pointee.ai_addr, ai.pointee.ai_addrlen) == 0 {
        result[i] = true
      } else if errno != EINPROGRESS {
        Darwin.close(fd)
        fds[i] = -1
      }
    }
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
    var pending = Set(fds.indices.filter { fds[$0] >= 0 && !result[$0] })
    while !pending.isEmpty {
      let left = Int(deadline.timeIntervalSinceNow * 1000)
      if left <= 0 { break }
      let order = Array(pending)
      var pfds = order.map { pollfd(fd: fds[$0], events: Int16(POLLOUT), revents: 0) }
      let r = poll(&pfds, nfds_t(pfds.count), Int32(left))
      if r < 0 && errno != EINTR { break }
      for (k, i) in order.enumerated() where pfds[k].revents != 0 {
        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fds[i], SOL_SOCKET, SO_ERROR, &err, &len)
        result[i] = err == 0
        pending.remove(i)
      }
    }
    return result
  }

  static func probe(_ raw: String) -> Bool {
    let (h, port) = cleanHost(raw)
    guard let addr = try? resolveLocal(h) else { return false }
    return probeMany([(addr.ip, port)], timeoutMs: 1500)[0]
  }

  /** L'adresse IPv4 du Wi-Fi (en0), si elle est privée. */
  private static func wifiIPv4() -> String? {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return nil }
    defer { freeifaddrs(first) }
    var best: String?
    var p: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = p {
      p = ifa.pointee.ifa_next
      let flags = Int32(ifa.pointee.ifa_flags)
      guard let sa = ifa.pointee.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET),
            flags & IFF_UP != 0, flags & IFF_RUNNING != 0, flags & IFF_LOOPBACK == 0, isLocal(sa) else { continue }
      let name = String(cString: ifa.pointee.ifa_name)
      let ip = numeric(sa, socklen_t(MemoryLayout<sockaddr_in>.size))
      if name == "en0" { return ip }
      if best == nil && name.hasPrefix("en") { best = ip }
    }
    return best
  }

  /** Le nom NetBIOS (DESKTOP-XXXX) : un paquet UDP 137, réponse en moins de 0,7 s. */
  private static func netbiosName(_ ip: String) -> String? {
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(137).bigEndian
    guard inet_pton(AF_INET, ip, &addr.sin_addr) == 1 else { return nil }
    let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
    if fd < 0 { return nil }
    defer { Darwin.close(fd) }
    var tv = timeval(tv_sec: 0, tv_usec: 700_000)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var query = [UInt8](repeating: 0, count: 50)
    let n = pgs_nbstat_query(&query, UInt16.random(in: 1...0x7fff))
    let sent = withUnsafePointer(to: &addr) { p in
      p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(fd, query, n, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if sent < 0 { return nil }
    var buf = [UInt8](repeating: 0, count: 1024)
    let got = recv(fd, &buf, buf.count, 0)
    if got <= 0 { return nil }
    var name = [CChar](repeating: 0, count: 32)
    return pgs_nbstat_name(buf, Int32(got), &name, name.count) == 0 ? String(cString: name) : nil
  }

  /** Le nom donné par le DNS de la box, sans l'attendre plus d'une seconde. */
  private static func dnsName(_ ip: String) -> String? {
    let done = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var found: String?
    DispatchQueue.global(qos: .utility).async {
      var addr = sockaddr_in()
      addr.sin_family = sa_family_t(AF_INET)
      addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      if inet_pton(AF_INET, ip, &addr.sin_addr) == 1 {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let rc = withUnsafePointer(to: &addr) { p in
          p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getnameinfo($0, socklen_t(MemoryLayout<sockaddr_in>.size), &host, socklen_t(host.count), nil, 0, NI_NAMEREQD)
          }
        }
        if rc == 0 {
          let n = String(cString: host)
          lock.lock()
          found = n == ip ? nil : String(n.split(separator: ".").first ?? "")
          lock.unlock()
        }
      }
      done.signal()
    }
    _ = done.wait(timeout: .now() + 1)
    lock.lock()
    defer { lock.unlock() }
    return found
  }

  /** Essaie le port SMB (445) sur toutes les adresses du Wi-Fi, 64 à la fois. */
  static func discover() throws -> [[String: Any]] {
    #if targetEnvironment(simulator)
    // Dans le simulateur, on ne balaie pas le vrai réseau du Mac : seulement le serveur de test
    // local (modules/pgnative/ios-test/run.sh --serve).
    let candidates: [(String, Int)] = [("127.0.0.1", 4445)]
    #else
    guard let own = wifiIPv4() else { throw PgError("NO_NETWORK", "Pas de Wi-Fi local (adresse IPv4 privée)") }
    let prefix = own.split(separator: ".").prefix(3).joined(separator: ".")
    let candidates = (1...254).map { "\(prefix).\($0)" }.filter { $0 != own }.map { ($0, 445) }
    #endif
    var open: [(String, Int)] = []
    var start = 0
    while start < candidates.count {
      let batch = Array(candidates[start..<min(start + 64, candidates.count)])
      for (t, ok) in zip(batch, probeMany(batch, timeoutMs: 400)) where ok { open.append(t) }
      start += 64
    }
    var out = [[String: Any]](repeating: [:], count: open.count)
    let lock = NSLock()
    DispatchQueue.concurrentPerform(iterations: open.count) { i in
      let (ip, port) = open[i]
      let name = netbiosName(ip) ?? dnsName(ip) ?? ""
      lock.lock()
      out[i] = ["ip": port == 445 ? ip : "\(ip):\(port)", "name": name]
      lock.unlock()
    }
    return out
  }
}
