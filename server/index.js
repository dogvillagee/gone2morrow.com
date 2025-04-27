// Original index.js (Server)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors()); // Enable CORS for all origins

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }, // Allow all origins for Socket.IO
});

// --- In-memory state ---
const activeUsers = {}; // Stores data about connected users { id: { username, x, y, drawing, lastActive, hasMoved } }
let drawHistory = [];   // Stores drawing actions { x0, y0, x1, y1, color, size, username }
let lastCanvasDataURL = null; // Stores the most recent full canvas state as a data URL
let lastCanvasUpdateTime = Date.now(); // Timestamp of the last canvas update

// --- Configuration ---
// testing config below
const RESET_CONFIG = {
  hour: 0,           // midnight EST 
  // testMode: false,    //
  // testDelayMinutes: 1, //
};
const INACTIVITY_LIMIT = 15 * 1000; // 15 seconds ish
const MAX_DRAW_HISTORY = 5000; // Max number of draw segments to keep in history 
const BROADCAST_INTERVAL = 1000; // How often to broadcast user positions (ms)
const SNAPSHOT_REQUEST_INTERVAL = 15000; // How often to check if a snapshot is needed (ms)
const SNAPSHOT_STALE_TIME = 30000; // If no snapshot received in this time, request one (ms)
const HISTORY_PRUNE_INTERVAL = 60000; // How often to prune the draw history (ms)

// --- Core Functions --

function broadcastActiveUsers() {
  const now = Date.now();
  const filtered = {}; // Renamed from filteredUsers
  for (const [id, user] of Object.entries(activeUsers)) {
    if (user.hasMoved && now - user.lastActive <= INACTIVITY_LIMIT) {
      filtered[id] = {
        username: user.username,
        x: user.x,
        y: user.y,
        drawing: user.drawing,
      };
    }
  }
  io.emit("userMouseMove", filtered);
}
setInterval(broadcastActiveUsers, BROADCAST_INTERVAL); // Use constant

function requestCanvasSnapshot() {
  const now = Date.now();
  const activeCount = Object.keys(activeUsers).filter(
    id => activeUsers[id].hasMoved && now - activeUsers[id].lastActive <= INACTIVITY_LIMIT
  ).length;

  if ((activeCount > 0 && now - lastCanvasUpdateTime > SNAPSHOT_STALE_TIME) || !lastCanvasDataURL) { 
    let oldestId = null; //Renamed from oldestActiveUserId
    let oldestTime = Infinity;
    for (const [id, user] of Object.entries(activeUsers)) {
      
      if (user.hasMoved && user.lastActive < oldestTime) {
        oldestId = id;
        oldestTime = user.lastActive;
      }
    }
    if (oldestId) io.to(oldestId).emit("requestCanvasSnapshot");
  }
}
setInterval(requestCanvasSnapshot, SNAPSHOT_REQUEST_INTERVAL); 
function pruneDrawHistory() {
  if (drawHistory.length > MAX_DRAW_HISTORY) { 
    drawHistory = drawHistory.slice(-MAX_DRAW_HISTORY); //Keep last N items
  }
}
setInterval(pruneDrawHistory, HISTORY_PRUNE_INTERVAL); 

function clearCanvas() {
  drawHistory = [];
  lastCanvasDataURL = null;
  lastCanvasUpdateTime = Date.now(); //Update time on clear
  io.emit("clear");
  console.log("Canvas cleared at", new Date().toLocaleString()); //log format
}

let resetTimeoutId = null;
function scheduleReset() {
    //scheduleReset logic
    if (resetTimeoutId) clearTimeout(resetTimeoutId);

    if (RESET_CONFIG.testMode && RESET_CONFIG.testDelayMinutes) {
        const ms = RESET_CONFIG.testDelayMinutes * 60 * 1000;
        console.log(`TEST MODE: scheduling a canvas wipe in ${RESET_CONFIG.testDelayMinutes} minutes.`);
        resetTimeoutId = setTimeout(() => {
        console.log("TEST MODE: performing scheduled canvas wipe now!");
        clearCanvas();
        scheduleReset();
        }, ms);
        return;
    }

    const now = new Date();
    const est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const target = new Date(est);

    const hour = Math.floor(RESET_CONFIG.hour);
    const minute = Math.round((RESET_CONFIG.hour - hour) * 60);
    target.setHours(hour, minute, 0, 0);

    if (est >= target) {
        target.setDate(target.getDate() + 1);
    }

    const msUntil = target - est;
    const hrs = Math.floor(msUntil / (1000 * 60 * 60));
    const mins = Math.floor((msUntil / (1000 * 60)) % 60);

    console.log(
        `Next canvas reset scheduled for ${target.toLocaleString()} EST (in ${hrs}h ${mins}m)` // log format
    );
    resetTimeoutId = setTimeout(() => {
        clearCanvas();
        scheduleReset();
    }, msUntil);
}

// --- Socket.IO Connection Handling ---
io.on("connection", socket => {
  console.log("User connected:", socket.id);

  //anonymous username assignment
  activeUsers[socket.id] = {
    username: "Anonymous", // Set base name, will be updated by client if needed
    x: 0,
    y: 0,
    drawing: false,
    lastActive: Date.now(),
    hasMoved: false,
  };

  //Send initial state
  if (lastCanvasDataURL) {
    socket.emit("canvasState", lastCanvasDataURL);
  } else {
    socket.emit("initialCanvas", drawHistory);
  }

  broadcastActiveUsers(); // Notify about the new/updated user list

  // --- Socket Event Handlers ---

  socket.on("setUsername", username => {
    const u = activeUsers[socket.id];
    if (u) {
      u.username = username; // Directly assign username from client
      u.lastActive = Date.now();
      broadcastActiveUsers();
    }
  });

  socket.on("mouseMove", data => {
    const u = activeUsers[socket.id];
    if (u && data && typeof data.x === 'number' && typeof data.y === 'number') { //Added validation
      u.x = data.x;
      u.y = data.y;
      u.lastActive = Date.now();
      u.hasMoved = true;
      //broadcast handled by interval
    }
  });

  socket.on("startDrawing", data => {
    const u = activeUsers[socket.id];
    if (u && data && typeof data.x === 'number' && typeof data.y === 'number') { //Added validation
      u.drawing = true;
      u.x = data.x;
      u.y = data.y;
      u.lastActive = Date.now();
      u.hasMoved = true;
      broadcastActiveUsers(); //Broadcast change in drawing state
    }
  });

  socket.on("draw", data => {
     //
     if (data && typeof data.x0 === 'number' && typeof data.y0 === 'number' &&
        typeof data.x1 === 'number' && typeof data.y1 === 'number' &&
        typeof data.color === 'string' && typeof data.size === 'number') {
        drawHistory.push(data);
        socket.broadcast.emit("draw", data);
        const u = activeUsers[socket.id];
        if (u) {
            u.x = data.x1;
            u.y = data.y1;
            u.lastActive = Date.now();
            u.hasMoved = true;
            broadcastActiveUsers(); //code didn't broadcast here
        }
     } else {
         console.warn(`Received invalid draw data from ${socket.id}:`, data); // Added warning
     }
  });

  socket.on("stopDrawing", () => {
    const u = activeUsers[socket.id];
    if (u) {
      u.drawing = false;
      u.lastActive = Date.now();
      broadcastActiveUsers(); // Broadcast change in drawing state
    }
  });

  socket.on("canvasState", dataURL => {
    // Added validation from original file structure
    if (typeof dataURL === 'string' && dataURL.startsWith("data:image/")) {
      lastCanvasDataURL = dataURL;
      lastCanvasUpdateTime = Date.now();
      socket.broadcast.emit("canvasState", dataURL);
      // Original code didn't clear history here, snapshot replaces it implicitly on client
    } else {
        console.warn(`Received invalid canvas state data from ${socket.id}`); // Added warning
    }
  });

  socket.on("canvasSnapshot", dataURL => {
    // Added validation from original file structure
    if (typeof dataURL === 'string' && dataURL.startsWith("data:image/")) {
      lastCanvasDataURL = dataURL;
      lastCanvasUpdateTime = Date.now();
       // Original code didn't clear history here
    } else {
        console.warn(`Received invalid canvas snapshot data from ${socket.id}`); // Added warning
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id); // Original log
    delete activeUsers[socket.id];
    broadcastActiveUsers();
  });
});

// --- Start Server ---
server.listen(4000, () => {
  console.log("Server running on http://localhost:4000"); // Original log
  scheduleReset(); // Start the reset schedule
});