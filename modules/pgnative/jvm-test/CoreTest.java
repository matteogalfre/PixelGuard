import com.hierynomus.smbj.SMBClient;
import com.hierynomus.smbj.auth.AuthenticationContext;
import com.hierynomus.smbj.connection.Connection;
import com.hierynomus.smbj.session.Session;
import com.hierynomus.smbj.share.DiskShare;
import expo.modules.pgnative.SmbCore;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public class CoreTest {
  public static void main(String[] a) throws Exception {
    String shareDir = a[0];
    SMBClient client = new SMBClient(SmbCore.config(true));
    Connection conn = client.connect("127.0.0.1", 4445);
    Session s = conn.authenticate(new AuthenticationContext("test", "test".toCharArray(), null));
    var proto = conn.getConnectionContext().getNegotiatedProtocol();
    System.out.println("dialect=" + proto.getDialect() + " maxWrite=" + proto.getMaxWriteSize() + " signed=" + s.isSigningRequired() + " chiffré=" + s.shouldEncryptData());
    System.out.println("partages=" + SmbCore.listShares(s, "127.0.0.1"));
    DiskShare share = (DiskShare) s.connectShare("PHOTOS");
    System.out.println("liste dossier absent=" + SmbCore.list(share, "Tel/2026 Novembre").size());
    SmbCore.mkdirs(share, "Tel/2026 Novembre");
    SmbCore.mkdirs(share, "Tel/2026 Novembre");
    byte[] data = new byte[7_340_033]; new Random(7).nextBytes(data);
    long[] last = {0}; int[] calls = {0};
    long t = System.nanoTime();
    long n = SmbCore.upload(share, () -> new ByteArrayInputStream(data), "Tel/2026 Novembre/IMG_1.jpg", data.length,
        proto.getMaxWriteSize(), true, false, b -> { last[0] = b; calls[0]++; }, () -> false);
    double sec = (System.nanoTime() - t) / 1e9;
    System.out.printf("envoi=%d octets, progression=%d appels (dernier %d), %.1f Mo/s%n", n, calls[0], last[0], n / sec / 1e6);
    byte[] onDisk = Files.readAllBytes(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG_1.jpg"));
    System.out.println("identique sur disque=" + Arrays.equals(onDisk, data) + ", .part restant=" + Files.exists(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG_1.jpg.part")));
    for (var f : SmbCore.list(share, "Tel/2026 Novembre")) System.out.println("  listé: " + f.getFileName() + " " + f.getEndOfFile());
    long[] st = SmbCore.stat(share, java.util.List.of("Tel/2026 Novembre/IMG_1.jpg", "Tel/2026 Novembre/absent.jpg", "Tel/absent/x.jpg"));
    System.out.println("stat direct : " + st[0] + " / " + st[1] + " / " + st[2]);
    String local = SmbCore.md5(new ByteArrayInputStream(data), () -> false);
    String remote = SmbCore.md5Remote(share, "Tel/2026 Novembre/IMG_1.jpg", data.length, proto.getMaxReadSize(), () -> false);
    System.out.println("md5 local=remote " + local.equals(remote) + " absent=" + SmbCore.md5Remote(share, "Tel/nope.jpg", 5, proto.getMaxReadSize(), () -> false));
    try {
      SmbCore.upload(share, () -> new ByteArrayInputStream(data), "Tel/2026 Novembre/IMG_1.jpg", data.length, proto.getMaxWriteSize(), true, false, b -> {}, () -> false);
      System.out.println("collision NON détectée");
    } catch (SmbCore.Exists e) { System.out.println("collision détectée: " + e.getMessage()); }
    System.out.println("après collision, .part restant=" + Files.exists(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG_1.jpg.part")));
    try {
      int[] k = {0};
      SmbCore.upload(share, () -> new ByteArrayInputStream(data), "Tel/2026 Novembre/IMG_2.jpg", data.length, proto.getMaxWriteSize(), true, false, b -> {}, () -> ++k[0] > 3);
      System.out.println("arrêt NON pris en compte");
    } catch (SmbCore.Cancelled e) { System.out.println("arrêt ok, fichier=" + Files.exists(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG_2.jpg")) + " part=" + Files.exists(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG_2.jpg.part"))); }
    long sz = 64L << 20; t = System.nanoTime();
    SmbCore.upload(share, () -> SmbCore.noise(sz), "Tel/.pixelguard-vitesse", sz, proto.getMaxWriteSize(), false, false, b -> {}, () -> false);
    sec = (System.nanoTime() - t) / 1e9;
    System.out.printf("test de vitesse 64 Mo: %.1f Mo/s, fichier restant=%s%n", sz / sec / 1e6, Files.exists(Paths.get(shareDir, "Tel", ".pixelguard-vitesse.part")));
    // Reprise : un envoi de 20 Mo coupé vers 12 Mo garde son .part, le suivant repart de là.
    byte[] big = new byte[20 << 20]; new Random(3).nextBytes(big);
    String bigPath = "Tel/2026 Novembre/VID_1.mp4";
    java.nio.file.Path bigPart = Paths.get(shareDir, "Tel", "2026 Novembre", "VID_1.mp4.part");
    try {
      long[] seen = {0};
      SmbCore.upload(share, () -> new ByteArrayInputStream(big), bigPath, big.length, proto.getMaxWriteSize(), true, true,
          b -> seen[0] = b, () -> seen[0] > (12 << 20));
    } catch (SmbCore.Cancelled e) {
      System.out.println("coupé, .part gardé=" + Files.exists(bigPart) + " (" + Files.size(bigPart) / 1048576 + " Mo)");
    }
    long[] first = {-1};
    SmbCore.upload(share, () -> new ByteArrayInputStream(big), bigPath, big.length, proto.getMaxWriteSize(), true, true,
        b -> { if (first[0] < 0) first[0] = b; }, () -> false);
    System.out.println("repris à " + first[0] / 1048576 + " Mo, identique=" + Arrays.equals(Files.readAllBytes(Paths.get(shareDir, "Tel", "2026 Novembre", "VID_1.mp4")), big) + ", .part restant=" + Files.exists(bigPart));
    // Un .part écrit par un autre original (le téléphone ne le reconnaît pas) : on repart de zéro,
    // même si ses 64 derniers Ko ressemblent.
    byte[] other = big.clone(); other[(12 << 20) - 10] ^= 1;
    String otherPath = "Tel/2026 Novembre/VID_2.mp4";
    try {
      long[] seen = {0};
      SmbCore.upload(share, () -> new ByteArrayInputStream(other), otherPath, other.length, proto.getMaxWriteSize(), true, true,
          b -> seen[0] = b, () -> seen[0] > (12 << 20));
    } catch (SmbCore.Cancelled e) { }
    long[] first2 = {-1};
    SmbCore.upload(share, () -> new ByteArrayInputStream(big), otherPath, big.length, proto.getMaxWriteSize(), true, false,
        b -> { if (first2[0] < 0) first2[0] = b; }, () -> false);
    System.out.println(".part différent : reparti de " + first2[0] + ", identique=" + Arrays.equals(Files.readAllBytes(Paths.get(shareDir, "Tel", "2026 Novembre", "VID_2.mp4")), big));
    // Un petit fichier coupé ne laisse pas de .part (moins de 8 Mo : on recommence).
    try {
      int[] k = {0};
      SmbCore.upload(share, () -> new ByteArrayInputStream(data), "Tel/2026 Novembre/IMG_3.jpg", data.length, proto.getMaxWriteSize(), true, false, b -> {}, () -> ++k[0] > 3);
    } catch (SmbCore.Cancelled e) {
      System.out.println("petit fichier coupé, .part restant=" + Files.exists(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG_3.jpg.part")));
    }
    share.close(); s.close(); conn.close(); client.close();
  }
}
