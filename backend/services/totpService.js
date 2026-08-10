// services/totpService.js — Enterprise-grade TOTP (2FA Authenticator) service.
// Uses standard HMAC-SHA1 RFC 6238 implementation and QRCode module.

const crypto = require("crypto");
const QRCode = require("qrcode");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(base32Str) {
  if (!base32Str) return Buffer.alloc(0);
  const cleanStr = base32Str.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const output = [];
  for (let i = 0; i < cleanStr.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleanStr[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateSecret(length = 20) {
  const randomBytes = crypto.randomBytes(length);
  return base32Encode(randomBytes);
}

function generateTOTP(secretBase32, timeStepOffset = 0) {
  const key = base32Decode(secretBase32);
  if (key.length === 0) return "";
  const timeStep = Math.floor(Date.now() / 1000 / 30) + timeStepOffset;
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(timeStep, 4);

  const hmac = crypto.createHmac("sha1", key).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (codeInt % 1000000).toString().padStart(6, "0");
}

function verifyTOTP(secretBase32, inputCode, window = 1) {
  if (!secretBase32 || !inputCode) return false;
  const cleanCode = String(inputCode).trim();
  if (cleanCode.length !== 6 || isNaN(Number(cleanCode))) return false;

  for (let i = -window; i <= window; i++) {
    if (generateTOTP(secretBase32, i) === cleanCode) {
      return true;
    }
  }
  return false;
}

async function getQRCodeDataURL(otpauthUrl) {
  try {
    return await QRCode.toDataURL(otpauthUrl, {
      margin: 2,
      width: 240,
      color: {
        dark: "#0f172a",
        light: "#ffffff"
      }
    });
  } catch (err) {
    console.error("Failed to generate QR Code Data URL:", err.message);
    return null;
  }
}

function getOTPAuthURL(username, secret, issuer = "Benevolate CI/CD") {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(username);
  return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  generateSecret,
  generateTOTP,
  verifyTOTP,
  getOTPAuthURL,
  getQRCodeDataURL
};
