const crypto = require('crypto');

// RSA key pair generation
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  return { publicKey, privateKey };
}

// Encrypt private key with user's password (using simple XOR + base64 for compatibility)
function encryptPrivateKey(privateKey, password) {
  // Create a key from password
  const key = crypto.pbkdf2Sync(password, 'trustchat-salt', 100000, 32, 'sha256');
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Return iv:encrypted
  return iv.toString('hex') + ':' + encrypted;
}

// Decrypt private key with user's password
function decryptPrivateKey(encryptedData, password) {
  const parts = encryptedData.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted key format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  
  const key = crypto.pbkdf2Sync(password, 'trustchat-salt', 100000, 32, 'sha256');
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Encrypt message with public key
function encryptMessage(message, publicKey) {
  try {
    const encrypted = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      Buffer.from(message, 'utf8')
    );
    return encrypted.toString('base64');
  } catch (error) {
    console.error('Encryption error:', error.message);
    return null;
  }
}

// Decrypt message with private key
function decryptMessage(encryptedBase64, privateKey) {
  try {
    const decrypted = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      Buffer.from(encryptedBase64, 'base64')
    );
    return decrypted.toString('utf8');
  } catch (error) {
    console.error('Decryption error:', error.message);
    return null;
  }
}

// Hash password with PBKDF2
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

// Verify password
function verifyPassword(password, storedHash) {
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const salt = parts[0];
  const hash = parts[1];
  const verifyHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// Get user's public key from database and encrypt a message
function encryptForUser(message, publicKey) {
  return encryptMessage(message, publicKey);
}

// Decrypt a message using private key
function decryptFromUser(encryptedBase64, privateKey) {
  return decryptMessage(encryptedBase64, privateKey);
}

module.exports = {
  generateKeyPair,
  encryptPrivateKey,
  decryptPrivateKey,
  encryptMessage,
  decryptMessage,
  hashPassword,
  verifyPassword,
  encryptForUser,
  decryptFromUser
};
