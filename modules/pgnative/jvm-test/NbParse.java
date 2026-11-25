import expo.modules.pgnative.SmbCore;
import java.io.*;
public class NbParse {
  static void name(DataOutputStream o, String n, int suffix, int flags) throws IOException {
    byte[] b = new byte[15]; java.util.Arrays.fill(b, (byte) ' ');
    System.arraycopy(n.getBytes("US-ASCII"), 0, b, 0, n.length());
    o.write(b); o.write(suffix); o.writeShort(flags);
  }
  public static void main(String[] a) throws Exception {
    // Réponse type d'un PC Windows (RFC 1002, 4.2.18)
    ByteArrayOutputStream bo = new ByteArrayOutputStream(); DataOutputStream o = new DataOutputStream(bo);
    o.writeShort(0x1234); o.writeShort(0x8400); o.writeShort(0); o.writeShort(1); o.writeShort(0); o.writeShort(0);
    byte[] q = SmbCore.nbstatQuery(1); o.write(q, 12, 34); // même nom que la question
    o.writeShort(0x21); o.writeShort(1); o.writeInt(0); 
    o.writeShort(1 + 3 * 18 + 46);
    o.write(3);
    name(o, "WORKGROUP", 0x00, 0x8400);   // nom de groupe : à ignorer
    name(o, "DESKTOP-AB12CD", 0x00, 0x0400);
    name(o, "DESKTOP-AB12CD", 0x20, 0x0400);
    o.write(new byte[46]);
    byte[] r = bo.toByteArray();
    System.out.println("nom lu=" + SmbCore.nbstatName(r, r.length));
    System.out.println("requête=" + q.length + " octets, nom codé=" + new String(q, 13, 32, "US-ASCII"));
  }
}
