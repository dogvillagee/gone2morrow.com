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
  },
});

const activeUsers = {};
let drawHistory = [];
let lastCanvasDataURL = null;
let lastCanvasUpdateTime = Date.now();
let chatMessages = [];
const activeDrawers = new Set();
const RESERVED_NAMES = new Set(['admin', 'mod', 'moderator', 'system', 'server', 'gone2morrow']);

const RESET_CONFIG = {
  hour: 0,
};
const INACTIVITY_LIMIT = 15 * 1000;
const MAX_DRAW_HISTORY_MEMORY = 500;
const BROADCAST_INTERVAL = 50;
const SNAPSHOT_REQUEST_INTERVAL = 20000;
const SNAPSHOT_STALE_TIME = 45000;
const HISTORY_PRUNE_INTERVAL = 30000;
const MAX_CHAT_HISTORY = 20;

function broadcastActiveUsers() {
  const now = Date.now();
  const filteredUsers = {};
  for (const [id, user] of Object.entries(activeUsers)) {
    if (user && user.hasMoved && now - user.lastActive <= INACTIVITY_LIMIT) {
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
    id => activeUsers[id]?.hasMoved && now - activeUsers[id]?.lastActive <= INACTIVITY_LIMIT
  ).length;

  if ((activeClientCount > 0 && now - lastCanvasUpdateTime > SNAPSHOT_STALE_TIME) || !lastCanvasDataURL) {
    let mostRecentActiveId = null;
    let maxLastActiveTime = 0;
    for (const [id, user] of Object.entries(activeUsers)) {
      if (user && user.hasMoved && user.lastActive > maxLastActiveTime) {
        mostRecentActiveId = id;
        maxLastActiveTime = user.lastActive;
      }
    }
    if (mostRecentActiveId) {
      io.to(mostRecentActiveId).emit("requestCanvasSnapshot");
    }
  }
}
setInterval(requestCanvasSnapshot, SNAPSHOT_REQUEST_INTERVAL);

function pruneDrawHistory() {
  if (drawHistory.length > MAX_DRAW_HISTORY_MEMORY) {
    const removedCount = drawHistory.length - MAX_DRAW_HISTORY_MEMORY;
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
  activeDrawers.clear();
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
  const userId = socket.id;
  activeUsers[userId] = {
    username: `Anonymous${Math.floor(Math.random() * 1000)}`,
    x: 0, y: 0, drawing: false, lastActive: Date.now(), hasMoved: false,
  };

  socket.emit("initialHistory", drawHistory);

  if (lastCanvasDataURL) {
    socket.emit("canvasState", lastCanvasDataURL);
  }
  socket.emit("chatHistory", chatMessages);

  broadcastActiveUsers();

  socket.on("setUsername", username => {
    const user = activeUsers[userId];
    const cleanedUsername = typeof username === 'string' ? username.trim() : '';
    const lowerUser = cleanedUsername.toLowerCase();

    if (user && cleanedUsername && cleanedUsername.length <= 30 && !RESERVED_NAMES.has(lowerUser)) {
      user.username = cleanedUsername;
      user.lastActive = Date.now();
      broadcastActiveUsers();
    } else {
        console.warn(`User ${userId} tried to set invalid username: "${username}"`);
    }
  });


  socket.on("mouseMove", data => {
    const user = activeUsers[userId];
    if (user && data && typeof data.x === 'number' && typeof data.y === 'number') {
      user.x = data.x; user.y = data.y;
      user.lastActive = Date.now();
      user.hasMoved = true;
    }
  });

  socket.on("startDrawing", data => {
    const user = activeUsers[userId];
    if (user && data && typeof data.x === 'number' && typeof data.y === 'number') {
      user.drawing = true;
      user.x = data.x; user.y = data.y;
      user.lastActive = Date.now();
      user.hasMoved = true;
      activeDrawers.add(userId);
      broadcastActiveUsers();
    }
  });

  socket.on("draw", data => {
     if (data && typeof data.x0 === 'number' && typeof data.y0 === 'number' &&
        typeof data.x1 === 'number' && typeof data.y1 === 'number' &&
        typeof data.color === 'string' && typeof data.size === 'number') {

        socket.broadcast.emit("draw", {
          ...data,
          userId: userId
        });

        const user = activeUsers[userId];
        if (user) {
            user.x = data.x1; user.y = data.y1;
            user.lastActive = Date.now();
            user.hasMoved = true;
            if (!user.drawing) {
              user.drawing = true;
              activeDrawers.add(userId);
            }
        }
     } else {
         console.warn(`Invalid draw data from ${userId}:`, JSON.stringify(data));
     }
  });

  socket.on("addStroke", (strokeData) => {
      if (strokeData && strokeData.id && Array.isArray(strokeData.segments) && strokeData.segments.length > 0) {
          const completeStroke = {
              ...strokeData,
              userId: userId,
              undone: false
          };
          drawHistory.push(completeStroke);
          socket.broadcast.emit("newStroke", completeStroke);
          pruneDrawHistory();
      } else {
          console.warn(`Received invalid stroke data from ${userId}:`, strokeData);
      }
  });

  socket.on("stopDrawing", () => {
    const user = activeUsers[userId];
    if (user) {
      user.drawing = false;
      user.lastActive = Date.now();
      activeDrawers.delete(userId);
      broadcastActiveUsers();
    }
  });

  socket.on("canvasSnapshot", dataURL => {
    if (typeof dataURL === 'string' && dataURL.startsWith("data:image/")) {
      lastCanvasDataURL = dataURL;
      lastCanvasUpdateTime = Date.now();
    } else {
        console.warn(`Invalid snapshot data from ${userId}`);
    }
  });

  socket.on("attemptUndo", (strokeId) => {
      if (!strokeId) return;
      const targetStrokeIndex = drawHistory.findIndex(stroke => stroke.id === strokeId);

      if (targetStrokeIndex !== -1) {
          const targetStroke = drawHistory[targetStrokeIndex];
          if (targetStroke.userId === userId && !targetStroke.undone) {
              targetStroke.undone = true;
              
              io.emit("strokeUndoStateChanged", { strokeId: targetStroke.id, undone: true });
          } else {
              console.warn(`Invalid undo attempt by ${userId} for stroke ${strokeId}`);
          }
      } else {
           console.warn(`Undo attempt failed: Stroke ${strokeId} not found in history.`);
      }
  });

  socket.on("attemptRedo", (strokeId) => {
      if (!strokeId) return;
       const targetStrokeIndex = drawHistory.findIndex(stroke => stroke.id === strokeId);

      if (targetStrokeIndex !== -1) {
          const targetStroke = drawHistory[targetStrokeIndex];
          if (targetStroke.userId === userId && targetStroke.undone) {
              targetStroke.undone = false;
              
              io.emit("strokeUndoStateChanged", { strokeId: targetStroke.id, undone: false });
          } else {
               console.warn(`Invalid redo attempt by ${userId} for stroke ${strokeId}`);
          }
      } else {
           console.warn(`Redo attempt failed: Stroke ${strokeId} not found in history.`);
      }
  });


  socket.on("sendMessage", (messageData) => {
    const user = activeUsers[userId];
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
        console.warn(`Invalid chat data from ${userId}:`, messageData);
    }
  });

  socket.on("disconnect", (reason) => {
    const user = activeUsers[userId];
    const username = user ? user.username : 'Unknown';

    activeDrawers.delete(userId);
    delete activeUsers[userId];
    broadcastActiveUsers();
  });

  socket.on("error", (error) => {
      console.error(`Socket error (${userId}):`, error);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  scheduleReset();
});
