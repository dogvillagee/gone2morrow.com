//server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid'); //Import UUID library

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"; // Default for local React dev (assuming port 3000)

const app = express();
//Basic CORS setup - allow all origins for development
app.use(cors({
  origin: FRONTEND_URL, // Use the variable
  methods: ["GET", "POST"]
}));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
      origin: FRONTEND_URL, // Use the variable here too
      methods: ["GET", "POST"]
  },
  // Consider increasing maxHttpBufferSize if snapshots are large, though sending deltas is better
  // maxHttpBufferSize: 1e8 // Example: 100 MB (use with caution)
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

// Track which users are currently drawing
const activeDrawers = new Set(); // Store socket IDs of users currently drawing

const RESET_CONFIG = { //config constant and testing below
  hour: 0, // Hour (in EST) 0 is midnight
  // testMode: true, // uncomment fir testing
  // testDelayMinutes: 1 // uncomment fir testing
};
const INACTIVITY_LIMIT = 15 * 1000;      //How long until a non-moving user's cursor disappears
const MAX_DRAW_HISTORY_MEMORY = 10;  //Max *strokes* kept in server memory (CHANGED FROM 5000)
const BROADCAST_INTERVAL = 50;         //How often (ms) to send user position updates
const SNAPSHOT_REQUEST_INTERVAL = 20000; //How often (ms) to check if a new snapshot is needed
const SNAPSHOT_STALE_TIME = 45000;       //How old (ms) a snapshot can be before requesting a new one
const HISTORY_PRUNE_INTERVAL = 30000;    //How often (ms) to prune the in-memory draw history (CHANGED FROM 60000)
const MAX_CHAT_HISTORY = 20;             //Max number of chat messages stored/sent on join
const USER_UNDO_REDO_LIMIT = 5;          // How many recent strokes per user are considered for undo/redo


//Function to broadcast redraw command based on history - NO LONGER USED FOR UNDO/REDO
// function broadcastRedraw() {
//     //Send the full history of strokes. Clients will redraw based on this.
//     io.emit("redrawCanvas", drawHistory);
//     console.log(`Broadcasting redraw command with ${drawHistory.length} strokes.`);
//     //Clear the snapshot after undo/redo as it's now potentially invalid
//     //Clients will need to send a new one if they are the source of truth
//     lastCanvasDataURL = null;
//     lastCanvasUpdateTime = Date.now(); // Reset update time
// }


function broadcastActiveUsers() { //Broadcasts active user positions/status (throttled by BROADCAST_INTERVAL)
  const now = Date.now();
  const filteredUsers = {};
  //Filter users who have moved and were active recently
  for (const [id, user] of Object.entries(activeUsers)) {
    if (user.hasMoved && now - user.lastActive <= INACTIVITY_LIMIT) {
      filteredUsers[id] = {
        username: user.username,
        x: user.x,
        y: user.y,
        drawing: user.drawing || activeDrawers.has(id) // Use activeDrawers Set to correctly track drawing state
      };
    }
  }
  io.emit("userMouseMove", filteredUsers); //Send to all clients
}
//Set interval for broadcasting user positions (now more frequent)
setInterval(broadcastActiveUsers, BROADCAST_INTERVAL);

//Periodically checks if the canvas snapshot is stale and requests a new one if needed
function requestCanvasSnapshot() {
  const now = Date.now();
  const activeClientCount = Object.keys(activeUsers).filter(
    id => activeUsers[id].hasMoved && now - activeUsers[id].lastActive <= INACTIVITY_LIMIT
  ).length;

  //Request if active clients exist AND (snapshot is stale OR no snapshot exists)
  if ((activeClientCount > 0 && now - lastCanvasUpdateTime > SNAPSHOT_STALE_TIME) || !lastCanvasDataURL) {
    let mostRecentActiveId = null;
    let maxLastActiveTime = 0;
    //Find the most recently active client to request from
    for (const [id, user] of Object.entries(activeUsers)) {
      if (user.hasMoved && user.lastActive > maxLastActiveTime) {
        mostRecentActiveId = id;
        maxLastActiveTime = user.lastActive;
      }
    }
    //Send request to that specific client
    if (mostRecentActiveId) {
      console.log(`Requesting snapshot from user ${mostRecentActiveId}`);
      io.to(mostRecentActiveId).emit("requestCanvasSnapshot");
    }
  }
}
setInterval(requestCanvasSnapshot, SNAPSHOT_REQUEST_INTERVAL);

//Periodically prunes the in-memory draw history to prevent excessive memory use
function pruneDrawHistory() {
  if (drawHistory.length > MAX_DRAW_HISTORY_MEMORY) {
    const removedCount = drawHistory.length - MAX_DRAW_HISTORY_MEMORY;
    console.log(`Pruning draw history from ${drawHistory.length} to ${MAX_DRAW_HISTORY_MEMORY} strokes`);
    drawHistory = drawHistory.slice(removedCount); // Keep only the tail end
  }
}
setInterval(pruneDrawHistory, HISTORY_PRUNE_INTERVAL); // Prune more often

//Clears all canvas state (history, snapshot) and chat, notifies clients
function clearCanvas() {
  console.log("Clearing canvas state...");
  drawHistory = []; //Clear stroke history
  lastCanvasDataURL = null;
  lastCanvasUpdateTime = Date.now();
  chatMessages = []; //clear chat too
  io.emit("clear"); //notify users/clients
  console.log("Canvas cleared at", new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

//Daily Reset Scheduling
let resetTimeoutId = null; //Stores the timeout ID for cancellation

//Schedules the next canvas reset based on EST
function scheduleReset() {
    if (resetTimeoutId) clearTimeout(resetTimeoutId); //Clear previous timeout

    //Testing canvas wipes
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

    const now = new Date();
    const estDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const targetDate = new Date(estDate); //Target date based on current EST date

    //Set target time (e.g., midnight EST)
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

//Socket.IO Connection Logic
io.on("connection", socket => {
  console.log("User connected:", socket.id);

  // Initialize user data in activeUsers
  activeUsers[socket.id] = {
    username: `Anonymous${Math.floor(Math.random() * 1000)}`, // Assign default name
    x: 0, y: 0, drawing: false, lastActive: Date.now(), hasMoved: false,
  };

  //Send Initial State to New Client
  // 1. Send stroke history first for client to build state
  console.log(`Sending ${drawHistory.length} history strokes to ${socket.id}`);
  socket.emit("initialHistory", drawHistory); // Use a distinct event name

  // 2. Then send snapshot if available (client can optionally use this for faster initial load)
  if (lastCanvasDataURL) {
    console.log(`Sending snapshot to ${socket.id}`);
    socket.emit("canvasState", lastCanvasDataURL);
  }
  // 3. Send recent chat messages
  socket.emit("chatHistory", chatMessages);

  // Notify others (implicitly includes the new user via broadcast)
  broadcastActiveUsers();

  //Socket Event Listeners (for this specific client)

  //Client sets their username
  socket.on("setUsername", username => {
    const user = activeUsers[socket.id];
    if (user && typeof username === 'string' && username.trim()) {
      user.username = username.slice(0, 30); // Limit length
      user.lastActive = Date.now();
      console.log(`User ${socket.id} is now ${user.username}`);
      broadcastActiveUsers(); // Update others
    }
  });

  //Client sends mouse/cursor position
  socket.on("mouseMove", data => {
    const user = activeUsers[socket.id];
    if (user && data && typeof data.x === 'number' && typeof data.y === 'number') {
      user.x = data.x; user.y = data.y; //Update position
      user.lastActive = Date.now();
      user.hasMoved = true; // Mark as active
      //Position is broadcasted via interval timer, not here directly
    }
  });

  //Client starts drawing
  socket.on("startDrawing", data => {
    const user = activeUsers[socket.id];
    if (user && data && typeof data.x === 'number' && typeof data.y === 'number') {
      user.drawing = true;
      user.x = data.x; user.y = data.y; //Update position
      user.lastActive = Date.now();
      user.hasMoved = true;

      // Add to active drawers Set to track drawing state
      activeDrawers.add(socket.id);

      // Broadcast immediately to show drawing status to all other clients
      broadcastActiveUsers();
    }
  });

  //Listener for individual drawing segments (for live preview)
  socket.on("draw", data => {
     // Basic validation of draw data
     if (data && typeof data.x0 === 'number' && typeof data.y0 === 'number' &&
        typeof data.x1 === 'number' && typeof data.y1 === 'number' &&
        typeof data.color === 'string' && typeof data.size === 'number') {

        // Just broadcast this segment to others for live preview
        socket.broadcast.emit("draw", {
          ...data,
          userId: socket.id // Add user ID to help clients track who's drawing
        });

        // Update sender's state (needed for cursor position)
        const user = activeUsers[socket.id];
        if (user) {
            user.x = data.x1; user.y = data.y1; // Update position to end of line
            user.lastActive = Date.now();
            user.hasMoved = true;
            // Make sure drawing state is still tracked
            if (!user.drawing) {
              user.drawing = true;
              activeDrawers.add(socket.id);
            }
        }
        // DO NOT add individual segments to the main drawHistory here
     } else {
         console.warn(`Invalid draw data from ${socket.id}:`, JSON.stringify(data));
     }
  });

  //Listener for completed strokes from client
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

          // Broadcast the newly added stroke to all clients
          // This allows clients to maintain their own consistent history
          io.emit("newStroke", completeStroke);

          pruneDrawHistory(); // Prune immediately after adding if needed
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

      // Remove from active drawers Set
      activeDrawers.delete(socket.id);

      broadcastActiveUsers(); // Broadcast status change
      //Client now sends stroke via "addStroke" and snapshot via "canvasSnapshot"
    }
  });

  //Client sends a canvas snapshot (usually after drawing or by request)
  socket.on("canvasSnapshot", dataURL => {
    if (typeof dataURL === 'string' && dataURL.startsWith("data:image/")) {
      lastCanvasDataURL = dataURL; // Update the authoritative snapshot
      lastCanvasUpdateTime = Date.now();
      //new users will get it on join
    } else {
        console.warn(`Invalid snapshot data from ${socket.id}`);
    }
  });

  // *** IMPROVED UNDO LOGIC ***
  socket.on("undo", () => {
      const userId = socket.id;
      let targetStroke = null;
      let userStrokesChecked = 0;

      // Iterate backwards through the *entire* history
      for (let i = drawHistory.length - 1; i >= 0; i--) {
          const stroke = drawHistory[i];
          // Check if the stroke belongs to the requesting user
          if (stroke && stroke.userId === userId) {
              userStrokesChecked++; // Count how many of *this user's* strokes we've seen

              // If this stroke is NOT already undone, it's our target
              if (!stroke.undone) {
                  targetStroke = stroke; // Found the most recent, non-undone stroke
                  break; // Stop searching, we found it
              }

              // If we've already checked the limit for this user, stop searching further back
              if (userStrokesChecked >= USER_UNDO_REDO_LIMIT) {
                  console.log(`Undo search for ${userId} stopped after checking ${USER_UNDO_REDO_LIMIT} strokes.`);
                  break;
              }
          }
      }

      // If we found a target stroke
      if (targetStroke) {
          targetStroke.undone = true; // Mark as undone
          console.log(`User ${userId} undid stroke ${targetStroke.id}`);
          // Emit the change for this specific stroke
          io.emit("strokeUndoStateChanged", { strokeId: targetStroke.id, undone: true });
      } else {
          console.log(`No active stroke found for user ${userId} within the last ${USER_UNDO_REDO_LIMIT} checked actions to undo.`);
      }
  });

  // *** IMPROVED REDO LOGIC ***
  socket.on("redo", () => {
      const userId = socket.id;
      let targetStroke = null;
      let userStrokesChecked = 0;

      // Iterate backwards through the *entire* history
      for (let i = drawHistory.length - 1; i >= 0; i--) {
          const stroke = drawHistory[i];
          // Check if the stroke belongs to the requesting user
          if (stroke && stroke.userId === userId) {
               userStrokesChecked++; // Count how many of *this user's* strokes we've seen

              // If this stroke IS undone, it's our target
              if (stroke.undone) {
                  targetStroke = stroke; // Found the most recent, undone stroke
                  break; // Stop searching, we found it
              }

              // If we've already checked the limit for this user, stop searching further back
              if (userStrokesChecked >= USER_UNDO_REDO_LIMIT) {
                   console.log(`Redo search for ${userId} stopped after checking ${USER_UNDO_REDO_LIMIT} strokes.`);
                  break;
              }
          }
      }

      // If we found a target stroke
      if (targetStroke) {
          targetStroke.undone = false; // Mark as not undone (redone)
          console.log(`User ${userId} redid stroke ${targetStroke.id}`);
          // Emit the change for this specific stroke
          io.emit("strokeUndoStateChanged", { strokeId: targetStroke.id, undone: false });
      } else {
           console.log(`No undone stroke found for user ${userId} within the last ${USER_UNDO_REDO_LIMIT} checked actions to redo.`);
      }
  });


  //Client sends a chat message
  socket.on("sendMessage", (messageData) => {
    const user = activeUsers[socket.id];
    //Validate user and message text
    if (user && messageData && typeof messageData.text === 'string') {
      const sanitizedText = messageData.text.trim().slice(0, 200); //Trim and limit length

      if (sanitizedText) { //Only process non-empty messages
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

  //Client disconnects
  socket.on("disconnect", (reason) => {
    const user = activeUsers[socket.id];
    const username = user ? user.username : 'Unknown';
    console.log(`User ${username} (${socket.id}) disconnected: ${reason}`);

    // Remove from active drawers Set
    activeDrawers.delete(socket.id);

    delete activeUsers[socket.id]; // Remove from active list
    broadcastActiveUsers(); // Notify others
  });

  //Handle socket errors
  socket.on("error", (error) => {
      console.error(`Socket error (${socket.id}):`, error);
  });
});

//Start the HTTP Server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  // Schedule the first canvas reset when server starts
  scheduleReset();
});
