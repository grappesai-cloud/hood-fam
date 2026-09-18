import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";

/// Where a key lives when an agent has to hold one. AES-256-GCM, scrypt, file mode 600.
/// Nothing here ever prints a private key: unlocking returns a signer, not the secret.
export const KEYSTORE_PATH = process.env.HOOD_KEYSTORE ?? join(homedir(), ".hood", "wallets.json");

interface StoredWallet {
  label: string;
  address: `0x${string}`;
  /// AES-256-GCM
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  data: string;
  createdAt: string;
  note?: string;
}

interface KeystoreFile {
  version: 1;
  wallets: StoredWallet[];
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 } as const;

function read(): KeystoreFile {
  if (!existsSync(KEYSTORE_PATH)) return { version: 1, wallets: [] };
  return JSON.parse(readFileSync(KEYSTORE_PATH, "utf8")) as KeystoreFile;
}

function persist(file: KeystoreFile) {
  // The mode goes on the write, not after it: creating the file with the umask's own permissions
  // and tightening it afterwards leaves a window where anybody on the box can read it, and chmod
  // does not change the mode of a file that already existed.
  mkdirSync(dirname(KEYSTORE_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(KEYSTORE_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(KEYSTORE_PATH, 0o600);
}

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 });
}

function encrypt(privateKey: string, password: string) {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = derive(password, salt);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(privateKey, "utf8"), c.final()]);
  return { salt: salt.toString("hex"), iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("hex") };
}

function decrypt(w: StoredWallet, password: string): `0x${string}` {
  const key = derive(password, Buffer.from(w.salt, "hex"));
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(w.iv, "hex"));
  d.setAuthTag(Buffer.from(w.tag, "hex"));
  try {
    const out = Buffer.concat([d.update(Buffer.from(w.data, "hex")), d.final()]);
    return out.toString("utf8") as `0x${string}`;
  } catch {
    throw new Error(`wrong password for wallet "${w.label}"`);
  }
}

export function listWallets(): { label: string; address: `0x${string}`; createdAt: string; note?: string }[] {
  return read().wallets.map(({ label, address, createdAt, note }) => ({ label, address, createdAt, note }));
}

export function hasWallet(label: string): boolean {
  return read().wallets.some((w) => w.label === label);
}

/// Generates a key that has never existed anywhere else. Every project gets fresh wallets.
export function newWallet(label: string, password: string, note?: string) {
  return importWallet(label, generatePrivateKey(), password, note);
}

export function importWallet(label: string, privateKey: string, password: string, note?: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("private key must be 0x + 64 hex characters");
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  const file = read();
  if (file.wallets.some((w) => w.label === label)) throw new Error(`wallet "${label}" already exists`);
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  file.wallets.push({
    label,
    address: account.address,
    cipher: "aes-256-gcm",
    ...encrypt(privateKey, password),
    createdAt: new Date().toISOString(),
    note,
  });
  persist(file);
  return { label, address: account.address };
}

/// Returns a signer. The secret stays in this process and is never returned to a caller.
export function unlockWallet(label: string, password: string): PrivateKeyAccount {
  const w = read().wallets.find((x) => x.label === label);
  if (!w) throw new Error(`no wallet named "${label}"`);
  const account = privateKeyToAccount(decrypt(w, password));
  const expected = Buffer.from(w.address.toLowerCase());
  const actual = Buffer.from(account.address.toLowerCase());
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("keystore entry is corrupt: the key does not match its address");
  }
  return account;
}

export function removeWallet(label: string) {
  const file = read();
  const before = file.wallets.length;
  file.wallets = file.wallets.filter((w) => w.label !== label);
  if (file.wallets.length === before) throw new Error(`no wallet named "${label}"`);
  persist(file);
}
