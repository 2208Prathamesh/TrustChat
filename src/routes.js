const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { userOps, roomOps, messageOps } = require('./database');
const encryption = require('./encryption');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

// File filter - validate types and sizes
const fileFilter = (req, file, cb) => {
  const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const allowedVideoTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
  const allowedAudioTypes = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp3'];
  
  const ext = path.extname(file.originalname).toLowerCase();
  const isImage = allowedImageTypes.includes(file.mimetype) && ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
  const isVideo = allowedVideoTypes.includes(file.mimetype) && ['.mp4', '.webm', '.mov'].includes(ext);
  const isAudio = allowedAudioTypes.includes(file.mimetype) || ext === '.webm'; // Some browsers record .webm audio as audio/webm, others video/webm
  
  if (isImage) {
    if (file.size > 10 * 1024 * 1024) {
      return cb(new Error('Image size exceeds 10MB limit'), false);
    }
    req.fileType = 'image';
    cb(null, true);
  } else if (isVideo && !isAudio && file.mimetype !== 'audio/webm') {
    if (file.size > 50 * 1024 * 1024) {
      return cb(new Error('Video size exceeds 50MB limit'), false);
    }
    req.fileType = 'video';
    cb(null, true);
  } else if (isAudio || file.mimetype === 'audio/webm') {
    if (file.size > 10 * 1024 * 1024) {
      return cb(new Error('Audio size exceeds 10MB limit'), false);
    }
    req.fileType = 'audio';
    cb(null, true);
  } else {
    cb(new Error('Invalid file type: ' + file.mimetype), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }
});

function setupRoutes(app, io) {
  
  // ============ AUTH ROUTES ============
  
  // Register
  app.post('/api/register', (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
      }
      
      if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Username must be 3-20 characters' });
      }
      
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      
      const existing = userOps.findByUsername(username);
      if (existing) {
        return res.status(400).json({ error: 'Username already taken' });
      }
      
      const { publicKey, privateKey } = encryption.generateKeyPair();
      const privateKeyEncrypted = encryption.encryptPrivateKey(privateKey, password);
      const passwordHash = encryption.hashPassword(password);
      
      const userId = userOps.create(username, passwordHash, publicKey, privateKeyEncrypted);
      
      // Add user to ONLY global rooms automatically
      const allRooms = roomOps.findAll();
      allRooms.forEach(room => {
        if (room.type === 'global') {
          roomOps.addMember(room.id, userId);
        }
      });
      
      res.json({ success: true, userId, message: 'Registration successful' });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  });
  
  // Login
  app.post('/api/login', (req, res) => {
    try {
      const { username, password } = req.body;
      
      const user = userOps.findByUsername(username);
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      if (!encryption.verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      req.session.userId = user.id;
      req.session.username = user.username;
      
      // Auto-join user to global rooms
      const allRooms = roomOps.findAll();
      allRooms.forEach(room => {
        if (room.type === 'global') {
          roomOps.addMember(room.id, user.id);
        }
      });
      
      res.json({ 
        success: true, 
        user: {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          publicKey: user.public_key
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });
  
  // Logout
  app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
  });
  
  // Check auth status
  app.get('/api/auth', (req, res) => {
    if (req.session.userId) {
      const user = userOps.findById(req.session.userId);
      if (user) {
        return res.json({ 
          authenticated: true, 
          user: {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            publicKey: user.public_key
          }
        });
      }
    }
    res.json({ authenticated: false });
  });
  
  // ============ USER ROUTES ============
  
  app.get('/api/users', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const users = userOps.findAll();
    res.json(users);
  });
  
  app.get('/api/users/:id/public-key', (req, res) => {
    const user = userOps.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ publicKey: user.public_key });
  });
  
  // Update profile
  app.post('/api/profile/update', upload.single('avatar'), (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    try {
      const { username, currentPassword, newPassword } = req.body;
      const userId = req.session.userId;
      const user = userOps.findByUsername(req.session.username);
      
      if (!encryption.verifyPassword(currentPassword, user.password_hash)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      
      if (username && username !== user.username) {
        const existing = userOps.findByUsername(username);
        if (existing) {
          return res.status(400).json({ error: 'Username already taken' });
        }
        userOps.updateUsername(userId, username);
        req.session.username = username;
      }
      
      if (newPassword) {
        const passwordHash = encryption.hashPassword(newPassword);
        userOps.updatePassword(userId, passwordHash);
        
        const { publicKey, privateKey } = encryption.generateKeyPair();
        const privateKeyEncrypted = encryption.encryptPrivateKey(privateKey, newPassword);
        userOps.updateKeys(userId, publicKey, privateKeyEncrypted);
      }
      
      if (req.file) {
        if (user.avatar) {
          const oldPath = path.join(uploadsDir, user.avatar);
          if (fs.existsSync(oldPath)) {
            fs.unlinkSync(oldPath);
          }
        }
        userOps.updateAvatar(userId, req.file.filename);
      }
      
      res.json({ success: true, message: 'Profile updated successfully' });
    } catch (error) {
      console.error('Profile update error:', error);
      res.status(500).json({ error: 'Profile update failed' });
    }
  });
  
  // Download private key
  app.get('/api/profile/private-key', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { password } = req.query;
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }
    
    try {
      const user = userOps.findByUsername(req.session.username);
      const privateKeyData = userOps.getPrivateKey(req.session.userId);
      
      if (!privateKeyData || !privateKeyData.private_key_encrypted) {
        return res.status(404).json({ error: 'No private key found' });
      }
      
      if (!encryption.verifyPassword(password, user.password_hash)) {
        return res.status(400).json({ error: 'Incorrect password' });
      }
      
      const privateKey = encryption.decryptPrivateKey(privateKeyData.private_key_encrypted, password);
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', 'attachment; filename=private_key.pem');
      res.send(privateKey);
    } catch (error) {
      console.error('Private key error:', error);
      res.status(500).json({ error: 'Failed to retrieve private key' });
    }
  });
  
  // ============ ROOM ROUTES ============
  
  // Get user rooms
  app.get('/api/rooms', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const rooms = roomOps.getUserRooms(req.session.userId);
    res.json(rooms);
  });
  
  // Create room
  app.post('/api/rooms', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { name } = req.body;
    if (!name || name.trim().length < 1) {
      return res.status(400).json({ error: 'Room name required' });
    }
    
    const roomId = roomOps.create(name.trim(), 'private', req.session.userId);
    roomOps.addMember(roomId, req.session.userId);
    
    res.json({ success: true, roomId });
  });
  
  // Join room
  app.post('/api/rooms/:id/join', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const room = roomOps.findById(req.params.id);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    roomOps.addMember(room.id, req.session.userId);
    
    res.json({ success: true });
  });
  
  // Get room members
  app.get('/api/rooms/:id/members', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const members = roomOps.getMembers(req.params.id);
    res.json(members);
  });

  // Get pending invites
  app.get('/api/invites', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const invites = roomOps.getPendingInvites(req.session.userId);
    res.json(invites);
  });

  // Accept invite
  app.post('/api/invites/:id/accept', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    roomOps.updateInviteStatus(req.params.id, 'accepted');
    // We would need to know the room_id to add the member, 
    // This is handled in the sockets for real-time, but here's a fallback:
    // Actually we'll just handle it entirely via Socket.io for instantaneous effect
    res.json({ success: true });
  });
  
  // ============ MESSAGE ROUTES ============
  
  app.get('/api/rooms/:id/messages', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const messages = messageOps.getByRoom(req.params.id);
    res.json(messages);
  });
  
  // ============ FILE UPLOAD ============
  
  app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    res.json({
      success: true,
      file: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        type: req.fileType,
        size: req.file.size,
        path: `/uploads/${req.file.filename}`
      }
    });
  });
  
  // Error handling
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
  
  // Serve index.html
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
}

module.exports = setupRoutes;
