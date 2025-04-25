const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

//In-memory state
const activeUsers = {};
let drawHistory = [];
let lastCanvasDataURL = null;
let lastCanvasUpdateTime = Date.now();

//testing config below
const RESET_CONFIG = {
  hour: 0,           // midnight EST
  // testMode: false,
  // testDelayMinutes: 1,
};

const INACTIVITY_LIMIT = 5 * 1000; // 5 seconds

function broadcastActiveUsers() {
  const now = Date.now();
  const filtered = {};
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
setInterval(broadcastActiveUsers, 1000);

function requestCanvasSnapshot() {
  const now = Date.now();
  const activeCount = Object.keys(activeUsers).filter(
    id =>
      activeUsers[id].hasMoved &&
      now - activeUsers[id].lastActive <= INACTIVITY_LIMIT
  ).length;

  if (
    (activeCount > 0 && now - lastCanvasUpdateTime > 30000) ||
    !lastCanvasDataURL
  ) {
    let oldestId = null,
      oldestTime = Infinity;
    for (const [id, user] of Object.entries(activeUsers)) {
      if (user.hasMoved && user.lastActive < oldestTime) {
        oldestId = id;
        oldestTime = user.lastActive;
      }
    }
    if (oldestId) io.to(oldestId).emit("requestCanvasSnapshot");
  }
}
setInterval(requestCanvasSnapshot, 15000);

const MAX_DRAW_HISTORY = 5000;
function pruneDrawHistory() {
  if (drawHistory.length > MAX_DRAW_HISTORY) {
    drawHistory = drawHistory.slice(-MAX_DRAW_HISTORY);
  }
}
setInterval(pruneDrawHistory, 60000);

function clearCanvas() {
  drawHistory = [];
  lastCanvasDataURL = null;
  io.emit("clear");
  console.log("Canvas cleared at", new Date().toLocaleString());
}

let resetTimeoutId = null;
function scheduleReset() {
  if (resetTimeoutId) clearTimeout(resetTimeoutId);

  //If testMode is enabled, use testDelayMinutes
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

  //reg midnight-EST schedule
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
    `Next canvas reset scheduled for ${target.toLocaleString()} EST (in ${hrs}h ${mins}m)`
  );
  resetTimeoutId = setTimeout(() => {
    clearCanvas();
    scheduleReset();
  }, msUntil);
}

//Re-enable the daily reset at midnight EST:
scheduleReset();

io.on("connection", socket => {
  console.log("User connected:", socket.id);
  activeUsers[socket.id] = {
    username: "Anonymous",
    x: 0,
    y: 0,
    drawing: false,
    lastActive: Date.now(),
    hasMoved: false,
  };

  if (lastCanvasDataURL) socket.emit("canvasState", lastCanvasDataURL);
  else socket.emit("initialCanvas", drawHistory);
  broadcastActiveUsers();

  socket.on("setUsername", username => {
    const u = activeUsers[socket.id];
    if (u) {
      u.username = username;
      u.lastActive = Date.now();
      broadcastActiveUsers();
    }
  });

  socket.on("mouseMove", data => {
    const u = activeUsers[socket.id];
    if (u) {
      u.x = data.x;
      u.y = data.y;
      u.lastActive = Date.now();
      u.hasMoved = true;
      broadcastActiveUsers();
    }
  });

  socket.on("startDrawing", data => {
    const u = activeUsers[socket.id];
    if (u) {
      u.drawing = true;
      u.x = data.x;
      u.y = data.y;
      u.lastActive = Date.now();
      u.hasMoved = true;
      broadcastActiveUsers();
    }
  });

  socket.on("draw", data => {
    drawHistory.push(data);
    socket.broadcast.emit("draw", data);
    const u = activeUsers[socket.id];
    if (u) {
      u.x = data.x1;
      u.y = data.y1;
      u.lastActive = Date.now();
      u.hasMoved = true;
      broadcastActiveUsers();
    }
  });

  socket.on("stopDrawing", () => {
    const u = activeUsers[socket.id];
    if (u) {
      u.drawing = false;
      u.lastActive = Date.now();
      broadcastActiveUsers();
    }
  });

  socket.on("canvasState", dataURL => {
    if (dataURL.startsWith("data:image/")) {
      lastCanvasDataURL = dataURL;
      lastCanvasUpdateTime = Date.now();
      socket.broadcast.emit("canvasState", dataURL);
    }
  });

  socket.on("canvasSnapshot", dataURL => {
    if (dataURL.startsWith("data:image/")) {
      lastCanvasDataURL = dataURL;
      lastCanvasUpdateTime = Date.now();
    }
  });

  socket.on("disconnect", () => {
    delete activeUsers[socket.id];
    broadcastActiveUsers();
  });
});

server.listen(4000, () => {
  console.log("Server running on http://localhost:4000");
});
