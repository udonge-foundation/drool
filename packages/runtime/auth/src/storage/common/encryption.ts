/**
 * AES-256-GCM encryption utilities for secure storage.
 */

import crypto from 'crypto';

import { MetaError } from '@industry/logging/errors';

import { ENCRYPTION_KEY_LENGTH } from './constants';

const IV_LENGTH = 16; // 128 bits for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128 bits for GCM auth tag

/**
 * Encrypt plaintext using AES-256-GCM.
 * @returns Encrypted data in format: iv:authTag:ciphertext (base64 encoded)
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * @throws MetaError if decryption fails (invalid format, wrong key, tampered data)
 */
export function decrypt(encryptedData: string, key: Buffer): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new MetaError('Invalid encrypted data format');
  }

  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const ciphertext = Buffer.from(parts[2], 'base64');

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new MetaError('Invalid IV or auth tag length');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Generate a new random encryption key.
 */
export function generateEncryptionKey(): Buffer {
  return crypto.randomBytes(ENCRYPTION_KEY_LENGTH);
}
