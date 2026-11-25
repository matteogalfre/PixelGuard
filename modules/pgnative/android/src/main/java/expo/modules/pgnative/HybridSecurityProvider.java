package expo.modules.pgnative;

import com.hierynomus.security.AEADBlockCipher;
import com.hierynomus.security.Cipher;
import com.hierynomus.security.DerivationFunction;
import com.hierynomus.security.Mac;
import com.hierynomus.security.MessageDigest;
import com.hierynomus.security.SecurityException;
import com.hierynomus.security.SecurityProvider;
import com.hierynomus.security.bc.BCSecurityProvider;
import com.hierynomus.security.jce.JceSecurityProvider;

/**
 * Prend d'abord la crypto du système (Conscrypt sur Android, qui utilise les instructions AES
 * du processeur), et seulement si l'algorithme manque, BouncyCastle en Java pur (MD4 pour NTLM,
 * AES-CCM...). La signature SMB3 (AES-CMAC) touche chaque octet envoyé : en Java pur elle peut
 * plafonner sous le débit du Wi-Fi.
 */
public final class HybridSecurityProvider implements SecurityProvider {
  private final SecurityProvider system = new JceSecurityProvider();
  private final SecurityProvider fallback = new BCSecurityProvider();

  @Override
  public MessageDigest getDigest(String name) throws SecurityException {
    try {
      return system.getDigest(name);
    } catch (Exception e) {
      return fallback.getDigest(name);
    }
  }

  @Override
  public Mac getMac(String name) throws SecurityException {
    try {
      return system.getMac(name);
    } catch (Exception e) {
      return fallback.getMac(name);
    }
  }

  @Override
  public Cipher getCipher(String name) throws SecurityException {
    try {
      return system.getCipher(name);
    } catch (Exception e) {
      return fallback.getCipher(name);
    }
  }

  @Override
  public AEADBlockCipher getAEADBlockCipher(String name) throws SecurityException {
    try {
      return system.getAEADBlockCipher(name);
    } catch (Exception e) {
      return fallback.getAEADBlockCipher(name);
    }
  }

  @Override
  public DerivationFunction getDerivationFunction(String name) throws SecurityException {
    try {
      return system.getDerivationFunction(name);
    } catch (Exception e) {
      return fallback.getDerivationFunction(name);
    }
  }

  /** Qui fournit quoi, pour le test de vitesse. */
  public String describe(String macName) {
    try {
      system.getMac(macName);
      return "système";
    } catch (Exception e) {
      return "Java";
    }
  }
}
