// ========================================
// TRUSTCHAT PREMIUM - Frontend Application
// ========================================

// State
let currentUser = null;
let currentRoom = null;
let socket = null;
let users = [];
let rooms = [];
let onlineUsers = new Set();
let pendingFile = null;
let typingTimeout = null;
let mentionUsers = [];
let selectedMentionIndex = -1;
let replyToMessageId = null;
let replyToUserData = null;
let mediaRecorder = null;
let audioChunks = [];
let isVoiceRecording = false;
let unreadCounts = {};
let isScrolledUp = false;
let loadedMessages = []; // In-memory store for reply-to lookups
let editingMessageId = null; // Track which message is being edited

// DOM Elements
const authContainer = document.getElementById('auth-container');
const appContainer = document.getElementById('app-container');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginTab = document.getElementById('login-tab');
const registerTab = document.getElementById('register-tab');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const roomList = document.getElementById('room-list');
const userList = document.getElementById('user-list');
const settingsModal = document.getElementById('settings-modal');
const toastContainer = document.getElementById('toast-container');

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupAuthTabs();
  setupEventListeners();
  setupSocket();
  checkAuth();
}

// ========================================
// AUTHENTICATION
// ========================================

function setupAuthTabs() {
  loginTab.addEventListener('click', () => {
    loginTab.classList.add('active');
    registerTab.classList.remove('active');
    loginForm.classList.add('active');
    registerForm.classList.remove('active');
  });
  registerTab.addEventListener('click', () => {
    registerTab.classList.add('active');
    loginTab.classList.remove('active');
    registerForm.classList.add('active');
    loginForm.classList.remove('active');
  });
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth');
    const data = await res.json();
    if (data.authenticated) {
      currentUser = data.user;
      showApp();
      await loadRooms();
      await loadUsers();
    }
  } catch (e) { console.error('Auth check failed:', e); }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      showApp();
      await loadRooms();
      await loadUsers();
      showToast('Welcome back, ' + username + '! 👋', 'success');
    } else {
      showToast(data.error || 'Login failed', 'error');
    }
  } catch (e) { showToast('Login failed. Is the server running?', 'error'); }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('register-username').value;
  const password = document.getElementById('register-password').value;
  const confirm = document.getElementById('register-confirm').value;
  if (password !== confirm) { showToast('Passwords do not match', 'error'); return; }
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Account created! Please login.', 'success');
      loginTab.click();
      document.getElementById('login-username').value = username;
    } else {
      showToast(data.error || 'Registration failed', 'error');
    }
  } catch (e) { showToast('Registration failed', 'error'); }
});

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
    currentUser = null; currentRoom = null; loadedMessages = [];
    if (socket) socket.disconnect();
    authContainer.style.display = 'flex';
    appContainer.classList.remove('active');
    showToast('Logged out successfully', 'success');
  } catch (e) { showToast('Logout failed', 'error'); }
}

// ========================================
// SOCKET.IO
// ========================================

function setupSocket() {
  socket = io();

  socket.on('connect', () => {
    if (currentUser) {
      socket.emit('authenticate', currentUser.id);
      socket.emit('setUsername', currentUser.username);
    }
  });

  socket.on('newMessage', (message) => {
    if (currentRoom && message.roomId === currentRoom.id) {
      // Normalize and store in memory
      message.content = message.content || message.encrypted_content || message.encryptedContent || '';
      loadedMessages.push(message);
      appendMessage(message);
      if (!isScrolledUp) scrollToBottom();
      else showScrollHint();
    } else if (message.roomId) {
      unreadCounts[message.roomId] = (unreadCounts[message.roomId] || 0) + 1;
      renderRoomList();
    }
  });

  socket.on('messageDeleted', (data) => {
    const el = document.querySelector(`[data-message-id="${data.messageId}"]`);
    if (el) { el.style.animation = 'fadeOutMsg 0.3s ease forwards'; setTimeout(() => el.remove(), 300); }
    loadedMessages = loadedMessages.filter(m => m.id !== data.messageId);
  });

  // Real-time edit update — update the DOM directly instead of full reload
  socket.on('messageEdited', (data) => {
    const newContent = data.content || data.encryptedContent || '';
    // Update in memory
    const msg = loadedMessages.find(m => m.id === data.messageId);
    if (msg) { msg.content = newContent; msg.encrypted_content = newContent; msg.is_edited = true; }
    // Update DOM
    const el = document.querySelector(`[data-message-id="${data.messageId}"]`);
    if (el) {
      const textEl = el.querySelector('.message-text');
      const metaEl = el.querySelector('.message-meta');
      if (textEl) textEl.innerHTML = formatMessageContent(newContent);
      if (metaEl && !metaEl.querySelector('.message-edited')) {
        metaEl.innerHTML = '<span class="message-edited">(edited)</span>' + metaEl.innerHTML;
      }
    }
  });

  // Real-time reaction update — update DOM directly
  socket.on('reactionAdded', (data) => updateReactionsDOM(data.messageId));
  socket.on('reactionRemoved', (data) => updateReactionsDOM(data.messageId));

  socket.on('messagePinned', (data) => {
    if (currentRoom && currentRoom.id === data.roomId) {
      showPinnedMessage(data.author, data.content, data.messageId);
      if (currentRoom) currentRoom.pinned_message_id = data.messageId;
    }
  });

  socket.on('messageRead', (data) => {
    // Update read receipt for this specific message in DOM
    const el = document.querySelector(`[data-message-id="${data.messageId}"] .read-receipt`);
    if (el) el.classList.add('read');
  });

  socket.on('roomInvite', (data) => {
    showInviteNotification(data);
  });

  socket.on('roomDeleted', async (data) => {
    if (currentRoom && currentRoom.id === data.roomId) {
      currentRoom = null;
      showEmptyState('Room was deleted');
    }
    await loadRooms();
    showToast('A room was deleted', 'warning');
  });

  socket.on('userTyping', (data) => {
    if (currentRoom && data.roomId === currentRoom.id) showTypingIndicator(data.username);
  });

  socket.on('userStoppedTyping', () => hideTypingIndicator());

  socket.on('usersUpdate', (updated) => {
    onlineUsers = new Set(updated.map(u => u.userId));
    renderUserList();
  });
  socket.on('userOnline', (userId) => { onlineUsers.add(userId); renderUserList(); });
  socket.on('userOffline', (userId) => { onlineUsers.delete(userId); renderUserList(); });

  socket.on('mentioned', (data) => {
    showToast(`📣 ${data.mentionedBy} mentioned you in ${data.roomId === currentRoom?.id ? 'this room' : 'another room'}`, 'success');
  });

  socket.on('inviteError', (data) => {
    showToast(data.error || 'Invite failed', 'error');
  });

  socket.on('inviteSent', () => {
    // Confirmation handled by showToast in showInviteModal
  });

  socket.on('roomJoined', (data) => {
    currentRoom = data;
    unreadCounts[data.id] = 0;

    // Refresh room list so new room appears in sidebar
    loadRooms().then(() => renderRoomList());
    loadMessages();

    document.getElementById('current-room-name').textContent = data.name;
    document.getElementById('current-room-type').textContent = data.type === 'global' ? 'Global Chat' : 'Private Room';

    const inviteBtn = document.getElementById('invite-btn');
    if (inviteBtn) inviteBtn.style.display = data.type === 'private' ? 'flex' : 'none';

    // Show delete button only for room creator
    updateRoomHeaderButtons(data);
  });

  // Server tells client to refresh room list (e.g. after accepting invite)
  socket.on('roomsUpdated', async () => {
    await loadRooms();
  });
}

// ========================================
// DATA LOADING
// ========================================

async function loadRooms() {
  try {
    const res = await fetch('/api/rooms');
    rooms = await res.json();
    renderRoomList();
    const globalRoom = rooms.find(r => r.type === 'global');
    if (globalRoom && !currentRoom) joinRoom(globalRoom);
  } catch (e) { console.error('Failed to load rooms:', e); }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    users = await res.json();
    renderUserList();
  } catch (e) { console.error('Failed to load users:', e); }
}

async function loadMessages() {
  if (!currentRoom) return;
  try {
    const res = await fetch(`/api/rooms/${currentRoom.id}/messages`);
    const messages = await res.json();

    messagesContainer.innerHTML = '';
    loadedMessages = [];

    if (messages.length === 0) {
      showEmptyState('No messages yet — say hello! 👋');
      return;
    }

    messages.forEach(msg => {
      msg.content = msg.encrypted_content || msg.encryptedContent || msg.content || '';
      loadedMessages.push(msg);
    });

    loadedMessages.forEach(msg => appendMessage(msg));

    // Show pinned message if room has one
    if (currentRoom.pinned_message_id) {
      const pinned = loadedMessages.find(m => m.id === currentRoom.pinned_message_id);
      if (pinned) showPinnedMessage(pinned.username, pinned.content, pinned.id);
      else document.getElementById('pinned-message-container').style.display = 'none';
    } else {
      document.getElementById('pinned-message-container').style.display = 'none';
    }

    scrollToBottom();
  } catch (e) { console.error('Failed to load messages:', e); }
}

// ========================================
// RENDERING
// ========================================

function showEmptyState(text) {
  messagesContainer.innerHTML = `<div class="empty-state">
    <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
    <h3>${escapeHtml(text)}</h3>
    <p>Start the conversation ✨</p>
  </div>`;
}

function showPinnedMessage(author, content, messageId) {
  const container = document.getElementById('pinned-message-container');
  document.getElementById('pinned-author').textContent = author || 'Pinned';
  document.getElementById('pinned-text').textContent = content || '(no text)';
  container.style.display = 'flex';
  // Clicking on pinned message scrolls to it
  container.querySelector('.pinned-content').onclick = () => {
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('highlight-flash'); setTimeout(() => el.classList.remove('highlight-flash'), 2000); }
  };
}

function renderRoomList() {
  roomList.innerHTML = '';
  rooms.forEach(room => {
    const unread = unreadCounts[room.id] || 0;
    const li = document.createElement('li');
    li.className = `room-item ${currentRoom?.id === room.id ? 'active' : ''}`;
    li.innerHTML = `
      <div class="room-icon">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${room.type === 'global'
            ? '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'
            : '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>'}
        </svg>
      </div>
      <div class="room-info">
        <h4>${escapeHtml(room.name)}</h4>
        <p>${room.type === 'global' ? 'Everyone' : 'Private'}</p>
      </div>
      ${unread > 0
        ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>`
        : (room.type === 'global' ? '<span class="online-badge"></span>' : '')
      }
    `;
    li.addEventListener('click', () => joinRoom(room));
    roomList.appendChild(li);
  });
}

function renderUserList() {
  userList.innerHTML = '';
  const others = users.filter(u => u.id !== currentUser?.id);
  const onlineCount = others.filter(u => onlineUsers.has(u.id)).length;
  const sectionTitle = document.querySelector('.nav-section:last-child .nav-section-title');
  if (sectionTitle) sectionTitle.textContent = onlineCount > 0 ? `Online Users (${onlineCount})` : 'Users';

  // Sort: online first
  others.sort((a, b) => {
    const ao = onlineUsers.has(a.id) ? 0 : 1;
    const bo = onlineUsers.has(b.id) ? 0 : 1;
    return ao - bo || a.username.localeCompare(b.username);
  });

  others.forEach(user => {
    const isOnline = onlineUsers.has(user.id);
    const li = document.createElement('li');
    li.className = 'user-item';
    li.innerHTML = `
      <div class="avatar" style="background:${getUserGradient(user.username)}">
        ${user.avatar ? `<img src="/uploads/${user.avatar}" alt="">` : getInitials(user.username)}
        ${isOnline ? '<span class="avatar-status"></span>' : ''}
      </div>
      <div class="room-info">
        <h4>${escapeHtml(user.username)}</h4>
        <p style="color:${isOnline ? 'var(--accent-success)' : 'var(--text-muted)'}">${isOnline ? '● Online' : '○ Offline'}</p>
      </div>
    `;
    userList.appendChild(li);
  });
}

function appendMessage(msg) {
  const emptyState = messagesContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const isOwn = msg.userId === currentUser?.id || msg.user_id === currentUser?.id;
  const div = document.createElement('div');
  div.className = `message ${isOwn ? 'outgoing' : ''}`;
  div.setAttribute('data-message-id', msg.id);

  const content = msg.content || msg.encrypted_content || msg.encryptedContent || '';
  const time = formatRelativeTime(msg.createdAt || msg.created_at);
  const fullTime = new Date(msg.createdAt || msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // File rendering
  let fileHtml = '';
  const filePath = msg.file_path || (msg.file && msg.file.path);
  const fileType = msg.file_type || (msg.file && msg.file.type);
  if (filePath) {
    if (fileType === 'image') fileHtml = `<div class="message-file"><img src="${filePath}" alt="" loading="lazy" onclick="openLightbox('${filePath}')"></div>`;
    else if (fileType === 'video') fileHtml = `<div class="message-file"><video controls src="${filePath}"></video></div>`;
    else if (fileType === 'audio') fileHtml = `<div class="message-file"><audio controls src="${filePath}"></audio></div>`;
    else fileHtml = `<div class="message-file"><a href="${filePath}" download>📎 Download File</a></div>`;
  }

  // Reply — look up actual message content from memory
  let replyHtml = '';
  if (msg.reply_to_id) {
    const replied = loadedMessages.find(m => m.id === msg.reply_to_id);
    if (replied) {
      const repliedContent = replied.content || replied.encrypted_content || '';
      const preview = repliedContent.length > 60 ? repliedContent.substring(0, 60) + '…' : repliedContent;
      replyHtml = `<div class="message-reply" onclick="scrollToMessage(${msg.reply_to_id})">
        <div class="message-reply-author">↩ ${escapeHtml(replied.username || 'Unknown')}</div>
        <div class="message-reply-preview">${escapeHtml(preview || '(file)')}</div>
      </div>`;
    } else {
      replyHtml = `<div class="message-reply"><div class="message-reply-author">↩ Replied message</div></div>`;
    }
  }

  // Grouped emoji reactions
  let reactionsHtml = '';
  if (msg.reactions && msg.reactions.length > 0) {
    const grouped = {};
    msg.reactions.forEach(r => {
      const emoji = r.reaction_emoji || r.emoji;
      if (!grouped[emoji]) grouped[emoji] = { count: 0, mine: false };
      grouped[emoji].count++;
      if ((r.user_id || r.userId) === currentUser?.id) grouped[emoji].mine = true;
    });
    reactionsHtml = `<div class="message-reactions" data-msg-id="${msg.id}">`;
    Object.entries(grouped).forEach(([emoji, info]) => {
      reactionsHtml += `<span class="reaction-badge ${info.mine ? 'mine' : ''}" 
        onclick="toggleReaction(${msg.id}, '${emoji}')" title="${info.mine ? 'Remove reaction' : 'Add reaction'}">
        ${emoji}${info.count > 1 ? `<span class="reaction-count">${info.count}</span>` : ''}
      </span>`;
    });
    reactionsHtml += `</div>`;
  }

  const editedHtml = msg.is_edited ? `<span class="message-edited">(edited)</span>` : '';
  const readClass = msg.reads && msg.reads.length > 0 ? 'read' : '';
  const readHtml = isOwn && currentRoom?.type !== 'global'
    ? `<span class="read-receipt ${readClass}" title="${readClass ? 'Read' : 'Sent'}">✓✓</span>` : '';

  // Action buttons — show Edit only for own messages
  const editBtn = isOwn
    ? `<button class="message-action-btn" title="Edit" onclick="startEditMessage(${msg.id}, \`${escapeHtml(content).replace(/`/g, '\\`')}\`)">✏️</button>`
    : '';
  const deleteBtn = isOwn
    ? `<button class="message-action-btn danger" title="Delete" onclick="deleteMessage(${msg.id}, ${msg.roomId || msg.room_id})">🗑️</button>`
    : '';

  div.innerHTML = `
    <div class="message-avatar" style="background:${getUserGradient(msg.username || '')}">
      ${msg.avatar ? `<img src="/uploads/${msg.avatar}" alt="">` : getInitials(msg.username || '?')}
    </div>
    <div class="message-content">
      ${replyHtml}
      <div class="message-header">
        <span class="message-author">${escapeHtml(msg.username || 'Unknown')}</span>
        <span class="message-time" title="${fullTime}">${time}</span>
      </div>
      <div class="message-text">${formatMessageContent(content)}</div>
      ${fileHtml}
      ${reactionsHtml}
      <div class="message-meta">${editedHtml}${readHtml}</div>
      <div class="message-actions">
        <button class="message-action-btn" title="React" onclick="showReactionPicker(this, ${msg.id})">😊</button>
        <button class="message-action-btn" title="Reply" onclick="initiateReply(${msg.id})">↩</button>
        ${editBtn}
        <button class="message-action-btn" title="Pin" onclick="socket.emit('pinMessage', {roomId:${msg.roomId || msg.room_id || currentRoom?.id}, messageId:${msg.id}})">📌</button>
        ${deleteBtn}
      </div>
    </div>
  `;

  messagesContainer.appendChild(div);

  if (!isOwn && currentRoom?.type !== 'global') {
    socket.emit('markRead', { roomId: msg.roomId || msg.room_id, messageId: msg.id });
  }
}

// Update reactions in DOM without full reload
async function updateReactionsDOM(messageId) {
  // Re-fetch just this message's reactions from memory after a short delay
  // since the DB operation just happened
  try {
    const res = await fetch(`/api/rooms/${currentRoom.id}/messages`);
    const messages = await res.json();
    const updated = messages.find(m => m.id === messageId);
    if (!updated) return;
    updated.content = updated.encrypted_content || '';

    // Update in memory
    const idx = loadedMessages.findIndex(m => m.id === messageId);
    if (idx >= 0) loadedMessages[idx] = updated;

    // Update DOM reactions section
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!el) return;

    const grouped = {};
    (updated.reactions || []).forEach(r => {
      const emoji = r.reaction_emoji || r.emoji;
      if (!grouped[emoji]) grouped[emoji] = { count: 0, mine: false };
      grouped[emoji].count++;
      if ((r.user_id || r.userId) === currentUser?.id) grouped[emoji].mine = true;
    });

    let existing = el.querySelector('.message-reactions');
    if (!existing) {
      existing = document.createElement('div');
      existing.className = 'message-reactions';
      el.querySelector('.message-content .message-meta').before(existing);
    }
    existing.setAttribute('data-msg-id', messageId);

    if (Object.keys(grouped).length === 0) { existing.remove(); return; }

    existing.innerHTML = Object.entries(grouped).map(([emoji, info]) =>
      `<span class="reaction-badge ${info.mine ? 'mine' : ''}" 
        onclick="toggleReaction(${messageId}, '${emoji}')" title="${info.mine ? 'Remove' : 'Add'}">
        ${emoji}${info.count > 1 ? `<span class="reaction-count">${info.count}</span>` : ''}
      </span>`
    ).join('');
  } catch (e) { /* silent */ }
}

function scrollToMessage(messageId) {
  const el = document.querySelector(`[data-message-id="${messageId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight-flash');
    setTimeout(() => el.classList.remove('highlight-flash'), 2000);
  }
}

// Lightbox for images
function openLightbox(src) {
  let lb = document.getElementById('lightbox-overlay');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox-overlay';
    lb.className = 'lightbox-overlay';
    lb.innerHTML = `<div class="lightbox-inner"><img id="lightbox-img" src="" alt=""><button class="lightbox-close">✕</button></div>`;
    document.body.appendChild(lb);
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('lightbox-close')) lb.classList.remove('active'); });
  }
  document.getElementById('lightbox-img').src = src;
  lb.classList.add('active');
}

function showReactionPicker(btnEl, msgId) {
  // Toggle: if already open for this message, close it
  const existing = document.getElementById('emoji-picker-popup');
  if (existing) {
    existing.remove();
    return;
  }

  const picker = document.createElement('div');
  picker.id = 'emoji-picker-popup';
  picker.className = 'emoji-picker';

  ['👍','❤️','😂','😮','😢','👏','🔥','✨','👀','🎉','💯','😍'].forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = e;
    btn.onclick = (ev) => {
      ev.stopPropagation();
      socket.emit('addReaction', { roomId: currentRoom.id, messageId: msgId, emoji: e });
      picker.remove();
    };
    picker.appendChild(btn);
  });

  // Append to body and position near the button
  document.body.appendChild(picker);

  const rect = btnEl.getBoundingClientRect();
  const pickerWidth = 216; // ~6 emojis × 36px per col
  let left = rect.left;
  // Don't overflow right edge
  if (left + pickerWidth > window.innerWidth - 12) left = window.innerWidth - pickerWidth - 12;
  // Place above or below
  const spaceAbove = rect.top;
  const pickerHeight = 90;
  const top = spaceAbove > pickerHeight + 8
    ? rect.top - pickerHeight - 6
    : rect.bottom + 6;

  picker.style.position = 'fixed';
  picker.style.left = Math.max(8, left) + 'px';
  picker.style.top = top + 'px';
  picker.style.zIndex = '9000';

  // Close on any outside click (slight delay to avoid immediate closing)
  setTimeout(() => {
    const handler = (ev) => {
      if (!picker.contains(ev.target) && ev.target !== btnEl) {
        picker.remove();
        document.removeEventListener('click', handler);
      }
    };
    document.addEventListener('click', handler);
  }, 80);
}


// ========================================
// MESSAGING
// ========================================

async function sendMessage() {
  // If editing, save the edit instead
  if (editingMessageId) { saveEdit(); return; }

  const content = messageInput.value.trim();
  if (!content && !pendingFile) return;
  if (!currentRoom) { showToast('Please select a room first', 'warning'); return; }

  socket.emit('sendMessage', {
    roomId: currentRoom.id,
    content,
    encryptedContent: content,
    file: pendingFile,
    mentions: extractMentions(content),
    replyToId: replyToMessageId
  });

  messageInput.value = '';
  messageInput.style.height = 'auto';
  clearFilePreview();
  hideTypingIndicator();
  cancelReply();
  hideMentionDropdown();
}

// === EDIT MESSAGE ===
function startEditMessage(msgId, currentContent) {
  editingMessageId = msgId;
  messageInput.value = currentContent;
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
  messageInput.focus();

  // Show edit indicator bar
  const editBar = document.getElementById('edit-bar');
  if (editBar) {
    editBar.style.display = 'flex';
    document.getElementById('edit-bar-text').textContent = 'Editing message';
  }

  // Highlight the message being edited
  document.querySelectorAll('.message.editing').forEach(el => el.classList.remove('editing'));
  const msgEl = document.querySelector(`[data-message-id="${msgId}"]`);
  if (msgEl) msgEl.classList.add('editing');
}

function cancelEdit() {
  editingMessageId = null;
  messageInput.value = '';
  messageInput.style.height = 'auto';
  const editBar = document.getElementById('edit-bar');
  if (editBar) editBar.style.display = 'none';
  document.querySelectorAll('.message.editing').forEach(el => el.classList.remove('editing'));
}

function saveEdit() {
  const newContent = messageInput.value.trim();
  if (!newContent) { cancelEdit(); return; }
  const msg = loadedMessages.find(m => m.id === editingMessageId);
  if (!msg) { cancelEdit(); return; }

  socket.emit('editMessage', {
    roomId: msg.roomId || msg.room_id || currentRoom.id,
    messageId: editingMessageId,
    content: newContent,
    encryptedContent: newContent
  });

  cancelEdit();
}

function cancelReply() {
  replyToMessageId = null;
  replyToUserData = null;
  document.getElementById('reply-preview').style.display = 'none';
}

function initiateReply(msgId) {
  replyToMessageId = msgId;
  const msg = loadedMessages.find(m => m.id === msgId);
  if (msg) {
    const content = msg.content || '';
    const preview = content.length > 60 ? content.substring(0, 60) + '…' : content;
    document.getElementById('reply-preview-author').textContent = `↩ Replying to ${msg.username}`;
    document.getElementById('reply-preview-text').textContent = preview || '(file)';
  } else {
    document.getElementById('reply-preview-author').textContent = '↩ Replying to message';
    document.getElementById('reply-preview-text').textContent = '';
  }
  document.getElementById('reply-preview').style.display = 'flex';
  messageInput.focus();
}

messageInput.addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
  handleTyping();
  handleMentionInput(e.target.value);
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (editingMessageId) { cancelEdit(); return; }
    if (replyToMessageId) { cancelReply(); return; }
    hideMentionDropdown();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (mentionUsers.length > 0 && selectedMentionIndex >= 0) {
      selectMention(selectedMentionIndex);
    } else {
      sendMessage();
    }
    return;
  }
  if (mentionUsers.length > 0) {
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedMentionIndex = Math.min(selectedMentionIndex + 1, mentionUsers.length - 1); renderMentionDropdown(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedMentionIndex = Math.max(selectedMentionIndex - 1, 0); renderMentionDropdown(); }
  }
});

function handleTyping() {
  if (!currentRoom) return;
  socket.emit('typing', { roomId: currentRoom.id });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('stopTyping', { roomId: currentRoom.id }), 1800);
}

function showTypingIndicator(username) {
  let indicator = document.getElementById('typing-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'typing-indicator';
    indicator.className = 'typing-indicator';
    indicator.innerHTML = `<div class="typing-bubble"><span></span><span></span><span></span></div><span class="typing-text"></span>`;
    messagesContainer.appendChild(indicator);
  }
  indicator.querySelector('.typing-text').textContent = `${username} is typing…`;
  indicator.style.display = 'flex';
  if (!isScrolledUp) scrollToBottom();
}

function hideTypingIndicator() {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) indicator.style.display = 'none';
}

// ========================================
// @MENTIONS
// ========================================

function handleMentionInput(value) {
  const cursorPos = messageInput.selectionStart;
  const textBefore = value.substring(0, cursorPos);
  const match = textBefore.match(/@(\w*)$/);
  if (match) {
    const q = match[1].toLowerCase();
    mentionUsers = users.filter(u => u.id !== currentUser?.id && u.username.toLowerCase().includes(q));
    selectedMentionIndex = mentionUsers.length > 0 ? 0 : -1;
    renderMentionDropdown();
  } else {
    hideMentionDropdown();
  }
}

function renderMentionDropdown() {
  let dd = document.getElementById('mention-dropdown');
  if (!dd) {
    dd = document.createElement('div');
    dd.id = 'mention-dropdown';
    dd.className = 'mention-dropdown';
    document.querySelector('.message-input-wrapper').appendChild(dd);
  }
  if (mentionUsers.length === 0) { dd.classList.remove('active'); return; }
  dd.innerHTML = mentionUsers.map((u, i) => `
    <div class="mention-item ${i === selectedMentionIndex ? 'selected' : ''}" data-index="${i}">
      <div class="mention-item-avatar" style="background:${getUserGradient(u.username)}">${getInitials(u.username)}</div>
      <span class="mention-item-name">${escapeHtml(u.username)}</span>
      ${onlineUsers.has(u.id) ? '<span class="online-badge"></span>' : ''}
    </div>
  `).join('');
  dd.classList.add('active');
  dd.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('click', () => selectMention(parseInt(item.dataset.index)));
  });
}

function selectMention(index) {
  const user = mentionUsers[index];
  if (!user) return;
  const cursorPos = messageInput.selectionStart;
  const before = messageInput.value.substring(0, cursorPos).replace(/@\w*$/, `@${user.username} `);
  const after = messageInput.value.substring(cursorPos);
  messageInput.value = before + after;
  hideMentionDropdown();
  messageInput.focus();
}

function hideMentionDropdown() {
  const dd = document.getElementById('mention-dropdown');
  if (dd) dd.classList.remove('active');
  mentionUsers = [];
  selectedMentionIndex = -1;
}

function extractMentions(content) {
  const matches = content.match(/@(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => {
    const user = users.find(u => u.username === m.substring(1));
    return user ? user.id : null;
  }).filter(Boolean))];
}

function formatMessageContent(content) {
  if (!content) return '';
  let t = escapeHtml(content);
  t = t.replace(/\n/g, '<br>');
  t = t.replace(/@([a-zA-Z0-9_]+)/g, '<span class="mention">@$1</span>');
  t = t.replace(/(https?:\/\/[^\s<"]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="message-link">$1</a>');
  return t;
}

// ========================================
// DELETE / EDIT ACTIONS
// ========================================

function deleteMessage(messageId, roomId) {
  showConfirm('Delete this message?', 'This cannot be undone.', 'Delete', () => {
    socket.emit('deleteMessage', { messageId, roomId: roomId || currentRoom?.id });
  });
}

function showConfirm(title, desc, confirmLabel, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `<div class="confirm-dialog">
    <p class="confirm-title">${escapeHtml(title)}</p>
    ${desc ? `<p class="confirm-desc">${escapeHtml(desc)}</p>` : ''}
    <div class="confirm-actions">
      <button class="btn-confirm-cancel">Cancel</button>
      <button class="btn-confirm-ok">${escapeHtml(confirmLabel || 'Confirm')}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.classList.add('active'), 10);
  overlay.querySelector('.btn-confirm-cancel').onclick = () => closeConfirm(overlay);
  overlay.querySelector('.btn-confirm-ok').onclick = () => { onConfirm(); closeConfirm(overlay); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeConfirm(overlay); });
}
function closeConfirm(overlay) { overlay.classList.remove('active'); setTimeout(() => overlay.remove(), 300); }

// ========================================
// FILE UPLOAD
// ========================================

function setupFileUpload() {
  const fileInput = document.getElementById('file-input');
  if (fileInput) fileInput.addEventListener('change', handleFileSelect);
}

async function handleFileSelect(e) {
  if (e.target.files.length > 0) await handleFileUpload(e.target.files[0]);
}

async function handleFileUpload(file) {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (isImage && file.size > 10 * 1024 * 1024) { showToast('Image must be less than 10MB', 'error'); return; }
  if (isVideo && file.size > 50 * 1024 * 1024) { showToast('Video must be less than 50MB', 'error'); return; }
  if (!isImage && !isVideo) { showToast('Only images and videos are allowed', 'error'); return; }

  const formData = new FormData();
  formData.append('file', file);
  try {
    showToast('Uploading…', 'success');
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) { pendingFile = data.file; showFilePreview(data.file); }
    else showToast(data.error || 'Upload failed', 'error');
  } catch (e) { showToast('Upload failed', 'error'); }
}

function showFilePreview(file) {
  const preview = document.getElementById('file-preview');
  const info = preview.querySelector('.file-preview-info');
  let mediaHtml = '';
  if (file.type === 'image') mediaHtml = `<img src="${file.path}" alt="">`;
  else if (file.type === 'video') mediaHtml = `<video src="${file.path}"></video>`;
  else mediaHtml = `<div style="font-size:1.5rem">📎</div>`;
  info.innerHTML = `${mediaHtml}<div><div class="file-preview-name">${escapeHtml(file.originalName)}</div><div class="file-preview-size">${formatFileSize(file.size)}</div></div>`;
  preview.classList.add('active');
}

function clearFilePreview() {
  pendingFile = null;
  const preview = document.getElementById('file-preview');
  preview.classList.remove('active');
  const fi = document.getElementById('file-input');
  if (fi) fi.value = '';
}

// ========================================
// ROOM MANAGEMENT
// ========================================

function joinRoom(room) {
  if (currentRoom) socket.emit('leaveRoom', currentRoom.id);
  unreadCounts[room.id] = 0;
  socket.emit('joinRoom', room.id);
  renderRoomList();
}

async function createRoom() {
  document.getElementById('create-room-modal')?.classList.add('active');
  document.getElementById('new-room-name').value = '';
  setTimeout(() => document.getElementById('new-room-name').focus(), 100);
}

async function submitCreateRoom() {
  const name = document.getElementById('new-room-name')?.value?.trim();
  if (!name) { showToast('Enter a room name', 'error'); return; }
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('create-room-modal')?.classList.remove('active');
      await loadRooms();
      showToast(`Room "${name}" created!`, 'success');
    } else {
      showToast(data.error || 'Failed to create room', 'error');
    }
  } catch (e) { showToast('Failed to create room', 'error'); }
}

// ========================================
// INVITE
// ========================================

function showInviteNotification(data) {
  // Non-blocking invite notification
  const notif = document.createElement('div');
  notif.className = 'invite-notification';
  notif.innerHTML = `
    <div class="invite-title">📨 Room Invite</div>
    <div class="invite-body"><strong>${escapeHtml(data.inviter_name)}</strong> invited you to <strong>${escapeHtml(data.room_name)}</strong></div>
    <div class="invite-actions">
      <button class="invite-decline">Decline</button>
      <button class="invite-accept">Accept</button>
    </div>
  `;
  document.body.appendChild(notif);
  setTimeout(() => notif.classList.add('active'), 10);

  notif.querySelector('.invite-accept').onclick = () => {
    socket.emit('acceptInvite', data.id);
    setTimeout(loadRooms, 800);
    notif.classList.remove('active');
    setTimeout(() => notif.remove(), 400);
    showToast(`Joined "${data.room_name}"!`, 'success');
  };
  notif.querySelector('.invite-decline').onclick = () => {
    notif.classList.remove('active');
    setTimeout(() => notif.remove(), 400);
  };
  // Auto-dismiss after 12 seconds
  setTimeout(() => { notif.classList.remove('active'); setTimeout(() => notif.remove(), 400); }, 12000);
}

function showInviteModal() {
  const modal = document.getElementById('invite-modal');
  const list = document.getElementById('invite-user-list');
  list.innerHTML = '';

  if (!currentRoom || currentRoom.type !== 'private') {
    showToast('Only private rooms can have invites', 'warning');
    return;
  }

  // Get current room members to exclude
  const memberIds = new Set((currentRoom.members || []).map(m => m.id));
  const invitable = users.filter(u => u.id !== currentUser.id && !memberIds.has(u.id));

  if (invitable.length === 0) {
    list.innerHTML = '<li style="padding:16px;color:var(--text-muted);text-align:center">All users are already members of this room.</li>';
  }

  invitable.forEach(u => {
    const li = document.createElement('li');
    li.className = 'user-item';
    li.innerHTML = `
      <div class="avatar" style="background:${getUserGradient(u.username)}">${getInitials(u.username)}</div>
      <div class="room-info"><h4>${escapeHtml(u.username)}</h4><p>${onlineUsers.has(u.id) ? '● Online' : '○ Offline'}</p></div>
      <button class="btn btn-secondary btn-sm">Invite</button>
    `;
    li.querySelector('button').onclick = function() {
      socket.emit('sendInvite', { roomId: currentRoom.id, inviteeId: u.id });
      this.textContent = 'Invited ✓';
      this.disabled = true;
      this.style.color = 'var(--accent-success)';
      showToast(`Invite sent to ${u.username}`, 'success');
    };
    list.appendChild(li);
  });

  modal.classList.add('active');
}

function updateRoomHeaderButtons(room) {
  // Show/hide delete room button based on ownership
  let deleteBtn = document.getElementById('delete-room-btn');
  if (!deleteBtn) {
    deleteBtn = document.createElement('button');
    deleteBtn.id = 'delete-room-btn';
    deleteBtn.className = 'btn-icon';
    deleteBtn.title = 'Delete room';
    deleteBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="m19 6-.867 12.142A2 2 0 0 1 16.138 20H7.862a2 2 0 0 1-1.995-1.858L5 6h14Z"></path>
      <path d="M10 11v6M14 11v6"></path>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
    </svg>`;
    deleteBtn.addEventListener('click', deleteCurrentRoom);
    document.querySelector('.header-actions')?.appendChild(deleteBtn);
  }

  const isCreator = room.created_by === currentUser?.id;
  const isPrivate = room.type === 'private';
  deleteBtn.style.display = (isCreator && isPrivate) ? 'flex' : 'none';
}

function deleteCurrentRoom() {
  if (!currentRoom || currentRoom.type === 'global') {
    showToast('Cannot delete the global room', 'error');
    return;
  }

  const isCreator = currentRoom.created_by === currentUser?.id;
  if (!isCreator) {
    showToast('Only the room creator can delete it', 'error');
    return;
  }

  showConfirm(
    `Delete "${currentRoom.name}"?`,
    'All messages in this room will be permanently deleted.',
    'Delete Room',
    () => {
      socket.emit('deleteRoom', currentRoom.id);
    }
  );
}

function sendInvite(userId, btnEl) {
  if (!currentRoom) return;
  socket.emit('sendInvite', { roomId: currentRoom.id, inviteeId: userId });
  btnEl.textContent = 'Sent ✓';
  btnEl.disabled = true;
}

// ========================================
// SETTINGS
// ========================================

function openSettings() {
  settingsModal.classList.add('active');
  document.getElementById('settings-username').value = currentUser.username;
  document.getElementById('settings-current-password').value = '';
  document.getElementById('settings-new-password').value = '';
  const avatarEl = document.getElementById('settings-avatar');
  if (currentUser.avatar) {
    avatarEl.innerHTML = `<img src="/uploads/${currentUser.avatar}" alt="">`;
  } else {
    avatarEl.textContent = getInitials(currentUser.username);
    avatarEl.style.background = getUserGradient(currentUser.username);
  }
}

function closeSettings() { settingsModal.classList.remove('active'); }

async function updateProfile(e) {
  e.preventDefault();
  const username = document.getElementById('settings-username').value;
  const currentPassword = document.getElementById('settings-current-password').value;
  const newPassword = document.getElementById('settings-new-password').value;
  const avatarInput = document.getElementById('settings-avatar-input');
  if (!currentPassword) { showToast('Current password is required to save changes', 'error'); return; }

  const formData = new FormData();
  formData.append('username', username);
  formData.append('currentPassword', currentPassword);
  if (newPassword) formData.append('newPassword', newPassword);
  if (avatarInput.files.length > 0) formData.append('avatar', avatarInput.files[0]);

  try {
    const res = await fetch('/api/profile/update', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      showToast('Profile updated! ✓', 'success');
      closeSettings();
      const auth = await (await fetch('/api/auth')).json();
      if (auth.authenticated) {
        currentUser = auth.user;
        document.getElementById('user-name').textContent = currentUser.username;
        const av = document.getElementById('user-avatar');
        av.style.background = getUserGradient(currentUser.username);
        av.innerHTML = currentUser.avatar
          ? `<img src="/uploads/${currentUser.avatar}" alt=""><span class="avatar-status"></span>`
          : `${getInitials(currentUser.username)}<span class="avatar-status"></span>`;
        await loadUsers();
      }
    } else {
      showToast(data.error || 'Update failed', 'error');
    }
  } catch (e) { showToast('Update failed', 'error'); }
}

async function downloadPrivateKey() {
  const password = prompt('Enter your password to export your private key:');
  if (!password) return;
  try {
    const res = await fetch(`/api/profile/private-key?password=${encodeURIComponent(password)}`);
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'private_key.pem'; a.click();
      URL.revokeObjectURL(url);
      showToast('Private key exported', 'success');
    } else {
      const data = await res.json();
      showToast(data.error || 'Failed to export key', 'error');
    }
  } catch (e) { showToast('Export failed', 'error'); }
}

// ========================================
// UTILITIES
// ========================================

function showApp() {
  authContainer.style.display = 'none';
  appContainer.classList.add('active');
  const av = document.getElementById('user-avatar');
  av.style.background = getUserGradient(currentUser.username);
  av.innerHTML = currentUser.avatar
    ? `<img src="/uploads/${currentUser.avatar}" alt=""><span class="avatar-status"></span>`
    : `${getInitials(currentUser.username)}<span class="avatar-status"></span>`;
  document.getElementById('user-name').textContent = currentUser.username;
  setupFileUpload();
  setupScrollObserver();
  if (socket && currentUser) {
    socket.emit('authenticate', currentUser.id);
    socket.emit('setUsername', currentUser.username);
    // Request any pending invites (e.g. received while offline)
    setTimeout(() => socket.emit('getPendingInvites'), 800);
  }
}

function setupScrollObserver() {
  messagesContainer.addEventListener('scroll', () => {
    const distFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    isScrolledUp = distFromBottom > 120;
    const btn = document.getElementById('scroll-bottom-btn');
    if (btn) btn.classList.toggle('visible', isScrolledUp);
  });
}

function showScrollHint() {
  const btn = document.getElementById('scroll-bottom-btn');
  if (btn) btn.classList.add('visible', 'has-new');
}

function scrollToBottom() {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  isScrolledUp = false;
  const btn = document.getElementById('scroll-bottom-btn');
  if (btn) btn.classList.remove('visible', 'has-new');
}

function showToast(message, type = 'success') {
  const icons = { success: '✓', error: '✕', warning: '⚠' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || '•'}</span><span class="toast-message">${escapeHtml(String(message))}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 400); }, 3500);
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.substring(0, 2).toUpperCase();
}

function getUserGradient(username) {
  const palettes = [
    ['#6366f1','#8b5cf6'], ['#ec4899','#f43f5e'], ['#10b981','#059669'],
    ['#f59e0b','#ef4444'], ['#3b82f6','#6366f1'], ['#8b5cf6','#ec4899'],
    ['#14b8a6','#3b82f6'], ['#f97316','#f59e0b']
  ];
  let hash = 0;
  for (let i = 0; i < (username || '').length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  const p = palettes[Math.abs(hash) % palettes.length];
  return `linear-gradient(135deg, ${p[0]}, ${p[1]})`;
}

function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr), now = new Date();
  const diff = Math.floor((now - d) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function toggleReaction(msgId, emoji) {
  if (!currentRoom) return;
  const msg = loadedMessages.find(m => m.id === msgId);
  const existing = (msg?.reactions || []).find(r => (r.reaction_emoji || r.emoji) === emoji && (r.user_id || r.userId) === currentUser?.id);
  if (existing) {
    socket.emit('removeReaction', { roomId: currentRoom.id, messageId: msgId, emoji });
  } else {
    socket.emit('addReaction', { roomId: currentRoom.id, messageId: msgId, emoji });
  }
}

function setupEventListeners() {
  document.getElementById('send-btn')?.addEventListener('click', sendMessage);
  document.getElementById('create-room-btn')?.addEventListener('click', createRoom);
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('logout-btn')?.addEventListener('click', logout);
  document.querySelector('#settings-modal .modal-close')?.addEventListener('click', closeSettings);
  document.getElementById('settings-form')?.addEventListener('submit', updateProfile);
  document.getElementById('download-key-btn')?.addEventListener('click', downloadPrivateKey);
  document.getElementById('file-preview-remove')?.addEventListener('click', clearFilePreview);
  settingsModal?.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
  document.getElementById('cancel-reply-btn')?.addEventListener('click', cancelReply);
  document.getElementById('invite-btn')?.addEventListener('click', showInviteModal);
  document.getElementById('scroll-bottom-btn')?.addEventListener('click', scrollToBottom);

  // Edit bar
  document.getElementById('cancel-edit-btn')?.addEventListener('click', cancelEdit);

  // Unpin
  document.getElementById('unpin-btn')?.addEventListener('click', () => {
    document.getElementById('pinned-message-container').style.display = 'none';
    if (currentRoom) currentRoom.pinned_message_id = null;
  });

  // Create room modal
  document.getElementById('create-room-submit')?.addEventListener('click', submitCreateRoom);
  document.getElementById('new-room-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreateRoom(); });
  document.querySelector('#create-room-modal .modal-close')?.addEventListener('click', () => {
    document.getElementById('create-room-modal')?.classList.remove('active');
  });
  document.getElementById('create-room-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'create-room-modal') document.getElementById('create-room-modal').classList.remove('active');
  });

  // Invite modal
  document.querySelector('#invite-modal .modal-close')?.addEventListener('click', () => {
    document.getElementById('invite-modal')?.classList.remove('active');
  });
  document.getElementById('invite-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'invite-modal') document.getElementById('invite-modal').classList.remove('active');
  });

  setupVoiceRecording();
}

async function setupVoiceRecording() {
  const voiceBtn = document.getElementById('voice-btn');
  if (!voiceBtn) return;
  voiceBtn.addEventListener('mousedown', startRecording);
  voiceBtn.addEventListener('mouseup', stopRecording);
  voiceBtn.addEventListener('mouseleave', stopRecording);
  voiceBtn.addEventListener('touchstart', startRecording, { passive: true });
  voiceBtn.addEventListener('touchend', stopRecording);

  function startRecording(e) {
    if (!navigator.mediaDevices?.getUserMedia) { showToast('Voice recording not supported', 'error'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.start();
      isVoiceRecording = true;
      audioChunks = [];
      voiceBtn.classList.add('recording');
      showToast('🎙 Recording… release to send', 'success');
      mediaRecorder.addEventListener('dataavailable', ev => audioChunks.push(ev.data));
    }).catch(() => showToast('Microphone access denied', 'error'));
  }

  function stopRecording() {
    if (!isVoiceRecording || !mediaRecorder) return;
    mediaRecorder.stop();
    isVoiceRecording = false;
    voiceBtn.classList.remove('recording');
    mediaRecorder.addEventListener('stop', () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('file', blob, 'voice_note.webm');
      fetch('/api/upload', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(data => {
          if (data.success && currentRoom) {
            socket.emit('sendMessage', {
              roomId: currentRoom.id,
              content: '🎙 Voice note',
              encryptedContent: '🎙 Voice note',
              file: { path: data.file.path, type: 'audio', originalName: 'Voice Note' },
              mentions: [],
              replyToId: replyToMessageId
            });
            cancelReply();
          }
        })
        .catch(() => showToast('Failed to upload voice note', 'error'));
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
    });
  }
}
