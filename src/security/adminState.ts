import crypto from "crypto";
import { BOT_TOKEN } from "../config.js";

function adminStateEncryptionKey(): Buffer {
  const material = process.env.ADMIN_BOT_STATE_SECRET || BOT_TOKEN;
  if (!material || material.length < 24) {
    throw new Error("ADMIN_BOT_STATE_SECRET or a strong bot token is required.");
  }
  return crypto.createHash("sha256").update(`smm-up-admin-state:${material}`).digest();
}

export function encryptAdminStateSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", adminStateEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptAdminStateSecret(value: any): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", adminStateEncryptionKey(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function generateTemporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let output = "";
  for (let index = 0; index < 16; index += 1) output += alphabet[crypto.randomInt(0, alphabet.length)];
  return output;
}

export function hashActionToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
