const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'chat.db');
let db = null;

// Initialize database
async function initDatabase() {
  console.log('📊 Initializing SQLite database...');

  const SQL = await initSqlJs();

  // Load existing database if exists
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      public_key TEXT,
      private_key_encrypted TEXT,
      avatar TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Rooms table
  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'private',
      created_by INTEGER,
      pinned_message_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Messages table
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      encrypted_content TEXT,
      file_path TEXT,
      file_type TEXT,
      reply_to_id INTEGER,
      is_edited BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Room members table
  db.run(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (room_id, user_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Hidden rooms table
  db.run(`
    CREATE TABLE IF NOT EXISTS hidden_rooms (
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, room_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    )
  `);

  // Invites table
  db.run(`
    CREATE TABLE IF NOT EXISTS room_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      inviter_id INTEGER NOT NULL,
      invitee_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (inviter_id) REFERENCES users(id),
      FOREIGN KEY (invitee_id) REFERENCES users(id)
    )
  `);

  // Message Reactions table
  db.run(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reaction_emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, reaction_emoji),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Message Reads table
  db.run(`
    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  // Try applying schema updates (ALTER TABLE) for existing DBs safely
  try { db.run("ALTER TABLE rooms ADD COLUMN pinned_message_id INTEGER"); } catch (e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER"); } catch (e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN is_edited BOOLEAN DEFAULT 0"); } catch (e) {}


  // Create global room if not exists
  const result = db.exec("SELECT id FROM rooms WHERE type = 'global'");
  if (result.length === 0 || result[0].values.length === 0) {
    db.run("INSERT INTO rooms (name, type, created_by) VALUES ('General', 'global', NULL)");
    saveDatabase();
    console.log('🌐 Global room created');
  }

  console.log('✅ Database initialized successfully');
  return db;
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

// Helper to get single row
function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

// Helper to get all rows
function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper to run query
function run(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
  return db.getRowsModified();
}

// User operations
const userOps = {
  create(username, passwordHash, publicKey, privateKeyEncrypted) {
    db.run(
      'INSERT INTO users (username, password_hash, public_key, private_key_encrypted) VALUES (?, ?, ?, ?)',
      [username, passwordHash, publicKey, privateKeyEncrypted]
    );
    const result = db.exec('SELECT last_insert_rowid() as id');
    saveDatabase();
    return result[0].values[0][0];
  },

  findByUsername(username) {
    return getOne('SELECT * FROM users WHERE username = ?', [username]);
  },

  findById(id) {
    return getOne('SELECT id, username, avatar, public_key, created_at FROM users WHERE id = ?', [id]);
  },

  findAll() {
    return getAll('SELECT id, username, avatar, created_at FROM users ORDER BY username');
  },

  updateAvatar(userId, avatar) {
    run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, userId]);
  },

  updateUsername(userId, newUsername) {
    run('UPDATE users SET username = ? WHERE id = ?', [newUsername, userId]);
  },

  updatePassword(userId, passwordHash) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
  },

  updateKeys(userId, publicKey, privateKeyEncrypted) {
    run('UPDATE users SET public_key = ?, private_key_encrypted = ? WHERE id = ?', 
      [publicKey, privateKeyEncrypted, userId]);
  },

  getPrivateKey(userId) {
    return getOne('SELECT private_key_encrypted FROM users WHERE id = ?', [userId]);
  },

  getPublicKey(userId) {
    return getOne('SELECT public_key FROM users WHERE id = ?', [userId]);
  }
};

// Room operations
const roomOps = {
  create(name, type, createdBy) {
    db.run('INSERT INTO rooms (name, type, created_by) VALUES (?, ?, ?)', [name, type, createdBy]);
    const result = db.exec('SELECT last_insert_rowid() as id');
    saveDatabase();
    return result[0].values[0][0];
  },

  findAll() {
    return getAll('SELECT * FROM rooms ORDER BY type DESC, name ASC');
  },

  findById(id) {
    return getOne('SELECT * FROM rooms WHERE id = ?', [id]);
  },

  addMember(roomId, userId) {
    db.run('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', [roomId, userId]);
    saveDatabase();
  },

  getMembers(roomId) {
    return getAll(`
      SELECT u.id, u.username, u.avatar 
      FROM users u 
      JOIN room_members rm ON u.id = rm.user_id 
      WHERE rm.room_id = ?
    `, [roomId]);
  },

  getUserRooms(userId) {
    return getAll(`
      SELECT r.* FROM rooms r
      JOIN room_members rm ON r.id = rm.room_id
      WHERE rm.user_id = ?
      ORDER BY r.type DESC, r.name ASC
    `, [userId]);
  },

  pinMessage(roomId, messageId) {
    run('UPDATE rooms SET pinned_message_id = ? WHERE id = ?', [messageId, roomId]);
  },

  createInvite(roomId, inviterId, inviteeId) {
    db.run('INSERT INTO room_invites (room_id, inviter_id, invitee_id) VALUES (?, ?, ?)', [roomId, inviterId, inviteeId]);
    const result = db.exec('SELECT last_insert_rowid() as id');
    saveDatabase();
    return result[0].values[0][0];
  },

  getPendingInvites(userId) {
    return getAll(`
      SELECT i.*, r.name as room_name, u.username as inviter_name
      FROM room_invites i
      JOIN rooms r ON i.room_id = r.id
      JOIN users u ON i.inviter_id = u.id
      WHERE i.invitee_id = ? AND i.status = 'pending'
    `, [userId]);
  },

  updateInviteStatus(inviteId, status) {
    run('UPDATE room_invites SET status = ? WHERE id = ?', [status, inviteId]);
  },

  isMember(roomId, userId) {
    return getOne('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [roomId, userId]);
  },

  delete(roomId) {
    // Delete room members first
    db.run('DELETE FROM room_members WHERE room_id = ?', [roomId]);
    // Delete messages in room
    db.run('DELETE FROM messages WHERE room_id = ?', [roomId]);
    // Delete room
    db.run('DELETE FROM rooms WHERE id = ?', [roomId]);
    saveDatabase();
  }
};

// Message operations
const messageOps = {
  create(roomId, userId, encryptedContent, filePath = null, fileType = null, replyToId = null) {
    const stmt = db.prepare(
      'INSERT INTO messages (room_id, user_id, encrypted_content, file_path, file_type, reply_to_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    stmt.bind([roomId, userId, encryptedContent || '', filePath || null, fileType || null, replyToId || null]);
    stmt.step();
    stmt.free();
    const result = db.exec('SELECT last_insert_rowid() as id');
    saveDatabase();
    return result[0].values[0][0];
  },

  getByRoom(roomId, limit = 100) {
    const messages = getAll(`
      SELECT m.*, u.username, u.avatar 
      FROM messages m 
      JOIN users u ON m.user_id = u.id 
      WHERE m.room_id = ? 
      ORDER BY m.created_at ASC 
      LIMIT ?
    `, [roomId, limit]);

    // Attach reads and reactions
    messages.forEach(msg => {
      msg.reads = getAll('SELECT user_id, read_at FROM message_reads WHERE message_id = ?', [msg.id]);
      msg.reactions = getAll('SELECT user_id, reaction_emoji FROM message_reactions WHERE message_id = ?', [msg.id]);
    });
    return messages;
  },

  search(roomId, query) {
    return getAll(`
      SELECT m.*, u.username, u.avatar 
      FROM messages m 
      JOIN users u ON m.user_id = u.id 
      WHERE m.room_id = ? 
      ORDER BY m.created_at DESC 
      LIMIT 50
    `, [roomId]);
  },

  delete(messageId) {
    db.run('DELETE FROM message_reactions WHERE message_id = ?', [messageId]);
    db.run('DELETE FROM message_reads WHERE message_id = ?', [messageId]);
    db.run('DELETE FROM messages WHERE id = ?', [messageId]);
    saveDatabase();
  },

  updateContent(messageId, encryptedContent) {
    run('UPDATE messages SET encrypted_content = ?, is_edited = 1 WHERE id = ?', [encryptedContent, messageId]);
  },

  addReaction(messageId, userId, emoji) {
    db.run('INSERT OR IGNORE INTO message_reactions (message_id, user_id, reaction_emoji) VALUES (?, ?, ?)', [messageId, userId, emoji]);
    saveDatabase();
  },

  removeReaction(messageId, userId, emoji) {
    db.run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_emoji = ?', [messageId, userId, emoji]);
    saveDatabase();
  },

  markRead(messageId, userId) {
    db.run('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)', [messageId, userId]);
    saveDatabase();
  }
};

module.exports = {
  initDatabase,
  userOps,
  roomOps,
  messageOps,
  getDb: () => db
};
