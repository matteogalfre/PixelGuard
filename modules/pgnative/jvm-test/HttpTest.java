import expo.modules.pgnative.MiniServer;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Le petit serveur qui donne « Prepare my PC » au navigateur du PC : pages, téléchargement, refus. */
public class HttpTest {
  static String[] get(String method, String url) throws IOException {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setRequestMethod(method);
    int code = c.getResponseCode();
    InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
    String body = in == null ? "" : new String(in.readAllBytes(), StandardCharsets.UTF_8);
    return new String[] { String.valueOf(code), String.valueOf(c.getHeaderField("Content-Type")),
        String.valueOf(c.getHeaderField("Content-Disposition")), body };
  }

  public static void main(String[] a) throws Exception {
    byte[] cmd = Files.readAllBytes(Paths.get(a[0]));
    Map<String, MiniServer.Page> pages = new HashMap<>();
    pages.put("/", new MiniServer.Page("text/html; charset=utf-8", "<h1>PixelGuard</h1>".getBytes(StandardCharsets.UTF_8), null));
    pages.put("/PixelGuard-PC.cmd", new MiniServer.Page("application/octet-stream", cmd, "PixelGuard-PC.cmd"));
    pages.put("/pg", new MiniServer.Page("text/plain; charset=utf-8", cmd, null));
    MiniServer s = new MiniServer(8800, pages);
    String base = "http://127.0.0.1:" + s.port();
    String[] home = get("GET", base + "/?x=1");
    String[] file = get("GET", base + "/PixelGuard-PC.cmd");
    String[] head = get("HEAD", base + "/pg");
    String[] missing = get("GET", base + "/etc/passwd");
    String[] post = get("POST", base + "/");
    System.out.println("page : " + home[0] + " " + home[1] + " « " + home[3] + " »");
    System.out.println("fichier : " + file[0] + " " + file[2] + ", identique=" + Arrays.equals(file[3].getBytes(StandardCharsets.UTF_8), cmd));
    System.out.println("HEAD : " + head[0] + " " + head[1] + ", corps vide=" + head[3].isEmpty());
    System.out.println("inconnu : " + missing[0] + ", POST : " + post[0]);
    System.out.println("adresse du téléphone (ici le Mac) : " + MiniServer.localIpv4() + ", port " + s.port());
    s.stop();
    // Écoute sur une seule adresse, et refus d'un en-tête qui casserait la réponse.
    MiniServer only = new MiniServer(0, pages, InetAddress.getByName("127.0.0.1"));
    System.out.println("adresse unique : " + get("GET", "http://127.0.0.1:" + only.port() + "/")[0]);
    only.stop();
    String injected;
    try { new MiniServer.Page("text/plain", new byte[0], "a\r\nSet-Cookie: x"); injected = "ACCEPTÉ"; } catch (IllegalArgumentException e) { injected = "refusé"; }
    System.out.println("en-tête piégé : " + injected);
    Thread.sleep(200);
    String after;
    try { get("GET", base + "/"); after = "ENCORE OUVERT"; } catch (IOException e) { after = "fermé"; }
    System.out.println("après arrêt : " + after);
  }
}
