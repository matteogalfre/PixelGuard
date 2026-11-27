package expo.modules.pgnative;

import com.hierynomus.msdtyp.AccessMask;
import com.hierynomus.mserref.NtStatus;
import com.hierynomus.msfscc.FileAttributes;
import com.hierynomus.msfscc.fileinformation.FileIdBothDirectoryInformation;
import com.hierynomus.msfscc.fileinformation.FileStandardInformation;
import com.hierynomus.mssmb2.SMB2CreateDisposition;
import com.hierynomus.mssmb2.SMB2ImpersonationLevel;
import com.hierynomus.mssmb2.SMB2ShareAccess;
import com.hierynomus.mssmb2.SMBApiException;
import com.hierynomus.protocol.commons.Factory;
import com.hierynomus.smbj.SmbConfig;
import com.hierynomus.smbj.auth.AuthenticateResponse;
import com.hierynomus.smbj.auth.AuthenticationContext;
import com.hierynomus.smbj.auth.Authenticator;
import com.hierynomus.smbj.auth.NtlmAuthenticator;
import com.hierynomus.smbj.connection.ConnectionContext;
import com.hierynomus.smbj.session.Session;
import com.hierynomus.smbj.share.DiskShare;
import com.hierynomus.smbj.share.File;
import com.hierynomus.smbj.share.NamedPipe;
import com.hierynomus.smbj.share.PipeShare;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * Le cœur SMB en Java pur (sans Android), testable sur un ordinateur : envoi en flux continu,
 * relecture MD5, liste des dossiers partagés (SRVSVC) et nom NetBIOS d'un PC.
 */
public final class SmbCore {
  private SmbCore() {}

  /** Taille d'une écriture SMB : 1 Mo, ou moins si le PC l'impose. */
  public static final int CHUNK = 1 << 20;
  /** Écritures envoyées sans attendre la réponse du PC, par fichier. */
  public static final int DEPTH = 4;

  public interface Progress {
    void onBytes(long done);
  }

  public interface Cancel {
    boolean get();
  }

  public static final class Exists extends IOException {
    public Exists() {
      super("Déjà sur le PC sous ce nom");
    }
  }

  /** Le « .part » est ouvert par quelqu'un d'autre (un autre téléphone envoie le même nom). */
  public static final class Busy extends IOException {
    public Busy() {
      super("Le PC garde ce fichier ouvert (autre appareil, ou envoi coupé à l'instant) : il repartira à la prochaine sauvegarde");
    }
  }

  public static final class Cancelled extends IOException {
    public Cancelled() {
      super("Arrêté");
    }
  }

  /** `encrypt` : demander le chiffrement SMB 3 (AES) ; la signature reste de toute façon. */
  public static SmbConfig config(boolean encrypt) {
    return config(encrypt, new Pin(""));
  }

  public static SmbConfig config(boolean encrypt, Pin pin) {
    return config(encrypt, pin, true, null);
  }

  /**
   * Le nom NetBIOS que le PC annonce dans son défi NTLM (`seen`), et celui qu'il doit annoncer
   * (`expected`, vide : pas de contrôle). Windows change d'identifiant SMB à chaque démarrage,
   * pas de nom : c'est le nom qui dit si c'est bien le PC appairé.
   */
  public static final class Pin {
    public final String expected;
    public volatile String seen = null;
    public volatile boolean mismatch = false;

    public Pin(String expected) {
      this.expected = expected == null ? "" : expected.trim();
    }
  }

  private static int le16(byte[] b, int i) {
    return (b[i] & 0xff) | (b[i + 1] & 0xff) << 8;
  }

  private static int le32(byte[] b, int i) {
    return le16(b, i) | le16(b, i + 2) << 16;
  }

  /**
   * Cherche un défi NTLM (message de type 2) dans un jeton SPNEGO. Renvoie null s'il n'y en a pas,
   * "" s'il n'annonce pas de nom NetBIOS (MsvAvNbComputerName), sinon ce nom.
   */
  public static String ntlmServerName(byte[] token) {
    if (token == null) return null;
    byte[] sig = {'N', 'T', 'L', 'M', 'S', 'S', 'P', 0};
    outer:
    for (int i = 0; i + 48 <= token.length; i++) {
      for (int k = 0; k < sig.length; k++) {
        if (token[i + k] != sig[k]) continue outer;
      }
      if (le32(token, i + 8) != 2) return null;
      int len = le16(token, i + 40);
      long off = le32(token, i + 44) & 0xffffffffL;
      long end = i + off + len;
      if (end > token.length) return "";
      int p = (int) (i + off);
      while (p + 4 <= end) {
        int id = le16(token, p);
        int n = le16(token, p + 2);
        if (id == 0 || p + 4 + n > end) break;
        if (id == 1) return new String(token, p + 4, n, StandardCharsets.UTF_16LE);
        p += 4 + n;
      }
      return "";
    }
    return null;
  }

  /**
   * NTLM de smbj, avec un contrôle avant de répondre au défi : si le PC annonce un autre nom que
   * celui appairé, on s'arrête là. Ni l'utilisateur ni la réponse au mot de passe ne partent.
   */
  static final class PinnedNtlm implements Authenticator {
    private final NtlmAuthenticator inner = new NtlmAuthenticator();
    private final Pin pin;

    PinnedNtlm(Pin pin) {
      this.pin = pin;
    }

    @Override
    public void init(SmbConfig config) {
      inner.init(config);
    }

    @Override
    public boolean supports(AuthenticationContext context) {
      return inner.supports(context);
    }

    @Override
    public AuthenticateResponse authenticate(AuthenticationContext context, byte[] gssToken, ConnectionContext connectionContext)
        throws IOException {
      String name = ntlmServerName(gssToken);
      if (name != null) {
        pin.seen = name;
        if (!pin.expected.isEmpty() && !name.equalsIgnoreCase(pin.expected)) {
          pin.mismatch = true;
          throw new IOException("Ce n'est pas le PC appairé");
        }
      }
      return inner.authenticate(context, gssToken, connectionContext);
    }
  }

  /**
   * `signing` : signature exigée (tout sauf l'invité, qui n'a pas de clé de session). Sans elle,
   * un PC qui ne l'exige pas (Windows 10, Mac) accepterait des échanges non signés quand le
   * chiffrement est coupé : quelqu'un sur le réseau pourrait fausser la copie puis la relecture
   * MD5. `sockets` : les sockets du réseau Wi-Fi (null : réseau par défaut).
   */
  public static SmbConfig config(boolean encrypt, Pin pin, boolean signing, javax.net.SocketFactory sockets) {
    SmbConfig.Builder b = SmbConfig.builder();
    if (sockets != null) b.withSocketFactory(sockets);
    return b
        .withSigningRequired(signing)
        .withAuthenticators(new Factory.Named<Authenticator>() {
          @Override
          public String getName() {
            return "NTLM";
          }

          @Override
          public Authenticator create() {
            return new PinnedNtlm(pin);
          }
        })
        .withSecurityProvider(new HybridSecurityProvider())
        .withTimeout(60, TimeUnit.SECONDS)
        .withSoTimeout(90, TimeUnit.SECONDS)
        .withBufferSize(CHUNK)
        .withDfsEnabled(false)
        // Chiffre tout le contenu en SMB 3 (AES). Sans ça, les fichiers sont seulement signés :
        // personne ne peut les modifier en route, mais tout le monde sur le réseau peut les lire.
        .withEncryptData(encrypt)
        .build();
  }

  public static String smbPath(String path) {
    String p = path.replace('/', '\\');
    while (p.startsWith("\\")) p = p.substring(1);
    while (p.endsWith("\\")) p = p.substring(0, p.length() - 1);
    return p;
  }

  static boolean notFound(SMBApiException e) {
    NtStatus st = e.getStatus();
    return st == NtStatus.STATUS_OBJECT_NAME_NOT_FOUND || st == NtStatus.STATUS_OBJECT_PATH_NOT_FOUND
        || st == NtStatus.STATUS_NO_SUCH_FILE || st == NtStatus.STATUS_NOT_FOUND;
  }

  /** Crée chaque niveau sans demander avant s'il existe : un aller-retour par niveau. */
  public static void mkdirs(DiskShare share, String path) {
    String current = "";
    for (String part : smbPath(path).split("\\\\")) {
      if (part.isEmpty()) continue;
      current = current.isEmpty() ? part : current + "\\" + part;
      try {
        share.mkdir(current);
      } catch (SMBApiException e) {
        if (e.getStatus() != NtStatus.STATUS_OBJECT_NAME_COLLISION) throw e;
      }
    }
  }

  /**
   * Taille de chaque fichier, lue directement sur le fichier et pas dans la liste du dossier
   * (Windows peut y montrer une taille pas encore à jour, ou une liste incomplète). -1 s'il
   * n'existe pas.
   */
  public static long[] stat(DiskShare share, List<String> paths) {
    long[] out = new long[paths.size()];
    for (int i = 0; i < out.length; i++) {
      try {
        out[i] = share.getFileInformation(smbPath(paths.get(i)), FileStandardInformation.class).getEndOfFile();
      } catch (SMBApiException e) {
        if (!notFound(e)) throw e;
        out[i] = -1;
      }
    }
    return out;
  }

  /** Contenu d'un dossier (vide s'il n'existe pas encore). */
  public static List<FileIdBothDirectoryInformation> list(DiskShare share, String dir) {
    try {
      List<FileIdBothDirectoryInformation> out = new ArrayList<>();
      for (FileIdBothDirectoryInformation f : share.list(smbPath(dir))) {
        String n = f.getFileName();
        if (!".".equals(n) && !"..".equals(n)) out.add(f);
      }
      return out;
    } catch (SMBApiException e) {
      if (notFound(e)) return new ArrayList<>();
      throw e;
    }
  }

  private static int readChunk(InputStream in, byte[] buf, int max) throws IOException {
    int filled = 0;
    while (filled < max) {
      int n = in.read(buf, filled, max - filled);
      if (n < 0) break;
      filled += n;
    }
    return filled;
  }

  private static void drain(ArrayDeque<Future<Long>> inflight) {
    while (!inflight.isEmpty()) {
      try {
        inflight.poll().get(5, TimeUnit.SECONDS);
      } catch (Exception ignored) {
        // coupé ou refusé : la reprise repartira de toute façon avant ces écritures
      }
    }
  }

  private static long await(Future<Long> f) throws IOException {
    try {
      Long n = f.get(120, TimeUnit.SECONDS);
      return n == null ? 0 : n;
    } catch (java.util.concurrent.ExecutionException e) {
      Throwable c = e.getCause();
      if (c instanceof IOException) throw (IOException) c;
      if (c instanceof RuntimeException) throw (RuntimeException) c;
      throw new IOException(c);
    } catch (java.util.concurrent.TimeoutException e) {
      // Une coupure comme une autre : le « .part » est gardé et l'envoi reprendra.
      throw new com.hierynomus.protocol.transport.TransportException("Le PC ne répond plus");
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new Cancelled();
    }
  }

  /** Ouvre (ou rouvre) la source : il faut pouvoir la relire depuis le début. */
  public interface Source {
    InputStream open() throws IOException;
  }

  /** En dessous de cette taille, recommencer coûte moins que vérifier la reprise. */
  public static final long RESUME_MIN = 8L << 20;
  private static final int RESUME_PROBE = 64 * 1024;

  private static void skipFully(InputStream in, long n) throws IOException {
    if (in instanceof java.security.DigestInputStream) {
      // L'empreinte doit couvrir tout l'original : on lit ce qu'on aurait sauté.
      byte[] tmp = new byte[64 * 1024];
      while (n > 0) {
        int k = in.read(tmp, 0, (int) Math.min(tmp.length, n));
        if (k < 0) throw new IOException("Fichier plus court que prévu");
        n -= k;
      }
      return;
    }
    while (n > 0) {
      long k = in.skip(n);
      if (k <= 0) {
        if (in.read() < 0) throw new IOException("Fichier plus court que prévu");
        k = 1;
      }
      n -= k;
    }
  }

  private static int readAt(File file, byte[] buf, long offset, int len) {
    int got = 0;
    while (got < len) {
      int n = file.read(buf, offset + got, got, len - got);
      if (n <= 0) break;
      got += n;
    }
    return got;
  }

  /**
   * Un « .part » laissé par un envoi coupé. Les DEPTH dernières écritures étaient peut-être
   * encore en route quand il a été coupé : le PC a pu appliquer une écriture plus loin sans la
   * précédente, et laisser un trou de zéros. Tout ce qui précède `fin - DEPTH × CHUNK` a en
   * revanche été confirmé. On reprend donc à ce point-là, si les 64 Ko juste avant sont
   * identiques au même endroit de l'original. Renvoie l'octet où reprendre (0 sinon) et laisse
   * `in` positionné dessus.
   */
  static long resumeOffset(File file, InputStream in, long existing, long expected) throws IOException {
    if (existing < RESUME_MIN || expected <= existing) return 0;
    long start = existing - (long) DEPTH * CHUNK;
    int probe = (int) Math.min(RESUME_PROBE, start);
    if (start <= 0 || probe <= 0) return 0;
    byte[] remote = new byte[probe];
    if (readAt(file, remote, start - probe, probe) != probe) return 0;
    skipFully(in, start - probe);
    byte[] local = new byte[probe];
    if (readChunk(in, local, probe) != probe) return 0;
    return Arrays.equals(remote, local) ? start : 0;
  }

  /**
   * Écrit la source sous « target.part » en gardant DEPTH écritures en vol (le Wi-Fi ne reste
   * jamais à vide en attendant les accusés de réception), puis renomme en « target ».
   * Si `mayResume` (l'appelant sait que ce « .part » vient de cet original), un envoi coupé est
   * repris là où il s'était arrêté, après contrôle de ses 64 derniers Ko. Un envoi coupé à son
   * tour garde son « .part » pour la prochaine fois. Si `keep` est faux, le fichier est effacé
   * à la fin (test de vitesse). Renvoie la taille du fichier sur le PC.
   */
  public static long upload(DiskShare share, Source source, String target, long expected, int maxWrite,
                            boolean keep, boolean mayResume, Progress progress, Cancel cancel) throws IOException {
    return upload(share, source, target, expected, maxWrite, keep, mayResume, progress, cancel, null);
  }

  /**
   * Pareil, et `digest` (si non nul) reçoit tout l'original tel qu'il a été lu et envoyé, reprise
   * comprise : son MD5 est rangé dans l'index, et « Libérer de la place » n'aura plus qu'à relire
   * la copie du PC.
   */
  public static long upload(DiskShare share, Source source, String target, long expected, int maxWrite,
                            boolean keep, boolean mayResume, Progress progress, Cancel cancel,
                            MessageDigest digest) throws IOException {
    int chunk = Math.max(4096, Math.min(CHUNK, maxWrite));
    String finalPath = smbPath(target);
    String part = finalPath + ".part";
    // Ouvert en exclusif (lecture partagée seulement) : si un autre téléphone envoie le même nom
    // au même moment, le second est refusé au lieu de mélanger les deux fichiers.
    File file;
    try {
      file = share.openFile(
          part,
          EnumSet.of(AccessMask.GENERIC_READ, AccessMask.GENERIC_WRITE, AccessMask.DELETE),
          EnumSet.of(FileAttributes.FILE_ATTRIBUTE_NORMAL),
          keep ? EnumSet.of(SMB2ShareAccess.FILE_SHARE_READ) : SMB2ShareAccess.ALL,
          keep ? SMB2CreateDisposition.FILE_OPEN_IF : SMB2CreateDisposition.FILE_OVERWRITE_IF,
          null);
    } catch (SMBApiException e) {
      if (e.getStatus() == NtStatus.STATUS_SHARING_VIOLATION) throw new Busy();
      throw e;
    }
    boolean ok = false;
    boolean resumable = false;
    InputStream in = null;
    long acked = 0;
    try {
      in = open(source, digest);
      long existing = keep ? file.getFileInformation(FileStandardInformation.class).getEndOfFile() : 0;
      long start = mayResume ? resumeOffset(file, in, existing, expected) : 0;
      // En reprise, tout ce qui suit le point de reprise est réécrit (un éventuel trou disparaît)
      // jusqu'au bout de l'original, plus long que le « .part » : rien à tronquer.
      if (start == 0 && existing > 0) {
        // Rien à reprendre : on repart d'un fichier vide, et d'une source relue du début.
        file.setLength(0);
        in.close();
        in = open(source, digest);
      }
      long issued = start;
      acked = start;
      progress.onBytes(acked);
      // DEPTH+1 tampons : on remplit le suivant pendant que les DEPTH autres sont en vol. Une petite
      // photo n'en prend qu'à sa taille : pas 5 Mo pour une image WhatsApp de 200 Ko.
      long left = Math.max(1, expected - start);
      int size = (int) Math.min(chunk, Math.max(4096, expected < 0 ? chunk : left));
      int count = expected < 0 ? DEPTH + 1 : (int) Math.min(DEPTH + 1, (left + size - 1) / size + 1);
      byte[][] buffers = new byte[count][size];
      ArrayDeque<Future<Long>> inflight = new ArrayDeque<>();
      ArrayDeque<Integer> lengths = new ArrayDeque<>();
      int slot = 0;
      try {
        while (true) {
          if (cancel.get()) throw new Cancelled();
          byte[] buf = buffers[slot];
          slot = (slot + 1) % buffers.length;
          int n = readChunk(in, buf, size);
          if (n <= 0) break;
          while (inflight.size() >= Math.min(DEPTH, buffers.length - 1)) {
            long w = await(inflight.poll());
            int len = lengths.poll();
            if (w != len) throw new IOException("Écriture incomplète sur le PC");
            acked += w;
            progress.onBytes(acked);
          }
          inflight.add(file.writeAsync(buf, issued, 0, n));
          lengths.add(n);
          issued += n;
        }
        while (!inflight.isEmpty()) {
          long w = await(inflight.poll());
          int len = lengths.poll();
          if (w != len) throw new IOException("Écriture incomplète sur le PC");
          acked += w;
          progress.onBytes(acked);
        }
      } catch (Cancelled | com.hierynomus.protocol.transport.TransportException
               | com.hierynomus.smbj.common.SMBRuntimeException e) {
        // Arrêt ou coupure réseau : ce qui est déjà écrit pourra servir à la reprise. On laisse
        // d'abord revenir les écritures encore en route (quelques secondes au plus).
        resumable = keep;
        drain(inflight);
        throw e;
      }
      if (expected >= 0 && acked != expected) {
        throw new IOException("Copie incomplète (" + acked + " sur " + expected + " octets)");
      }
      if (keep) {
        try {
          file.rename(finalPath, false);
        } catch (SMBApiException e) {
          if (e.getStatus() == NtStatus.STATUS_OBJECT_NAME_COLLISION) throw new Exists();
          throw e;
        }
        ok = true;
      }
    } finally {
      if (in != null) {
        try {
          in.close();
        } catch (Exception ignored) {
        }
      }
      // On garde un « .part » repris plus tard seulement s'il vaut la peine.
      if (!ok && !(resumable && acked >= RESUME_MIN)) {
        try {
          file.deleteOnClose();
        } catch (Exception ignored) {
        }
      }
      try {
        file.close();
      } catch (Exception ignored) {
      }
    }
    return acked;
  }

  /** La source, relue du début, avec une empreinte remise à zéro si on en tient une. */
  private static InputStream open(Source source, MessageDigest digest) throws IOException {
    InputStream raw = source.open();
    if (digest == null) return raw;
    digest.reset();
    return new java.security.DigestInputStream(raw, digest);
  }

  public static MessageDigest newMd5() {
    try {
      return MessageDigest.getInstance("MD5");
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  public static String md5(InputStream in, Cancel cancel) throws IOException {
    MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("MD5");
    } catch (NoSuchAlgorithmException e) {
      throw new IOException(e);
    }
    byte[] buf = new byte[CHUNK];
    while (true) {
      if (cancel.get()) throw new Cancelled();
      int n = in.read(buf);
      if (n < 0) break;
      digest.update(buf, 0, n);
    }
    return hex(digest.digest());
  }

  /**
   * MD5 de la copie du PC, ou null si elle n'existe pas. On lit exactement `size` octets : si la
   * copie n'a pas cette taille, l'empreinte renvoyée ne peut pas correspondre.
   */
  public static String md5Remote(DiskShare share, String path, long size, int maxRead, Cancel cancel)
      throws IOException {
    File f;
    try {
      f = share.openFile(smbPath(path), EnumSet.of(AccessMask.GENERIC_READ), null,
          SMB2ShareAccess.ALL, SMB2CreateDisposition.FILE_OPEN, null);
    } catch (SMBApiException e) {
      if (notFound(e)) return null;
      throw e;
    }
    try {
      long onPc = f.getFileInformation(FileStandardInformation.class).getEndOfFile();
      if (onPc != size) return "taille:" + onPc;
      MessageDigest digest = MessageDigest.getInstance("MD5");
      byte[] buf = new byte[Math.max(4096, Math.min(CHUNK, maxRead))];
      long offset = 0;
      while (offset < size) {
        if (cancel.get()) throw new Cancelled();
        int want = (int) Math.min(buf.length, size - offset);
        int n = f.read(buf, offset, 0, want);
        if (n <= 0) return "court:" + offset;
        digest.update(buf, 0, n);
        offset += n;
      }
      return hex(digest.digest());
    } catch (NoSuchAlgorithmException e) {
      throw new IOException(e);
    } finally {
      try {
        f.close();
      } catch (Exception ignored) {
      }
    }
  }

  public static String hex(byte[] bytes) {
    StringBuilder sb = new StringBuilder();
    for (byte b : bytes) sb.append(String.format("%02x", b));
    return sb.toString();
  }

  /** Flux de `total` octets aléatoires (le test de vitesse n'a rien à lire sur le téléphone). */
  public static InputStream noise(long total) {
    final byte[] block = new byte[CHUNK];
    new java.util.Random().nextBytes(block);
    return new InputStream() {
      long left = total;

      @Override
      public int read() {
        if (left <= 0) return -1;
        left--;
        return block[(int) (left % block.length)] & 0xff;
      }

      @Override
      public int read(byte[] b, int off, int len) {
        if (left <= 0) return -1;
        int n = (int) Math.min(len, Math.min(left, block.length));
        System.arraycopy(block, 0, b, off, n);
        left -= n;
        return n;
      }
    };
  }

  // ------------------------------------------------------------ Liste des dossiers partagés

  private static final byte[] SRVSVC = guid(0x4b324fc8, (short) 0x1670, (short) 0x01d3,
      new byte[] {0x12, 0x78, 0x5a, 0x47, (byte) 0xbf, 0x6e, (byte) 0xe1, (byte) 0x88});
  private static final byte[] NDR = guid(0x8a885d04, (short) 0x1ceb, (short) 0x11c9,
      new byte[] {(byte) 0x9f, (byte) 0xe8, 0x08, 0x00, 0x2b, 0x10, 0x48, 0x60});
  private static final int MAX_FRAG = 4280;

  private static byte[] guid(int a, short b, short c, byte[] d) {
    ByteBuffer bb = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN);
    bb.putInt(a).putShort(b).putShort(c).put(d);
    return bb.array();
  }

  private static void header(ByteBuffer b, int ptype, int fragLen, int callId) {
    b.put((byte) 5).put((byte) 0).put((byte) ptype).put((byte) 3);
    b.put(new byte[] {0x10, 0, 0, 0});
    b.putShort((short) fragLen).putShort((short) 0).putInt(callId);
  }

  static byte[] bindPdu() {
    ByteBuffer b = ByteBuffer.allocate(72).order(ByteOrder.LITTLE_ENDIAN);
    header(b, 11, 72, 1);
    b.putShort((short) MAX_FRAG).putShort((short) MAX_FRAG).putInt(0);
    b.put((byte) 1).put((byte) 0).putShort((short) 0);
    b.putShort((short) 0).put((byte) 1).put((byte) 0);
    b.put(SRVSVC).putShort((short) 3).putShort((short) 0);
    b.put(NDR).putInt(2);
    return b.array();
  }

  static byte[] shareEnumRequest(String host) {
    ByteBuffer s = ByteBuffer.allocate(64 + host.length() * 2 + 64).order(ByteOrder.LITTLE_ENDIAN);
    String name = "\\\\" + host + "\0";
    s.putInt(0x00020000);
    s.putInt(name.length()).putInt(0).putInt(name.length());
    for (char c : name.toCharArray()) s.putChar(c);
    while (s.position() % 4 != 0) s.put((byte) 0);
    s.putInt(1); // niveau 1 : nom, type, commentaire
    s.putInt(1); // aiguillage de l'union
    s.putInt(0x00020004); // pointeur vers le conteneur
    s.putInt(0); // EntriesRead
    s.putInt(0); // Buffer vide
    s.putInt(-1); // PreferedMaximumLength
    s.putInt(0); // ResumeHandle absent
    int stubLen = s.position();
    ByteBuffer b = ByteBuffer.allocate(24 + stubLen).order(ByteOrder.LITTLE_ENDIAN);
    header(b, 0, 24 + stubLen, 2);
    b.putInt(stubLen).putShort((short) 0).putShort((short) 15); // opnum 15 : NetrShareEnum
    b.put(s.array(), 0, stubLen);
    return b.array();
  }

  private static String readString(ByteBuffer b) {
    b.getInt(); // max
    b.getInt(); // offset
    int actual = b.getInt();
    byte[] raw = new byte[actual * 2];
    b.get(raw);
    while (b.position() % 4 != 0) b.get();
    String s = new String(raw, StandardCharsets.UTF_16LE);
    return s.endsWith("\0") ? s.substring(0, s.length() - 1) : s;
  }

  static List<String> parseShareEnum(byte[] stub) throws IOException {
    ByteBuffer b = ByteBuffer.wrap(stub).order(ByteOrder.LITTLE_ENDIAN);
    if (stub.length >= 4) {
      int status = ByteBuffer.wrap(stub, stub.length - 4, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
      if (status != 0) throw new IOException("Le PC refuse de lister ses partages (" + status + ")");
    }
    List<String> out = new ArrayList<>();
    b.getInt(); // niveau
    b.getInt(); // aiguillage
    if (b.getInt() == 0) return out;
    b.getInt(); // EntriesRead
    if (b.getInt() == 0) return out;
    int count = b.getInt();
    int[] nameRef = new int[count];
    int[] type = new int[count];
    int[] remarkRef = new int[count];
    for (int i = 0; i < count; i++) {
      nameRef[i] = b.getInt();
      type[i] = b.getInt();
      remarkRef[i] = b.getInt();
    }
    for (int i = 0; i < count; i++) {
      String name = nameRef[i] != 0 ? readString(b) : "";
      if (remarkRef[i] != 0) readString(b);
      boolean disk = (type[i] & 0xff) == 0;
      boolean special = (type[i] & 0x80000000) != 0;
      if (disk && !special && !name.isEmpty() && !name.endsWith("$")) out.add(name);
    }
    return out;
  }

  /** Les dossiers partagés visibles par ce compte (sans C$, ADMIN$, IPC$...). */
  public static List<String> listShares(Session session, String host) throws IOException {
    PipeShare ipc = (PipeShare) session.connectShare("IPC$");
    try {
      NamedPipe pipe = ipc.open("srvsvc", SMB2ImpersonationLevel.Impersonation,
          EnumSet.of(AccessMask.FILE_READ_DATA, AccessMask.FILE_WRITE_DATA, AccessMask.FILE_READ_ATTRIBUTES),
          null, EnumSet.of(SMB2ShareAccess.FILE_SHARE_READ, SMB2ShareAccess.FILE_SHARE_WRITE),
          SMB2CreateDisposition.FILE_OPEN, null);
      try {
        byte[] ack = pipe.transact(bindPdu());
        if (ack.length < 4 || ack[2] != 12) throw new IOException("Liste des partages refusée");
        byte[] frag = pipe.transact(shareEnumRequest(host));
        ByteArrayOutputStream stub = new ByteArrayOutputStream();
        for (int guard = 0; guard < 64; guard++) {
          if (frag.length < 24) throw new IOException("Réponse trop courte");
          if (frag[2] == 3) throw new IOException("Liste des partages refusée");
          if (frag[2] != 2) throw new IOException("Réponse inattendue");
          int fragLen = ByteBuffer.wrap(frag, 8, 2).order(ByteOrder.LITTLE_ENDIAN).getShort() & 0xffff;
          int authLen = ByteBuffer.wrap(frag, 10, 2).order(ByteOrder.LITTLE_ENDIAN).getShort() & 0xffff;
          int end = Math.min(frag.length, fragLen) - (authLen > 0 ? authLen + 8 : 0);
          stub.write(frag, 24, end - 24);
          if ((frag[3] & 0x02) != 0) break; // dernier fragment
          byte[] next = new byte[MAX_FRAG + 64];
          int n = pipe.read(next);
          frag = Arrays.copyOf(next, Math.max(n, 0));
        }
        return parseShareEnum(stub.toByteArray());
      } finally {
        pipe.close();
      }
    } finally {
      ipc.close();
    }
  }

  // ------------------------------------------------------------ Nom NetBIOS (UDP 137)

  /** Requête « node status » : le PC répond avec son nom (DESKTOP-XXXX). */
  public static byte[] nbstatQuery(int txid) {
    ByteBuffer b = ByteBuffer.allocate(50).order(ByteOrder.BIG_ENDIAN);
    b.putShort((short) txid).putShort((short) 0).putShort((short) 1).putShort((short) 0)
        .putShort((short) 0).putShort((short) 0);
    b.put((byte) 0x20);
    byte[] name = new byte[16];
    name[0] = '*';
    for (byte c : name) {
      b.put((byte) ('A' + ((c >> 4) & 0x0f)));
      b.put((byte) ('A' + (c & 0x0f)));
    }
    b.put((byte) 0);
    b.putShort((short) 0x21).putShort((short) 1);
    return b.array();
  }

  /** Le nom de machine dans la réponse, ou null. */
  public static String nbstatName(byte[] buf, int len) {
    int p = 12;
    if (len < p + 1) return null;
    // nom de la question (souvent repris tel quel)
    while (p < len && buf[p] != 0) {
      if ((buf[p] & 0xc0) == 0xc0) {
        p += 1;
        break;
      }
      p += (buf[p] & 0xff) + 1;
    }
    p += 1;
    p += 2 + 2 + 4 + 2; // type, classe, TTL, longueur
    if (p >= len) return null;
    int count = buf[p] & 0xff;
    p += 1;
    for (int i = 0; i < count && p + 18 <= len; i++, p += 18) {
      String name = new String(buf, p, 15, StandardCharsets.US_ASCII).trim();
      int suffix = buf[p + 15] & 0xff;
      int flags = ((buf[p + 16] & 0xff) << 8) | (buf[p + 17] & 0xff);
      boolean group = (flags & 0x8000) != 0;
      if (!group && (suffix == 0x00 || suffix == 0x20) && !name.isEmpty()) return name;
    }
    return null;
  }
}
