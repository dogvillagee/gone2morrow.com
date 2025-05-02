const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid');

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const app = express();
app.use(cors({
  origin: FRONTEND_URL,
  methods: ["GET", "POST"]
}));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
      origin: FRONTEND_URL,
      methods: ["GET", "POST"]
  }
});

const activeUsers = {};
let drawHistory = [];
let lastCanvasDataURL = null;
let lastCanvasUpdateTime = Date.now();
let chatMessages = [];
const activeDrawers = new Set();

const RESET_CONFIG = {
  hour: 0
};
const INACTIVITY_LIMIT = 15 * 1000;
const MAX_DRAW_HISTORY_MEMORY = 200;
const BROADCAST_INTERVAL = 50;
const SNAPSHOT_REQUEST_INTERVAL = 20000;
const SNAPSHOT_STALE_TIME = 45000;
const HISTORY_PRUNE_INTERVAL = 30000;
const MAX_CHAT_HISTORY = 20;
const USER_UNDO_REDO_LIMIT = 50;

const userStrokeHistory = {};

function trackUserStroke(userId, strokeId) {
  if (!userStrokeHistory[userId]) {
    userStrokeHistory[userId] = [];
  }
  
  userStrokeHistory[userId].push(strokeId);
  
  if (userStrokeHistory[userId].length > USER_UNDO_REDO_LIMIT) {
    userStrokeHistory[userId].shift();
  }
}

function broadcastActiveUsers() {
  const now = Date.now();
  const filteredUsers = {};
  for (const [id, user] of Object.entries(activeUsers)) {
    if (user.hasMoved && now - user.lastActive <= INACTIVITY_LIMIT) {
      filteredUsers[id] = {
        username: user.username,
        x: user.x,
        y: user.y,
        drawing: user.drawing || activeDrawers.has(id)
      };
    }
  }
  io.emit("userMouseMove", filteredUsers);
}
setInterval(broadcastActiveUsers, BROADCAST_INTERVAL);

function requestCanvasSnapshot() {
  const now = Date.now();
  const activeClientCount = Object.keys(activeUsers).filter(
    id => activeUsers[id].hasMoved && now - activeUsers[id].lastActive <= INACTIVITY_LIMIT
  ).length;

  if ((activeClientCount > 0 && now - lastCanvasUpdateTime > SNAPSHOT_STALE_TIME) || !lastCanvasDataURL) {
    let mostRecentActiveId = null;
    let maxLastActiveTime = 0;
    for (const [id, user] of Object.entries(activeUsers)) {
      if (user.hasMoved && user.lastActive > maxLastActiveTime) {
        mostRecentActiveId = id;
        maxLastActiveTime = user.lastActive;
      }
    }
    if (mostRecentActiveId) {
      console.log(`Requesting snapshot from user ${mostRecentActiveId}`);
      io.to(mostRecentActiveId).emit("requestCanvasSnapshot");
    }
  }
}
setInterval(requestCanvasSnapshot, SNAPSHOT_REQUEST_INTERVAL);

function pruneDrawHistory() {
  if (drawHistory.length > MAX_DRAW_HISTORY_MEMORY) {
    const removedCount = drawHistory.length - MAX_DRAW_HISTORY_MEMORY;
    console.log(`Pruning draw history from ${drawHistory.length} to ${MAX_DRAW_HISTORY_MEMORY} strokes`);
    
    const strokesToRemove = drawHistory.slice(0, removedCount);
    strokesToRemove.forEach(stroke => {
      Object.keys(userStrokeHistory).forEach(userId => {
        const index = userStrokeHistory[userId].indexOf(stroke.id);
        if (index !== -1) {
          userStrokeHistory[userId].splice(index, 1);
        }
      });
    });
    
    drawHistory = drawHistory.slice(removedCount);
  }
}
setInterval(pruneDrawHistory, HISTORY_PRUNE_INTERVAL);

function clearCanvas() {
  console.log("Clearing canvas state...");
  drawHistory = [];
  lastCanvasDataURL = null;
  lastCanvasUpdateTime = Date.now();
  chatMessages = [];
  Object.keys(userStrokeHistory).forEach(userId => {
    userStrokeHistory[userId] = [];
  });
  io.emit("clear");
  console.log("Canvas cleared at", new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

let resetTimeoutId = null;

function scheduleReset() {
    if (resetTimeoutId) clearTimeout(resetTimeoutId);

    if (RESET_CONFIG.testMode && RESET_CONFIG.testDelayMinutes) {
        const delayMs = RESET_CONFIG.testDelayMinutes * 60 * 1000;
        console.log(`TEST MODE: Scheduling wipe in ${RESET_CONFIG.testDelayMinutes} min.`);
        resetTimeoutId = setTimeout(() => {
            console.log("TEST MODE: Performing wipe!");
            clearCanvas();
            scheduleReset();
        }, delayMs);
        return;
    }

    const now = new Date();
    const estDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const targetDate = new Date(estDate);

    targetDate.setHours(RESET_CONFIG.hour, 0, 0, 0);

    if (estDate >= targetDate) {
        targetDate.setDate(targetDate.getDate() + 1);
    }

    const msUntilReset = targetDate.getTime() - estDate.getTime();
    const hoursUntil = Math.floor(msUntilReset / (1000 * 60 * 60));
    const minutesUntil = Math.floor((msUntilReset / (1000 * 60)) % 60);
    console.log(
        `Next reset: ${targetDate.toLocaleString("en-US", { timeZone: "America/New_York" })} (in ${hoursUntil}h ${minutesUntil}m)`
    );

    resetTimeoutId = setTimeout(() => {
        console.log("Performing scheduled daily wipe...");
        clearCanvas();
        scheduleReset();
    }, msUntilReset);
}

io.on("connection", socket => {
  console.log("User connected:", socket.id);

  activeUsers[socket.id] = {
    username: `Anonymous${Math.floor(Math.random() * 1000)}`,
    x: 0, y: 0, drawing: false, lastActive: Date.now(), hasMoved: false,
  };
  
  userStrokeHistory[socket.id] = [];

  console.log(`Sending ${drawHistory.length} history strokes to ${socket.id}`);
  socket.emit("initialHistory", drawHistory);

  if (lastCanvasDataURL) {
    console.log(`Sending snapshot to ${socket.id}`);
    socket.emit("canvasState", lastCanvasDataURL);
  }
  socket.emit("chatHistory", chatMessages);

  broadcastActiveUsers();

  socket.on("setUsername", username => {
    const user = activeUsers[socket.id];
    if (user && typeof username === 'string' && username.trim()) {
      user.username = username.slice(0, 30);
      user.lastActive = Date.now();
      console.log(`User ${socket.id} is now ${user.username}`);
      broadcastActiveUsers();
    }
  });

  socket.on("mouseMove", data => {
    const user = activeUsers[socket.id];
    if (user && data && typeof data.x === 'number' && typeof data.y === 'number') {
      user.x = data.x; user.y = data.y;
      user.lastActive = Date.now();
      user.hasMoved = true;
    }
  });

  socket.on("startDrawing", data => {
    const user = activeUsers[socket.id];
    if (user && data && typeof data.x === 'number' && typeof data.y === 'number') {
      user.drawing = true;
      user.x = data.x; user.y = data.y;
      user.lastActive = Date.now();
      user.hasMoved = true;

      activeDrawers.add(socket.id);
      broadcastActiveUsers();
    }
  });

  socket.on("draw", data => {
     if (data && typeof data.x0 === 'number' && typeof data.y0 === 'number' &&
        typeof data.x1 === 'number' && typeof data.y1 === 'number' &&
        typeof data.color === 'string' && typeof data.size === 'number') {

        socket.broadcast.emit("draw", {
          ...data,
          userId: socket.id
        });

        const user = activeUsers[socket.id];
        if (user) {
            user.x = data.x1; user.y = data.y1;
            user.lastActive = Date.now();
            user.hasMoved = true;
            if (!user.drawing) {
              user.drawing = true;
              activeDrawers.add(socket.id);
            }
        }
     } else {
         console.warn(`Invalid draw data from ${socket.id}:`, JSON.stringify(data));
     }
  });

  socket.on("addStroke", (strokeData) => {
      if (strokeData && strokeData.id && Array.isArray(strokeData.segments) && strokeData.segments.length > 0) {
          const completeStroke = {
              ...strokeData,
              userId: socket.id,
              undone: false
          };
          
          drawHistory.push(completeStroke);
          trackUserStroke(socket.id, strokeData.id);

          io.emit("newStroke", completeStroke);
          pruneDrawHistory();
      } else {
          console.warn(`Received invalid stroke data from ${socket.id}:`, strokeData);
      }
  });

  socket.on("stopDrawing", () => {
    const user = activeUsers[socket.id];
    if (user) {
      user.drawing = false;
      user.lastActive = Date.now();
      activeDrawers.delete(socket.id);
      broadcastActiveUsers();
    }
  });

  socket.on("canvasSnapshot", dataURL => {
    if (typeof dataURL === 'string' && dataURL.startsWith("data:image/")) {
      lastCanvasDataURL = dataURL;
      lastCanvasUpdateTime = Date.now();
    } else {
        console.warn(`Invalid snapshot data from ${socket.id}`);
    }
  });

  socket.on("undo", () => {
      const userId = socket.id;
      
      if (!userStrokeHistory[userId] || userStrokeHistory[userId].length === 0) {
          console.log(`No strokes found for user ${userId} to undo.`);
          return;
      }
      
      let undoPerformed = false;
      
      for (let i = userStrokeHistory[userId].length - 1; i >= 0; i--) {
          const strokeId = userStrokeHistory[userId][i];
          const strokeIndex = drawHistory.findIndex(s => s && s.id === strokeId);
          
          if (strokeIndex !== -1 && !drawHistory[strokeIndex].undone) {
              drawHistory[strokeIndex].undone = true;
              console.log(`User ${userId} undid stroke ${strokeId}`);
              io.emit("strokeUndoStateChanged", { strokeId: strokeId, undone: true });
              undoPerformed = true;
              break;
          }
      }
      
      if (!undoPerformed) {
          console.log(`No active strokes found for user ${userId} to undo.`);
      }
  });

  socket.on("redo", () => {
      const userId = socket.id;
      
      if (!userStrokeHistory[userId] || userStrokeHistory[userId].length === 0) {
          console.log(`No strokes found for user ${userId} to redo.`);
          return;
      }
      
      let redoPerformed = false;
      
      for (let i = userStrokeHistory[userId].length - 1; i >= 0; i--) {
          const strokeId = userStrokeHistory[userId][i];
          const strokeIndex = drawHistory.findIndex(s => s && s.id === strokeId);
          
          if (strokeIndex !== -1 && drawHistory[strokeIndex].undone) {
              drawHistory[strokeIndex].undone = false;
              console.log(`User ${userId} redid stroke ${strokeId}`);
              io.emit("strokeUndoStateChanged", { strokeId: strokeId, undone: false });
              redoPerformed = true;
              break;
          }
      }
      
      if (!redoPerformed) {
          console.log(`No undone strokes found for user ${userId} to redo.`);
      }
  });

  socket.on("sendMessage", (messageData) => {
    const user = activeUsers[socket.id];
    if (user && messageData && typeof messageData.text === 'string') {
      const sanitizedText = messageData.text.trim().slice(0, 200);

      if (sanitizedText) {
          const message = {
            text: sanitizedText,
            username: user.username,
            timestamp: new Date().toISOString()
          };
          chatMessages.push(message);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages = chatMessages.slice(-MAX_CHAT_HISTORY);
          }
          io.emit("chatMessage", message);
      }
    } else {
        console.warn(`Invalid chat data from ${socket.id}:`, messageData);
    }
  });

  socket.on("disconnect", (reason) => {
    const user = activeUsers[socket.id];
    const username = user ? user.username : 'Unknown';
    console.log(`User ${username} (${socket.id}) disconnected: ${reason}`);

    activeDrawers.delete(socket.id);
    delete activeUsers[socket.id];
    broadcastActiveUsers();
  });

  socket.on("error", (error) => {
      console.error(`Socket error (${socket.id}):`, error);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  scheduleReset();
});