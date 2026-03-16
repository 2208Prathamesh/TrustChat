const { userOps, roomOps, messageOps } = require('./database');

function setupSocket(io) {
  const onlineUsers = new Map();
  
  io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);
    
    socket.on('authenticate', (userId) => {
      socket.userId = userId;
      onlineUsers.set(userId, { socketId: socket.id, username: null });
      
      const userRooms = roomOps.getUserRooms(userId);
      userRooms.forEach(room => {
        socket.join(`room_${room.id}`);
      });
      
      io.emit('userOnline', userId);
      console.log(`✅ User ${userId} authenticated`);

      // Deliver any pending invites that arrived while user was offline
      const pending = roomOps.getPendingInvites(userId);
      pending.forEach(invite => {
        socket.emit('roomInvite', {
          id: invite.id,
          roomId: invite.room_id,
          room_name: invite.room_name,
          inviter_name: invite.inviter_name
        });
      });
    });
    
    // Client can request pending invites manually
    socket.on('getPendingInvites', () => {
      if (!socket.userId) return;
      const pending = roomOps.getPendingInvites(socket.userId);
      pending.forEach(invite => {
        socket.emit('roomInvite', {
          id: invite.id,
          roomId: invite.room_id,
          room_name: invite.room_name,
          inviter_name: invite.inviter_name
        });
      });
    });
    
    socket.on('setUsername', (username) => {
      if (socket.userId) {
        const userInfo = onlineUsers.get(socket.userId);
        if (userInfo) {
          userInfo.username = username;
        }
        io.emit('usersUpdate', getOnlineUsers());
      }
    });
    
    socket.on('joinRoom', (roomId) => {
      if (!socket.userId) return;
      
      socket.join(`room_${roomId}`);
      
      const room = roomOps.findById(roomId);
      if (room) {
        const members = roomOps.getMembers(roomId);
        // Only emit to the joining socket, not all room members
        socket.emit('roomJoined', {
          id: room.id,
          roomId: room.id,
          name: room.name,
          type: room.type,
          created_by: room.created_by,
          pinned_message_id: room.pinned_message_id,
          members
        });
        
        socket.to(`room_${roomId}`).emit('userJoinedRoom', {
          userId: socket.userId,
          roomId
        });
      }
    });
    
    socket.on('leaveRoom', (roomId) => {
      if (!socket.userId) return;
      
      socket.leave(`room_${roomId}`);
      
      const user = userOps.findById(socket.userId);
      io.to(`room_${roomId}`).emit('userLeftRoom', {
        userId: socket.userId,
        username: user?.username,
        roomId
      });
    });
    
    socket.on('sendMessage', (data) => {
      if (!socket.userId) return;
      
      const { roomId, content, encryptedContent, file, mentions, replyToId } = data;
      // Accept either 'content' or 'encryptedContent' field name for compatibility
      const messageContent = content || encryptedContent || '';
      
      const messageId = messageOps.create(
        roomId,
        socket.userId,
        messageContent,
        file ? file.path : null,
        file ? file.type : null,
        replyToId
      );
      
      const user = userOps.findById(socket.userId);
      
      const message = {
        id: messageId,
        roomId,
        userId: socket.userId,
        username: user?.username,
        avatar: user?.avatar,
        content: messageContent,
        encrypted_content: messageContent,
        encryptedContent: messageContent,
        file_path: file ? file.path : null,
        file_type: file ? file.type : null,
        file: file ? {
          path: file.path,
          type: file.type,
          originalName: file.originalName
        } : null,
        mentions: mentions || [],
        reply_to_id: replyToId,
        is_edited: false,
        reactions: [],
        reads: [],
        createdAt: new Date().toISOString()
      };
      
      io.to(`room_${roomId}`).emit('newMessage', message);
      
      if (mentions && mentions.length > 0) {
        mentions.forEach(mentionedUserId => {
          const mentionedSocket = onlineUsers.get(parseInt(mentionedUserId));
          if (mentionedSocket) {
            io.to(mentionedSocket.socketId).emit('mentioned', {
              message,
              mentionedBy: user?.username,
              roomId
            });
          }
        });
      }
      
      console.log(`💬 Message in room ${roomId} from user ${socket.userId}`);
    });
    
    // Delete message
    socket.on('deleteMessage', (data) => {
      if (!socket.userId) return;
      
      const { messageId, roomId } = data;
      
      // Get message to check ownership
      const messages = messageOps.getByRoom(roomId);
      const message = messages.find(m => m.id === messageId);
      
      if (message && message.user_id === socket.userId) {
        // Delete from database
        messageOps.delete(messageId);
        
        // Broadcast deletion to room
        io.to(`room_${roomId}`).emit('messageDeleted', { messageId });
        console.log(`🗑️ Message ${messageId} deleted by user ${socket.userId}`);
      }
    });
    
    // Delete room
    socket.on('deleteRoom', (roomId) => {
      if (!socket.userId) return;
      
      const room = roomOps.findById(roomId);
      
      // Only room creator can delete
      if (room && room.created_by === socket.userId) {
        // Delete room from database
        roomOps.delete(roomId);
        
        // Broadcast room deletion
        io.emit('roomDeleted', { roomId });
        console.log(`🗑️ Room ${roomId} deleted by user ${socket.userId}`);
      }
    });

    // Premium Feature Events
    
    socket.on('editMessage', (data) => {
      if (!socket.userId) return;
      const { roomId, messageId, content, encryptedContent } = data;
      const newContent = content || encryptedContent || '';
      
      const messages = messageOps.getByRoom(roomId);
      const message = messages.find(m => m.id === messageId);
      
      if (message && message.user_id === socket.userId) {
        messageOps.updateContent(messageId, newContent);
        io.to(`room_${roomId}`).emit('messageEdited', { 
          messageId, 
          content: newContent, 
          encryptedContent: newContent 
        });
      }
    });

    socket.on('addReaction', (data) => {
      if (!socket.userId) return;
      const { roomId, messageId, emoji } = data;
      messageOps.addReaction(messageId, socket.userId, emoji);
      io.to(`room_${roomId}`).emit('reactionAdded', { messageId, userId: socket.userId, emoji });
    });

    socket.on('removeReaction', (data) => {
      if (!socket.userId) return;
      const { roomId, messageId, emoji } = data;
      messageOps.removeReaction(messageId, socket.userId, emoji);
      io.to(`room_${roomId}`).emit('reactionRemoved', { messageId, userId: socket.userId, emoji });
    });

    socket.on('markRead', (data) => {
      if (!socket.userId) return;
      const { roomId, messageId } = data;
      messageOps.markRead(messageId, socket.userId);
      io.to(`room_${roomId}`).emit('messageRead', { messageId, userId: socket.userId });
    });
    
    socket.on('pinMessage', (data) => {
      if (!socket.userId) return;
      const { roomId, messageId } = data;
      roomOps.pinMessage(roomId, messageId);
      
      // Look up actual message content so frontend can show real text
      const messages = messageOps.getByRoom(roomId);
      const pinnedMsg = messages.find(m => m.id === messageId);
      const pinAuthor = pinnedMsg ? userOps.findById(pinnedMsg.user_id) : null;
      
      io.to(`room_${roomId}`).emit('messagePinned', { 
        roomId, 
        messageId,
        content: pinnedMsg ? (pinnedMsg.encrypted_content || '') : '',
        author: pinAuthor ? pinAuthor.username : 'Unknown'
      });
    });

    socket.on('sendInvite', (data) => {
      if (!socket.userId) return;
      const { roomId, inviteeId } = data;
      const room = roomOps.findById(roomId);
      
      // Coerce to integer to avoid type mismatch
      const inviteeIdInt = parseInt(inviteeId, 10);

      // Must be a member to invite
      if (roomOps.isMember(roomId, socket.userId)) {
        // Don't re-invite existing members
        if (roomOps.isMember(roomId, inviteeIdInt)) {
          socket.emit('inviteError', { error: 'User is already a member of this room' });
          return;
        }

        const inviteId = roomOps.createInvite(roomId, socket.userId, inviteeIdInt);
        
        // Find invitee's socket — check both number and string keys
        let inviteeSocketId = null;
        onlineUsers.forEach((info, uId) => {
          if (uId === inviteeIdInt || uId === inviteeId) inviteeSocketId = info.socketId;
        });

        const inviter = userOps.findById(socket.userId);
        if (inviteeSocketId) {
          io.to(inviteeSocketId).emit('roomInvite', {
            id: inviteId,
            roomId,
            room_name: room ? room.name : 'Unknown Room',
            inviter_name: inviter ? inviter.username : 'Someone'
          });
          console.log(`📨 Invite sent from user ${socket.userId} to user ${inviteeIdInt} for room ${roomId}`);
        } else {
          // Invitee is offline — store invite, they'll see it on next login
          console.log(`📨 Invite stored for offline user ${inviteeIdInt} for room ${roomId}`);
        }
        socket.emit('inviteSent', { roomId, inviteeId: inviteeIdInt });
      }
    });

    socket.on('acceptInvite', (inviteId) => {
      if (!socket.userId) return;

      // Find the invite by looking up pending invites for this user
      const pending = roomOps.getPendingInvites(socket.userId);
      const invite = pending.find(i => i.id === inviteId) || pending[0]; // fallback to first pending

      if (!invite) {
        console.log(`⚠️ No pending invite found for inviteId ${inviteId}, userId ${socket.userId}`);
        return;
      }

      const { room_id: roomId } = invite;

      // 1. Mark invite as accepted
      roomOps.updateInviteStatus(inviteId, 'accepted');

      // 2. Add user as room member
      roomOps.addMember(roomId, socket.userId);

      // 3. Join the socket.io room
      socket.join(`room_${roomId}`);

      // 4. Send room data back to the accepting user so they can open it
      const room = roomOps.findById(roomId);
      if (room) {
        const members = roomOps.getMembers(roomId);
        socket.emit('roomJoined', {
          id: room.id,
          roomId: room.id,
          name: room.name,
          type: room.type,
          pinned_message_id: room.pinned_message_id,
          members
        });

        // 5. Tell existing members someone new joined
        socket.to(`room_${roomId}`).emit('userJoinedRoom', {
          userId: socket.userId,
          roomId
        });

        // 6. Also emit a 'roomsUpdated' so the client refreshes room list
        socket.emit('roomsUpdated');

        console.log(`✅ User ${socket.userId} accepted invite and joined room ${roomId}`);
      }
    });
    
    socket.on('typing', (data) => {
      if (!socket.userId) return;
      
      const user = userOps.findById(socket.userId);
      socket.to(`room_${data.roomId}`).emit('userTyping', {
        userId: socket.userId,
        username: user?.username,
        roomId: data.roomId
      });
    });
    
    socket.on('stopTyping', (data) => {
      if (!socket.userId) return;
      
      socket.to(`room_${data.roomId}`).emit('userStoppedTyping', {
        userId: socket.userId,
        roomId: data.roomId
      });
    });
    
    socket.on('getRoomMessages', (roomId) => {
      if (!socket.userId) return;
      
      const messages = messageOps.getByRoom(roomId);
      socket.emit('roomMessages', { roomId, messages });
    });
    
    socket.on('disconnect', () => {
      if (socket.userId) {
        onlineUsers.delete(socket.userId);
        io.emit('userOffline', socket.userId);
        io.emit('usersUpdate', getOnlineUsers());
        console.log(`❌ User ${socket.userId} disconnected`);
      }
    });
  });
  
  function getOnlineUsers() {
    const users = [];
    onlineUsers.forEach((info, userId) => {
      users.push({ userId, username: info.username });
    });
    return users;
  }
}

module.exports = setupSocket;
