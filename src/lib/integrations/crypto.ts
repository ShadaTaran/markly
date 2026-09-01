import crypto from "node:crypto";

/**
 * Server-only authenticated encryption for provider tokens (AniList access
 * tokens, and any future provider's). Never import this from a client
 * component — it reads MARKLY_INTEGRATION_ENCRYPTION_KEY, a secret that
 * must never reach the browser.
 *
 * AES-256-GCM: a random 12-byte IV per call (never reused), plus the GCM
 * authentication tag, so tampering with stored ciphertext is detectable
 * rather than silently decrypting to garbage. Output is one self-describing
 * string ("v1.<iv>.<authTag>.<ciphertext>", each base64) so the database
 * schema only needs a single text column.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const ENVELOPE_VERSION = "v1";

function getKey(): Buffer {
  const raw = process.env.MARKLY_INTEGRATION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "MARKLY_INTEGRATION_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -base64 32` and set it in .env.local.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("MARKLY_INTEGRATION_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes.");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ".",
  );
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("Unrecognized token envelope format.");
  }
  const [, ivB64, authTagB64, ciphertextB64] = parts;

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
