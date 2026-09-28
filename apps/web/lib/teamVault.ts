import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

/// The team desk's key file: fresh wallets for one project, encrypted in the browser with a
/// passphrase and handed to the team as a download. Nothing here touches storage or the network.
/// The keys exist in plaintext only in memory, between generation (or decryption) and the moment
/// the page forgets them, and the only thing that ever leaves this module is ciphertext.
///
/// PBKDF2 and not scrypt because WebCrypto has no scrypt, and a dependency that handles keys is a
/// dependency to audit. 310,000 rounds of SHA-256 is OWASP's current floor for PBKDF2.

export const VAULT_KIND = "hood-team-wallets";
export const PBKDF2_ITERATIONS = 310_000;
export const MIN_PASSPHRASE = 12;
export const MAX_WALLETS = 40;

/// Bounds on what a loaded file may ask for. The floor keeps a hand-edited file from quietly
/// weakening the next save; the ceiling keeps a hostile file from freezing the tab for minutes.
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export interface VaultKey {
  address: Address;
  privateKey: Hex;
}

export interface VaultFile {
  version: 1;
  kind: typeof VAULT_KIND;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  /// base64 of AES-GCM(JSON.stringify(VaultKey[])), tag included, as WebCrypto returns it
  data: string;
  /// In the clear on purpose: the team wallets are public on the token page anyway, and a file you
  /// can identify without the passphrase is a file you do not lose track of.
  addresses: Address[];
  label: string;
  createdAt: string;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/// `n` new wallets. viem draws the keys from the platform's CSPRNG.
export function generateTeamKeys(n: number): VaultKey[] {
  const count = Math.max(1, Math.min(MAX_WALLETS, Math.floor(n)));
  return Array.from({ length: count }, () => {
    const privateKey = generatePrivateKey();
    return { address: privateKeyToAccount(privateKey).address, privateKey };
  });
}

/// Why a passphrase will not do, or null. The same rule for making a file and for nothing else:
/// an old file with a shorter passphrase still opens.
export function passphraseProblem(passphrase: string, confirm: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE) return `At least ${MIN_PASSPHRASE} characters.`;
  if (passphrase !== confirm) return "The two passphrases do not match.";
  return null;
}

export async function encryptVault(keys: VaultKey[], passphrase: string, label = ""): Promise<VaultFile> {
  if (keys.length === 0) throw new Error("No wallets to encrypt.");
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(keys.map((k) => ({ address: k.address, privateKey: k.privateKey }))));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource));
  // The buffer is ours; zero it rather than leave it for the collector. The JS strings the keys
  // came from cannot be wiped, which is why nothing keeps them around longer than it must.
  plain.fill(0);
  return {
    version: 1,
    kind: VAULT_KIND,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(sealed),
    addresses: keys.map((k) => k.address),
    label: label.trim().slice(0, 80),
    createdAt: new Date().toISOString(),
  };
}

/// A file as loaded, checked for shape before any of it reaches WebCrypto. Throws with a sentence.
export function parseVaultFile(text: string): VaultFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("That file is not JSON."); }
  const f = raw as Partial<VaultFile> | null;
  if (!f || typeof f !== "object" || f.kind !== VAULT_KIND || f.version !== 1) {
    throw new Error("That is not a team wallet file.");
  }
  const iterations = f.kdf?.iterations;
  if (f.kdf?.name !== "PBKDF2" || f.kdf.hash !== "SHA-256" || typeof iterations !== "number"
    || !Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS
    || typeof f.kdf.salt !== "string") {
    throw new Error("The file's key derivation settings are not ones this page accepts.");
  }
  if (f.cipher?.name !== "AES-GCM" || typeof f.cipher.iv !== "string" || typeof f.data !== "string") {
    throw new Error("The file's cipher settings are not ones this page accepts.");
  }
  if (!Array.isArray(f.addresses)) throw new Error("The file has no address list.");
  return f as VaultFile;
}

/// The keys back, or a throw. AES-GCM authenticates, so a wrong passphrase and a tampered file
/// fail the same way and nothing half-decrypted is ever returned. Every key is then checked
/// against the address the file claims for it, so the list the team reads is the list they sign
/// with.
export async function decryptVault(file: VaultFile, passphrase: string): Promise<VaultKey[]> {
  const key = await deriveKey(passphrase, fromBase64(file.kdf.salt), file.kdf.iterations);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(file.cipher.iv) as BufferSource }, key, fromBase64(file.data) as BufferSource,
    ));
  } catch {
    throw new Error("Wrong passphrase, or the file was changed.");
  }
  let list: unknown;
  try { list = JSON.parse(new TextDecoder().decode(plain)); } finally { plain.fill(0); }
  if (!Array.isArray(list)) throw new Error("The file decrypted to something that is not a wallet list.");
  const keys = list.map((entry) => {
    const k = entry as Partial<VaultKey>;
    if (typeof k.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k.privateKey)) {
      throw new Error("The file holds an entry that is not a private key.");
    }
    const address = privateKeyToAccount(k.privateKey as Hex).address;
    if (typeof k.address !== "string" || k.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error("A key in the file does not match the address stored beside it.");
    }
    return { address, privateKey: k.privateKey as Hex };
  });
  const listed = new Set(file.addresses.map((a) => String(a).toLowerCase()));
  if (listed.size !== keys.length || keys.some((k) => !listed.has(k.address.toLowerCase()))) {
    throw new Error("The file's public address list does not match the keys inside it.");
  }
  return keys;
}

/// A download name nobody has to rename: the label if there is one, the count and the date.
export function vaultFileName(file: VaultFile): string {
  const label = file.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `hood-team-${label || "wallets"}-${file.addresses.length}-${file.createdAt.slice(0, 10)}.json`;
}
