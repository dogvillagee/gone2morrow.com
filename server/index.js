//server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid'); //Import UUID library

const app = express();
//Basic CORS setup - allow all origins for development
app.use(cors({
    origin: "*", //IMPORTANT restrict this in production change to gone2morrow.com
    methods: ["GET", "POST"]
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
      origin: "*", //Match app's CORS settings
      methods: ["GET", "POST"]
  },
  //Consider increasing if strokes/snapshots are large
  //maxHttpBufferSize: 1e8 // 100 MB
});

//In-memory State
const activeUsers = {}; //this feature doesnt work yet,

//mod Stores history of strokes, including userId and undone status
// Each stroke: { id: string, userId: string, segments: [ {x0,y0,x1,y1,color,size}, ... ], undone: boolean }
let drawHistory = []; // Stores strokes now, not individual segments

//stores the latest full canvas image as a Data URL for quick sync
let lastCanvasDataURL = null;
let lastCanvasUpdateTime = Date.now(); // When the snapshot was last updated
let chatMessages = []; // store messages, username, timestamp


const RESET_CONFIG = { //config constant and testing below
  hour: 0, // Hour (in EST) 0 is midnight
  // testMode: true, // uncomment fir testing
  // testDelayMinutes: 1 // uncomment fir testing
};
const INACTIVITY_LIMIT = 15 * 1000;      //How long until a non-moving user's cursor disappears
const MAX_DRAW_HISTORY_MEMORY = 5000;  //Max *strokes* kept in server memory
const BROADCAST_INTERVAL = 50;         //How often (ms) to send user position updates
const SNAPSHOT_REQUEST_INTERVAL = 20000; //How often (ms) to check if a new snapshot is needed
const SNAPSHOT_STALE_TIME = 45000;       //How old (ms) a snapshot can be before requesting a new one
const HISTORY_PRUNE_INTERVAL = 60000;    //How often (ms) to prune the in-memory draw history
const MAX_CHAT_HISTORY = 20;             //Max number of chat messages stored/sent on join


//Function to broadcast redraw command based on history 
function broadcastRedraw() {
    //Send the full history of strokes. Clients will redraw based on this.
    io.emit("redrawCanvas", drawHistory);
    console.log(`Broadcasting redraw command with ${drawHistory.length} strokes.`);
    //Clear the snapshot after undo/redo as it's now potentially invalid
    //Clients will need to send a new one if they are the source of truth
    lastCanvasDataURL = null;
    lastCanvasUpdateTime = Date.now(); // Reset update time
}

// Broadcasts active user positions/status (throttled by BROADCAST_INTERVAL)
function broadcastActiveUsers() {
  const now = Date.now();
  const filteredUsers = {};
  // Filter users who have moved and were active recently
  for (const [id, user] of Object.entries(activeUsers)) {
    if (user.hasMoved && now - user.lastActive <= INACTIVITY_LIMIT) {
      filteredUsers[id] = { username: user.username, x: user.x, y: user.y, drawing: user.drawing };
    }
  }
  io.emit("userMouseMove", filteredUsers); // Send to all clients
}
// Set interval for broadcasting user positions (now more frequent)
setInterval(broadcastActiveUsers, BROADCAST_INTERVAL);

// Periodically checks if the canvas snapshot is stale and requests a new one if needed
function requestCanvasSnapshot() {
  const now = Date.now();
  const activeClientCount = Object.keys(activeUsers).filter(
    id => activeUsers[id].hasMoved && now - activeUsers[id].lastActive <= INACTIVITY_LIMIT
  ).length;

  // Request if active clients exist AND (snapshot is stale OR no snapshot exists)
  if ((activeClientCount > 0 && now - lastCanvasUpdateTime > SNAPSHOT_STALE_TIME) || !lastCanvasDataURL) {
    let mostRecentActiveId = null;
    let maxLastActiveTime = 0;
    // Find the most recently active client to request from
    for (const [id, user] of Object.entries(activeUsers)) {
      if (user.hasMoved && user.lastActive > maxLastActiveTime) {
        mostRecentActiveId = id;
        maxLastActiveTime = user.lastActive;
      }
    }
    // Send request to that specific client
    if (mostRecentActiveId) {
      console.log(`Requesting snapshot from user ${mostRecentActiveId}`);
      io.to(mostRecentActiveId).emit("requestCanvasSnapshot");
    }
  }
}
setInterval(requestCanvasSnapshot, SNAPSHOT_REQUEST_INTERVAL);

// Periodically prunes the in-memory draw history to prevent excessive memory use
function pruneDrawHistory() {
  if (drawHistory.length > MAX_DRAW_HISTORY_MEMORY) {
    console.log(`Pruning draw history from ${drawHistory.length} to ${MAX_DRAW_HISTORY_MEMORY} strokes`);
    drawHistory = drawHistory.slice(-MAX_DRAW_HISTORY_MEMORY); // Keep only the tail end
  }
}
setInterval(pruneDrawHistory, HISTORY_PRUNE_INTERVAL);

// Clears all canvas state (history, snapshot) and chat, notifies clients
function clearCanvas() {
  console.log("Clearing canvas state...");
  drawHistory = []; // Clear stroke history
  lastCanvasDataURL = null;
  lastCanvasUpdateTime = Date.now();
  chatMessages = []; // Clear chat too
  io.emit("clear"); // Notify clients
  console.log("Canvas cleared at", new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

//Daily Reset Scheduling
let resetTimeoutId = null; // Stores the timeout ID for cancellation

// Schedules the next canvas reset based on EST
function scheduleReset() {
    if (resetTimeoutId) clearTimeout(resetTimeoutId); // Clear previous timeout

    // --- Optional Test Mode ---
    if (RESET_CONFIG.testMode && RESET_CONFIG.testDelayMinutes) {
        const delayMs = RESET_CONFIG.testDelayMinutes * 60 * 1000;
        console.log(`TEST MODE: Scheduling wipe in ${RESET_CONFIG.testDelayMinutes} min.`);
        resetTimeoutId = setTimeout(() => {
            console.log("TEST MODE: Performing wipe!");
            clearCanvas();
            scheduleReset(); // Reschedule test
        }, delayMs);
        return;
    }
    // --- End Test Mode ---

    const now = new Date();
    const estDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const targetDate = new Date(estDate); // Target date based on current EST date

    // Set target time (e.g., midnight EST)
    targetDate.setHours(RESET_CONFIG.hour, 0, 0, 0); // H:00:00.000

    // If target time already passed today in EST, schedule for tomorrow
    if (estDate >= targetDate) {
        targetDate.setDate(targetDate.getDate() + 1);
    }

    const msUntilReset = targetDate.getTime() - estDate.getTime(); // Time difference
    const hoursUntil = Math.floor(msUntilReset / (1000 * 60 * 60));
    const minutesUntil = Math.floor((msUntilReset / (1000 * 60)) % 60);
    console.log(
        `Next reset: ${targetDate.toLocaleString("en-US", { timeZone: "America/New_York" })} (in ${hoursUntil}h ${minutesUntil}m)`
    );

    // Set the actual timeout
    resetTimeoutId = setTimeout(() => {
        console.log("Performing scheduled daily wipe...");
        clearCanvas();
        scheduleReset(); // Schedule the *next* day's reset
    }, msUntilReset);
}

// --- Socket.IO Connection Logic ---
io.on("connection", socket => {
  console.log("User connected:", socket.id);

  // Initialize user data in activeUsers
  activeUsers[socket.id] = {
    username: `Anonymous${Math.floor(Math.random() * 1000)}`, // Assign default name
    x: 0, y: 0, drawing: false, lastActive: Date.now(), hasMoved: false,
  };

  // --- Send Initial State to New Client ---
  // 1. Prefer sending snapshot if available
  if (lastCanvasDataURL) {
    console.log(`Sending snapshot to ${socket.id}`);
    socket.emit("canvasState", lastCanvasDataURL);
  } else {
    // 2. Otherwise, send stroke history (client redraws from this)
    console.log(`No snapshot, sending ${drawHistory.length} history strokes to ${socket.id}`);
    socket.emit("initialHistory", drawHistory); // Use a distinct event name
  }
  // 3. Send recent chat messages
  socket.emit("chatHistory", chatMessages);

  // Notify others (implicitly includes the new user via broadcast)
  broadcastActiveUsers();

  // --- Socket Event Listeners (for this specific client) ---

  // Client sets their username
  socket.on("setUsername", username => {
    const user = activeUsers[socket.id];
    if (user && typeof username === 'string' && username.trim()) {
      user.username = username.slice(0, 30); // Limit length
      user.lastActive = Date.now();
      console.log(`User ${socket.id} is now ${user.username}`);
      broadcastActiveUsers(); // Update others
    }
  });

  // Client sends mouse/cursor position
  socket.on("mouseMove", data => {
    const user = activeUsers[socket.id];
    if (user && data && typeof data.x === 'number' && typeof data.y === 'number') {
      user.x = data.x; user.y = data.y; // Update position
      user.lastActive = Date.now();
      user.hasMoved = true; // Mark as active
      // Position is broadcasted via interval timer, not here directly
    }
  });

  // Client starts drawing
  socket.on("startDrawing", data => {
    const user = activeUsers[socket.id];
    if (user && data && typeof data.x === 'number' && typeof data.y === 'number') {
      user.drawing = true;
      user.x = data.x; user.y = data.y; // Update position
      user.lastActive = Date.now();
      user.hasMoved = true;
      console.log(`${user.username} started drawing`);
      broadcastActiveUsers(); // Broadcast immediately to show drawing status
    }
  });

  // --- RE-ADDED: Listener for individual drawing segments (for live preview) ---
  socket.on("draw", data => {
     // Basic validation of draw data
     if (data && typeof data.x0 === 'number' && typeof data.y0 === 'number' &&
        typeof data.x1 === 'number' && typeof data.y1 === 'number' &&
        typeof data.color === 'string' && typeof data.size === 'number') {

        // Just broadcast this segment to others for live preview
        socket.broadcast.emit("draw", data);

        // Update sender's state (needed for cursor position)
        const user = activeUsers[socket.id];
        if (user) {
            user.x = data.x1; user.y = data.y1; // Update position to end of line
            user.lastActive = Date.now();
            user.hasMoved = true;
        }
        // DO NOT add individual segments to the main drawHistory here
     } else {
         console.warn(`Invalid draw data from ${socket.id}:`, JSON.stringify(data));
     }
  });

  // --- NEW: Listener for completed strokes from client ---
  socket.on("addStroke", (strokeData) => {
      // Validate stroke data
      if (strokeData && strokeData.id && Array.isArray(strokeData.segments) && strokeData.segments.length > 0) {
          // Add userId and undone status
          const completeStroke = {
              ...strokeData,
              userId: socket.id, // Tag with the user who sent it
              undone: false
          };
          // Add the complete stroke to history
          drawHistory.push(completeStroke);
          console.log(`Added stroke ${completeStroke.id} from user ${socket.id}`);
          // Do NOT broadcast the stroke itself here, rely on snapshot + redrawCanvas for sync
          // Pruning happens via interval
      } else {
          console.warn(`Received invalid stroke data from ${socket.id}:`, strokeData);
      }
  });

  // Client stops drawing
  socket.on("stopDrawing", () => {
    const user = activeUsers[socket.id];
    if (user) {
      user.drawing = false;
      user.lastActive = Date.now();
      console.log(`${user.username} stopped drawing`);
      broadcastActiveUsers(); // Broadcast status change
      // Client now sends stroke via "addStroke" and snapshot via "canvasSnapshot"
    }
  });

  // Client sends a canvas snapshot (usually after drawing or by request)
  socket.on("canvasSnapshot", dataURL => {
    if (typeof dataURL === 'string' && dataURL.startsWith("data:image/")) {
      // console.log(`Received snapshot from ${socket.id}`);
      lastCanvasDataURL = dataURL; // Update the authoritative snapshot
      lastCanvasUpdateTime = Date.now();
      // Don't usually need to broadcast this, new users will get it on join
    } else {
        console.warn(`Invalid snapshot data from ${socket.id}`);
    }
  });

  // --- NEW: Per-User Undo Logic ---
  socket.on("undo", () => {
      const userId = socket.id;
      let strokeIndexToUndo = -1;
      // Find the latest stroke by this user that is NOT undone
      for (let i = drawHistory.length - 1; i >= 0; i--) {
          if (drawHistory[i].userId === userId && !drawHistory[i].undone) {
              strokeIndexToUndo = i;
              break;
          }
      }

      if (strokeIndexToUndo !== -1) {
          drawHistory[strokeIndexToUndo].undone = true; // Mark as undone
          console.log(`User ${userId} undid stroke ${drawHistory[strokeIndexToUndo].id}`);
          broadcastRedraw(); // Tell all clients to redraw from history
      } else {
          console.log(`No active stroke found for user ${userId} to undo.`);
      }
  });

  // --- NEW: Per-User Redo Logic ---
  socket.on("redo", () => {
      const userId = socket.id;
      let strokeIndexToRedo = -1;
      // Find the latest stroke by this user that IS undone
      for (let i = drawHistory.length - 1; i >= 0; i--) {
          if (drawHistory[i].userId === userId && drawHistory[i].undone) {
              strokeIndexToRedo = i;
              break;
          }
      }

      if (strokeIndexToRedo !== -1) {
          drawHistory[strokeIndexToRedo].undone = false; // Mark as not undone
          console.log(`User ${userId} redid stroke ${drawHistory[strokeIndexToRedo].id}`);
          broadcastRedraw(); // Tell all clients to redraw from history
      } else {
          console.log(`No undone stroke found for user ${userId} to redo.`);
      }
  });

  // --- REMOVED: Old canvasState listener for broadcasting client undo/redo ---


  // Client sends a chat message
  socket.on("sendMessage", (messageData) => {
    const user = activeUsers[socket.id];
    // Validate user and message text
    if (user && messageData && typeof messageData.text === 'string') {
      const sanitizedText = messageData.text.trim().slice(0, 200); // Trim and limit length

      if (sanitizedText) { // Only process non-empty messages
          const message = {
            text: sanitizedText,
            username: user.username, // Use server-side username
            timestamp: new Date().toISOString() // Add server timestamp
          };
          // Add to chat history and prune if necessary
          chatMessages.push(message);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages = chatMessages.slice(-MAX_CHAT_HISTORY);
          }
          // Broadcast message to ALL clients (including sender)
          io.emit("chatMessage", message);
          // console.log(`Chat [${user.username}]: ${sanitizedText}`);
      }
    } else {
        console.warn(`Invalid chat data from ${socket.id}:`, messageData);
    }
  });

  // Client disconnects
  socket.on("disconnect", (reason) => {
    const user = activeUsers[socket.id];
    const username = user ? user.username : 'Unknown';
    console.log(`User ${username} (${socket.id}) disconnected: ${reason}`);
    delete activeUsers[socket.id]; // Remove from active list
    broadcastActiveUsers(); // Notify others
  });

  // Handle socket errors
  socket.on("error", (error) => {
      console.error(`Socket error (${socket.id}):`, error);
  });
});

// --- Start the HTTP Server ---
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  // Schedule the first canvas reset when server starts
  scheduleReset();
});
