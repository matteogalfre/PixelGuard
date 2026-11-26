package expo.modules.pgnative;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;

/**
 * Un tout petit serveur web, le temps de préparer un PC : le téléphone donne lui-même le fichier
 * « Prepare my PC » au navigateur du PC, sur le Wi-Fi, sans passer par internet. Il ne sert que
 * les quelques pages qu'on lui donne (rien d'autre du téléphone), une requête à la fois.
 */
public final class MiniServer {
  /** Une page servie : son type, son contenu, et un nom de fichier si c'est à télécharger. */
  public static final class Page {
    final String type;
    final byte[] body;
    final String download;

    public Page(String type, byte[] body, String download) {
      this.type = type;
      this.body = body;
      this.download = download == null || download.isEmpty() ? null : download;
    }
  }

  private final ServerSocket socket;
  private final Map<String, Page> pages;
  private volatile boolean running = true;

  /** Écoute sur `port` s'il est libre, sinon sur un port au hasard. */
  public MiniServer(int port, Map<String, Page> pages) throws IOException {
    ServerSocket s;
    try {
      s = new ServerSocket(port, 8);
    } catch (IOException e) {
      s = new ServerSocket(0, 8);
    }
    socket = s;
    this.pages = pages;
    Thread t = new Thread(this::loop, "pixelguard-http");
    t.setDaemon(true);
    t.start();
  }

  public int port() {
    return socket.getLocalPort();
  }

  public void stop() {
    running = false;
    try {
      socket.close();
    } catch (IOException ignored) {
    }
  }

  private void loop() {
    while (running) {
      try (Socket c = socket.accept()) {
        c.setSoTimeout(5000);
        respond(pages, c.getInputStream(), c.getOutputStream());
      } catch (IOException e) {
        if (!running) return;
      }
    }
  }

  /** Lit une requête et y répond : GET ou HEAD d'une page connue, sinon 404 (ou 405). */
  static void respond(Map<String, Page> pages, InputStream in, OutputStream out) throws IOException {
    String[] parts = requestLine(in).split(" ");
    String method = parts.length > 0 ? parts[0] : "";
    String path = parts.length > 1 ? parts[1] : "/";
    int q = path.indexOf('?');
    if (q >= 0) path = path.substring(0, q);
    boolean known = method.equals("GET") || method.equals("HEAD");
    Page page = known ? pages.get(path) : null;
    StringBuilder h = new StringBuilder();
    byte[] body = new byte[0];
    if (!known) {
      h.append("HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nContent-Length: 0\r\n");
    } else if (page == null) {
      h.append("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n");
    } else {
      h.append("HTTP/1.1 200 OK\r\nContent-Type: ").append(page.type).append("\r\n");
      if (page.download != null) {
        h.append("Content-Disposition: attachment; filename=\"").append(page.download).append("\"\r\n");
      }
      h.append("Content-Length: ").append(page.body.length).append("\r\n");
      if (method.equals("GET")) body = page.body;
    }
    h.append("Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
    out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
    out.write(body);
    out.flush();
  }

  /** La première ligne de la requête (« GET /chemin HTTP/1.1 »), en lisant au plus 8 Ko d'en-têtes. */
  static String requestLine(InputStream in) throws IOException {
    ByteArrayOutputStream head = new ByteArrayOutputStream();
    int a = -1, b = -1, c = -1, d;
    while (head.size() < 8192 && (d = in.read()) >= 0) {
      head.write(d);
      if (a == '\r' && b == '\n' && c == '\r' && d == '\n') break;
      a = b;
      b = c;
      c = d;
    }
    String text = new String(head.toByteArray(), StandardCharsets.ISO_8859_1);
    int end = text.indexOf("\r\n");
    return end < 0 ? text : text.substring(0, end);
  }

  /** L'adresse IPv4 du téléphone sur le réseau local (Wi-Fi), ou null. */
  public static String localIpv4() {
    try {
      for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
        if (!nif.isUp() || nif.isLoopback() || nif.isVirtual()) continue;
        for (InetAddress a : Collections.list(nif.getInetAddresses())) {
          if (a instanceof Inet4Address && a.isSiteLocalAddress()) return a.getHostAddress();
        }
      }
    } catch (Exception ignored) {
    }
    return null;
  }
}
