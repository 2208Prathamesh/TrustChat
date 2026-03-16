const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const { initDatabase } = require('./src/database');
const setupRoutes = require('./src/routes');
const setupSocket = require('./src/socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Session configuration
app.use(session({
  secret: 'trustchat-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  // Initialize database
  await initDatabase();

  // Setup routes
  setupRoutes(app, io);

  // Setup Socket.io
  setupSocket(io);

  server.listen(PORT, () => {
    console.log(`🔥 TrustChat Server running on http://localhost:${PORT}`);
    console.log(`📁 Upload directory: ${path.join(__dirname, 'uploads')}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
