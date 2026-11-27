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
  static String diff(byte[] got, byte[] want) {
    if (Arrays.equals(got, want)) return "identique=true";
    int i = 0;
    while (i < Math.min(got.length, want.length) && got[i] == want[i]) i++;
    return "identique=false (taille " + got.length + " au lieu de " + want.length + ", 1er écart à " + i + ")";
  }

  public static void main(String[] a) throws Exception {
    String shareDir = a[0];
    if (a.length > 1) {
      // Le PC ferme une connexion restée inactive (ici : on arrête le second serveur).
      SMBClient c2 = new SMBClient(SmbCore.config(true));
      Connection idle = c2.connect("127.0.0.1", 4446);
      Session s2 = idle.authenticate(new AuthenticationContext("test", "test".toCharArray(), null));
      DiskShare sh2 = (DiskShare) s2.connectShare("PHOTOS");
      new ProcessBuilder("kill", a[1]).start().waitFor();
      Thread.sleep(800);
      long t0 = System.nanoTime();
      String what;
      try { sh2.folderExists(""); what = "réponse ?!"; }
      catch (Exception e) { what = e.getClass().getSimpleName(); }
      // smbj ne le voit pas (isConnected reste vrai) : c'est l'aller-retour de contrôle qui le dit.
      System.out.printf("connexion fermée par le PC : isConnected=%s (smbj ne le voit pas), contrôle=%s en %.1f s%n",
          idle.isConnected(), what, (System.nanoTime() - t0) / 1e9);
      c2.close();
    }
    // Nom du PC lu dans le défi NTLM, avant de répondre : bon nom, puis un autre.
    {
      SmbCore.Pin seen = new SmbCore.Pin("");
      SMBClient c3 = new SMBClient(SmbCore.config(true, seen));
      Connection k = c3.connect("127.0.0.1", 4445);
      k.authenticate(new AuthenticationContext("test", "test".toCharArray(), null));
      k.close(); c3.close();
      SmbCore.Pin good = new SmbCore.Pin(seen.seen);
      SMBClient c4 = new SMBClient(SmbCore.config(true, good));
      Connection k4 = c4.connect("127.0.0.1", 4445);
      String okGood;
      try { k4.authenticate(new AuthenticationContext("test", "test".toCharArray(), null)); okGood = "accepté"; }
      catch (Exception e) { okGood = "REFUSÉ " + e; }
      k4.close(); c4.close();
      SmbCore.Pin bad = new SmbCore.Pin("AUTRE-PC");
      SMBClient c5 = new SMBClient(SmbCore.config(true, bad));
      Connection k5 = c5.connect("127.0.0.1", 4445);
      String okBad;
      try { k5.authenticate(new AuthenticationContext("test", "test".toCharArray(), null)); okBad = "ACCEPTÉ"; }
      catch (Exception e) { okBad = "refusé avant la réponse NTLM=" + bad.mismatch; }
      try { k5.close(); } catch (Exception e) { }
      c5.close();
      System.out.println("nom annoncé=" + seen.seen + ", même nom : " + okGood + ", autre nom : " + okBad);
    }
    SMBClient client = new SMBClient(SmbCore.config(true));
    Connection conn = client.connect("127.0.0.1", 4445);
    Session s = conn.authenticate(new AuthenticationContext("test", "test".toCharArray(), null));
    var proto = conn.getConnectionContext().getNegotiatedProtocol();
    System.out.println("dialect=" + proto.getDialect() + " maxWrite=" + proto.getMaxWriteSize() + " signed=" + s.isSigningRequired() + " chiffré=" + s.shouldEncryptData());
    System.out.println("partages=" + SmbCore.listShares(s, "127.0.0.1"));
    DiskShare share = (DiskShare) s.connectShare("PHOTOS");
    System.out.println("contrôle sur une connexion vivante=" + share.folderExists(""));
    System.out.println("liste dossier absent=" + SmbCore.list(share, "Tel/2026 Novembre").size());
    SmbCore.mkdirs(share, "Tel/2026 Novembre");
    SmbCore.mkdirs(share, "Tel/2026 Novembre");
    byte[] data = new byte[7_340_033]; new Random(7).nextBytes(data);
    long[] last = {0}; int[] calls = {0};
    long t = System.nanoTime();
    java.security.MessageDigest md1 = SmbCore.newMd5();
    long n = SmbCore.upload(share, () -> new ByteArrayInputStream(data), "Tel/2026 Novembre/IMG_1.jpg", data.length,
        proto.getMaxWriteSize(), true, false, b -> { last[0] = b; calls[0]++; }, () -> false, md1);
    String sentMd5 = SmbCore.hex(md1.digest());
    double sec = (System.nanoTime() - t) / 1e9;
    System.out.printf("envoi=%d octets, progression=%d appels (dernier %d), %.1f Mo/s%n", n, calls[0], last[0], n / sec / 1e6);
    byte[] onDisk = Files.readAllBytes(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG_1.jpg"));
    System.out.println("identique sur disque=" + Arrays.equals(onDisk, data) + ", .part restant=" + Files.exists(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG_1.jpg.part")));
    for (var f : SmbCore.list(share, "Tel/2026 Novembre")) System.out.println("  listé: " + f.getFileName() + " " + f.getEndOfFile());
    long[] st = SmbCore.stat(share, java.util.List.of("Tel/2026 Novembre/IMG_1.jpg", "Tel/2026 Novembre/absent.jpg", "Tel/absent/x.jpg"));
    System.out.println("stat direct : " + st[0] + " / " + st[1] + " / " + st[2]);
    String local = SmbCore.md5(new ByteArrayInputStream(data), () -> false);
    String remote = SmbCore.md5Remote(share, "Tel/2026 Novembre/IMG_1.jpg", data.length, proto.getMaxReadSize(), () -> false);
    System.out.println("md5 pris pendant l'envoi=remote " + sentMd5.equals(remote));
    // Petite photo : tampons à sa taille, fichier identique.
    byte[] tiny = new byte[200_000]; new Random(9).nextBytes(tiny);
    java.security.MessageDigest mdTiny = SmbCore.newMd5();
    SmbCore.upload(share, () -> new ByteArrayInputStream(tiny), "Tel/2026 Novembre/IMG-WA.jpg", tiny.length, proto.getMaxWriteSize(), true, false, b -> {}, () -> false, mdTiny);
    System.out.println("petite photo identique=" + Arrays.equals(Files.readAllBytes(Paths.get(shareDir, "Tel", "2026 Novembre", "IMG-WA.jpg")), tiny)
        + ", md5 juste=" + SmbCore.hex(mdTiny.digest()).equals(SmbCore.md5(new ByteArrayInputStream(tiny), () -> false)));
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
    java.security.MessageDigest mdBig = SmbCore.newMd5();
    SmbCore.upload(share, () -> new ByteArrayInputStream(big), bigPath, big.length, proto.getMaxWriteSize(), true, true,
        b -> { if (first[0] < 0) first[0] = b; }, () -> false, mdBig);
    System.out.println("md5 d'un envoi repris = md5 de tout l'original : " + SmbCore.hex(mdBig.digest()).equals(SmbCore.md5(new ByteArrayInputStream(big), () -> false)));
    System.out.println("repris à " + first[0] / 1048576 + " Mo, " + diff(Files.readAllBytes(Paths.get(shareDir, "Tel", "2026 Novembre", "VID_1.mp4")), big) + ", .part restant=" + Files.exists(bigPart));
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
    // Un .part avec un trou avant la fin (écritures en vol perdues à la coupure) : on reprend
    // 4 Mo plus tôt, donc le trou est réécrit.
    String holePath = "Tel/2026 Novembre/VID_3.mp4";
    byte[] holed = Arrays.copyOf(big, 12 << 20);
    Arrays.fill(holed, 10 << 20, 11 << 20, (byte) 0);
    Files.write(Paths.get(shareDir, "Tel", "2026 Novembre", "VID_3.mp4.part"), holed);
    long[] first3 = {-1};
    SmbCore.upload(share, () -> new ByteArrayInputStream(big), holePath, big.length, proto.getMaxWriteSize(), true, true,
        b -> { if (first3[0] < 0) first3[0] = b; }, () -> false);
    System.out.println("trou avant la fin : repris à " + first3[0] / 1048576 + " Mo, " + diff(Files.readAllBytes(Paths.get(shareDir, "Tel", "2026 Novembre", "VID_3.mp4")), big));
    // Deux envois vers le même nom en même temps : le second doit être refusé (Busy).
    String busyPath = "Tel/2026 Novembre/VID_4.mp4";
    java.util.concurrent.CountDownLatch started = new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
    Thread a1 = new Thread(() -> {
      try {
        SmbCore.upload(share, () -> new ByteArrayInputStream(big), busyPath, big.length, proto.getMaxWriteSize(), true, false,
            b -> { if (b > 0 && started.getCount() > 0) { started.countDown(); try { release.await(); } catch (InterruptedException e) { } } }, () -> false);
      } catch (Exception e) { System.out.println("  premier envoi : " + e); }
    });
    a1.start();
    started.await();
    String verdict;
    try {
      SmbCore.upload(share, () -> new ByteArrayInputStream(big), busyPath, big.length, proto.getMaxWriteSize(), true, false, b -> {}, () -> false);
      verdict = "second envoi ACCEPTÉ (serveur de test sans verrou de partage ?)";
    } catch (SmbCore.Busy e) { verdict = "second envoi refusé : " + e.getMessage();
    } catch (Exception e) { verdict = "second envoi : " + e; }
    release.countDown(); a1.join();
    System.out.println(verdict + ", final identique=" + Arrays.equals(Files.readAllBytes(Paths.get(shareDir, "Tel", "2026 Novembre", "VID_4.mp4")), big));
    share.close(); s.close(); conn.close(); client.close();
  }
}
