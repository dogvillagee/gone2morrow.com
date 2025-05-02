//src/canvas.js
import { useEffect, useRef, useState, useCallback } from "react"; // Added useCallback
import { io } from "socket.io-client";
import Chatbox from "./chatbox";
import { v4 as uuidv4 } from 'uuid'; // Import UUID library


//updated for live server
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:4000";
const socket = io(BACKEND_URL, { autoConnect: false });

// Define client-side history limit (can be same or different from server)
// Keeping more locally might feel slightly smoother for rapid undo/redo,
// but could use more memory. Let's match server for simplicity now.
const MAX_DRAW_HISTORY_CLIENT = 10;

export default function Canvas() {
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const lastEmitTimeRef = useRef(0);
  const canvasDataRef = useRef(null); //store canvas data URL for state saving/restoration
  //State Variables
  const [tool, setTool] = useState("brush");
  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState(5);
  const [username, setUsername] = useState("");
  const [activeUsers, setActiveUsers] = useState({});
  const [cursorPos, setCursorPos] = useState({ x: -100, y: -100 });
  const [tempEraser, setTempEraser] = useState(false);
  //refs for Event handling
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const sizeRef = useRef(size);
  const usernameRef = useRef(username);
  const tempEraserRef = useRef(tempEraser);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { sizeRef.current = size; }, [size]);
  useEffect(() => { usernameRef.current = username; }, [username]);
  useEffect(() => { tempEraserRef.current = tempEraser; }, [tempEraser]);



  //FIXXED Refs for managing current stroke and history
  const drawHistoryRef = useRef([]); //Stores stroke history from server
  const currentStrokeIdRef = useRef(null); //Id of current
  const currentSegmentsRef = useRef([]); //for ordered undo/redo

  // State for connection status indicator
  const [isConnected, setIsConnected] = useState(socket.connected);

  //Username name generation / and name save state
  useEffect(() => {
    //Check if a username exists in localStorage
    let storedUsername = localStorage.getItem('canvasUsername');

    if (storedUsername) {
      //If found, use it
      setUsername(storedUsername);
      console.log("Retrieved username from localStorage:", storedUsername);
    } else {
      const id = Math.floor(Math.random() * 1000); //random anonymous(x) username between 1-1000
      const newUsername = `Anonymous${id}`;
      setUsername(newUsername);
      //Save the new username to localStorage
      localStorage.setItem('canvasUsername', newUsername);
      console.log("Generated and saved new username:", newUsername);
    }
    //eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  //redraw canvas from stroke history.
  const redrawCanvasFromHistory = useCallback(() => { // No longer needs history passed in
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const strokeHistory = drawHistoryRef.current; // Use the ref directly
    console.log(`Redrawing canvas from local ref with ${strokeHistory?.length ?? 0} strokes.`);

    //Clear the canvas completely
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#FFFFFF"; // Assuming white background
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!strokeHistory || strokeHistory.length === 0) {
        console.log("Local stroke history empty, canvas cleared.");
        //update local snapshot after clearing/redrawing
        try {
           canvasDataRef.current = canvas.toDataURL("image/png");
        } catch(e){ console.warn("Could not update snapshot after history clear"); }
        return; //Nothing more to draw
    }

    // Store original settings to restore after drawing
    const originalStrokeStyle = ctx.strokeStyle;
    const originalLineWidth = ctx.lineWidth;
    const originalLineCap = ctx.lineCap;
    const originalLineJoin = ctx.lineJoin;

    ctx.lineCap = "round"; // Ensure consistency
    ctx.lineJoin = "round";

    //Iterate through the strokes in the history
    strokeHistory.forEach(stroke => {
        // Check if the stroke object exists and is not marked as undone
        // Also check if segments is an array before iterating
        if (stroke && !stroke.undone && Array.isArray(stroke.segments)) {
            // Iterate through the segments within valid stroke
            stroke.segments.forEach(segment => {
                // Add check for segment validity
                if (segment && typeof segment.x0 === 'number' && typeof segment.y0 === 'number' &&
                    typeof segment.x1 === 'number' && typeof segment.y1 === 'number' &&
                    typeof segment.color === 'string' && typeof segment.size === 'number')
                {
                    ctx.beginPath();
                    ctx.moveTo(segment.x0 * canvas.width, segment.y0 * canvas.height);
                    ctx.lineTo(segment.x1 * canvas.width, segment.y1 * canvas.height);
                    ctx.strokeStyle = segment.color;
                    ctx.lineWidth = segment.size;
                    ctx.stroke();
                } else {
                   // console.warn("Skipping invalid segment during redraw:", segment); // Less verbose
                }
            });
        } else if (stroke && !stroke.undone && !Array.isArray(stroke.segments)) {
           // console.warn("Stroke missing segments during redraw:", stroke.id); // Less verbose
        }
    });

    //Restore original context settings
    ctx.strokeStyle = originalStrokeStyle;
    ctx.lineWidth = originalLineWidth;
    ctx.lineCap = originalLineCap;
    ctx.lineJoin = originalLineJoin;
    ctx.beginPath(); //reset path after drawing history

    //Update local snapshot after redrawing from history
    try {
       canvasDataRef.current = canvas.toDataURL("image/png");
       // console.log("Canvas redraw complete from history, snapshot updated."); // Less verbose
    } catch(e){ console.warn("Could not update snapshot after history redraw"); }
  }, []); // useCallback ensures function reference is stable


  //main Canvas and Socket setup effect
  useEffect(() => {
    if (!username) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // Ensure context is available

    const baseWidth = 1800;
    const baseHeight = 830;

    //Flag to indicate if initial state (snapshot or history) has been loaded
    let initialStateLoaded = false;

    const setupCanvas = () => {
      if (!canvasContainerRef.current || !canvas) return;
      const containerRect = canvasContainerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      const aspectRatio = baseHeight / baseWidth;
      const containerHeight = containerWidth * aspectRatio;

      //Check if dimensions changed significantly OR if canvas hasn't been initialized yet
      const needsResize = canvas.width !== baseWidth || canvas.height !== baseHeight;

      if (needsResize) {
        //Store current snapshot before resizing (if available) - Similar to original logic
        let previousDataUrl = null;
        if (canvas.width > 0 && canvas.height > 0) {
            try {
                //use the locally cached snapshot if available
                previousDataUrl = canvasDataRef.current || canvas.toDataURL("image/png");
            } catch (error) {
                console.warn("Could not cache canvas during resize setup:", error.message);
            }
        }

        //Set new internal dimensions
        canvas.width = baseWidth;
        canvas.height = baseHeight;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = sizeRef.current; //Use current size setting
        ctx.strokeStyle = colorRef.current; //Use current color setting

        //Restore previous image OR the last known snapshot from server/local cache
        const restoreUrl = previousDataUrl; //Prioritize the one just saved before resize
        if (restoreUrl) {
          const img = new Image();
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            console.log("Canvas restored from snapshot after resize.");
            //Update canvasDataRef just in case the restored one was from canvas.toDataURL
            canvasDataRef.current = restoreUrl;
          };
          img.onerror = () => { // Fallback if image fails to load
              console.warn("Failed to load snapshot on resize, clearing canvas.");
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.fillStyle = "#FFFFFF";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              canvasDataRef.current = null; // Clear ref if restore failed
          }
          img.src = restoreUrl;
        } else {
            //If no snapshot available, clear to white
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            console.log("No snapshot, cleared canvas after resize.");
            canvasDataRef.current = null; // Ensure ref is cleared
        }
      }

      //Apply CSS dimensions for scaling
      canvas.style.width = `${containerWidth}px`;
      canvas.style.height = `${containerHeight}px`;
    };

    //Initial setup call
    setupCanvas();

    let resizeTimeout = null;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(setupCanvas, 100); // Debounce resize
    };
    window.addEventListener("resize", handleResize);

    const getPos = (e) => {
      //(getPosition logic)
      if (!canvasRef.current) return { normX: 0, normY: 0, cssX: 0, cssY: 0 };
      const rect = canvasRef.current.getBoundingClientRect();
      let clientX, clientY;

      if (e.touches && e.touches.length > 0) {// Touch start/move
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if (e.changedTouches && e.changedTouches.length > 0) { // Touch end
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
      } else { //Mouse event
        clientX = e.clientX;
        clientY = e.clientY;
      }

      const cssX = clientX - rect.left; //Position relative to canvas element
      const cssY = clientY - rect.top;

      return {
        normX: cssX / rect.width, //Normalized X (0 to 1)
        normY: cssY / rect.height, //Normalized Y (0 to 1)
        cssX: cssX, //CSS pixel X for local UI (cursor preview)
        cssY: cssY  //CSS pixel Y
      };
    };

    const clipToBounds = (x, y) => ({
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y))
    });

    const handleCanvasClick = (e) => {
      //handleCanvasClick logic
      if (toolRef.current !== 'eyedropper' || !canvas || !ctx) return;
      const pos = getPos(e);
      const canvasX = Math.floor(pos.normX * canvas.width);
      const canvasY = Math.floor(pos.normY * canvas.height);
      try {
        const imageData = ctx.getImageData(canvasX, canvasY, 1, 1).data;
        const hexColor = `#${imageData[0].toString(16).padStart(2, '0')}${imageData[1].toString(16).padStart(2, '0')}${imageData[2].toString(16).padStart(2, '0')}`;
        setColor(hexColor); //Update color state
        setTool('brush'); //switch back to brush
      } catch (error) {
        console.error("Eyedropper failed:", error);
        setTool('brush'); //switch back even on error
      }
    };

    let drawing = false;
    let lastNormX = 0, lastNormY = 0;
    let isRightClick = false;

    //mod startDrawing
    const startDrawing = (e) => {
      if (e.touches) e.preventDefault();
      if (!canvas || !ctx) return;
      if (toolRef.current === 'eyedropper') { handleCanvasClick(e); return; }

      isRightClick = (e.button === 2);
      const isErasing = toolRef.current === "eraser" || (isRightClick && toolRef.current === "brush");
      if (isErasing && !tempEraserRef.current && isRightClick && toolRef.current === "brush") { setTempEraser(true); }

      drawing = true; // Set local drawing flag immediately
      const pos = getPos(e);
      const bounded = clipToBounds(pos.normX, pos.normY);
      lastNormX = bounded.x;
      lastNormY = bounded.y;

      // Start tracking a new stroke
      currentStrokeIdRef.current = uuidv4(); // Generate unique ID for stroke
      currentSegmentsRef.current = []; // Reset segments for the new stroke

      //Apply style locally for immediate feedback
      ctx.strokeStyle = isErasing ? "#ffffff" : colorRef.current;
      ctx.lineWidth = sizeRef.current;
      ctx.beginPath();
      ctx.moveTo(lastNormX * canvas.width, lastNormY * canvas.height);

      if (socket.connected) {
        socket.emit("setUsername", usernameRef.current);
        // Emit startDrawing for cursor update, but not the stroke data yet
        socket.emit("startDrawing", { x: lastNormX, y: lastNormY, username: usernameRef.current });
      }
    };

    //mod draw
    const draw = (e) => {
      if (e.touches) e.preventDefault();
      if (!canvas || !ctx) return;
      const pos = getPos(e);
      setCursorPos({ x: pos.cssX, y: pos.cssY }); // Update local cursor position

      if (!drawing) { // If not drawing, just update cursor position for others
        const now = Date.now();
        if (now - lastEmitTimeRef.current > 30) { // Throttle emit
          const bounded = clipToBounds(pos.normX, pos.normY);
          if (socket.connected) { socket.emit("mouseMove", { x: bounded.x, y: bounded.y, username: usernameRef.current }); }
          lastEmitTimeRef.current = now;
        }
        return;
      }

      // If drawing:
      const isErasing = toolRef.current === "eraser" || tempEraserRef.current;
      const currentDrawColor = isErasing ? "#ffffff" : colorRef.current;
      const currentDrawSize = sizeRef.current;

      // Apply style locally
      ctx.strokeStyle = currentDrawColor; ctx.lineWidth = currentDrawSize;
      const bounded = clipToBounds(pos.normX, pos.normY);

      // Draw line segment locally
      ctx.lineTo(bounded.x * canvas.width, bounded.y * canvas.height); ctx.stroke();
      ctx.beginPath(); // Start new path for the next segment
      ctx.moveTo(bounded.x * canvas.width, bounded.y * canvas.height);

      // Create the segment data
      const segment = {
          x0: lastNormX, y0: lastNormY, x1: bounded.x, y1: bounded.y,
          color: currentDrawColor, size: currentDrawSize,
      };

      //Add segment to the current stroke being tracked locally
      currentSegmentsRef.current.push(segment);

      //Emit individual 'draw' segments for live preview
      if (socket.connected) {
          socket.emit("draw", segment); // Use original 'draw' event for live preview
      }

      // Update last position for the next segment
      lastNormX = bounded.x; lastNormY = bounded.y;
    };

    //mod: stopDrawing
    const stopDrawing = () => {
      if (!drawing || !canvas || !ctx) return; 
      drawing = false; // Set local drawing flag immediately
      if (tempEraserRef.current) { setTempEraser(false); }
      isRightClick = false;

      if (socket.connected) {
        // Emit stopDrawing for cursor update
        socket.emit("stopDrawing", { username: usernameRef.current });


        if (currentStrokeIdRef.current && currentSegmentsRef.current.length > 0) {
            socket.emit("addStroke", {
                id: currentStrokeIdRef.current,
                segments: currentSegmentsRef.current
            });
            console.log(`Sent stroke ${currentStrokeIdRef.current} with ${currentSegmentsRef.current.length} segments`); //then send the completed stroke to the server
        }


        currentStrokeIdRef.current = null; //reset current stroke tracking
        currentSegmentsRef.current = [];

        //Send snapshot to server after drawing stops
        // Send snapshot slightly delayed to allow server to process the stroke first? Optional.
        setTimeout(() => {
            if (!canvas) return; //Check if canvas still exists
            try {
                const snapshotDataUrl = canvas.toDataURL("image/webp", 0.8); //Using webp for smaller size
                canvasDataRef.current = canvas.toDataURL("image/png"); // Update local png cache too
                socket.emit("canvasSnapshot", snapshotDataUrl); // Send snapshot
            } catch (error) {
                console.warn("Could not get/send snapshot on stopDrawing:", error.message);
            }
        }, 50); //delay 50ms

      }

      ctx.beginPath(); //reset the drawing path
      setCursorPos({ x: -100, y: -100 }); //Hide local cursor preview
    };


    //event listeners for canvas interactions
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("mousedown", startDrawing);
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", stopDrawing);
    canvas.addEventListener("mouseleave", stopDrawing);
    canvas.addEventListener("touchstart", startDrawing, { passive: false });
    canvas.addEventListener("touchmove", draw, { passive: false });
    canvas.addEventListener("touchend", stopDrawing);
    canvas.addEventListener("touchcancel", stopDrawing);


    //Socket.IO Event Handlers, connect, disconnect, and error handling
    socket.on("connect", () => {
        console.log("Socket connected:", socket.id);
        setIsConnected(true); // Use state setter
        if (usernameRef.current) {
            socket.emit("setUsername", usernameRef.current);
            // Request initial state again on reconnect if needed? Or rely on history sync.
            // Maybe request history explicitly here?
            // socket.emit("requestInitialState"); // Example - server would need handler
        }
    });
    socket.on("disconnect", (reason) => {
        console.log("Socket disconnected:", reason);
        setIsConnected(false); // Use state setter
        setActiveUsers({}); // Clear other users on disconnect
    });
    socket.on("connect_error", (err) => console.error("Socket connection error:", err));


    //Handle receiving initial stroke history
    socket.on("initialHistory", (history) => {
      if (!canvas || !ctx) return;
      console.log(`Received initial history with ${history?.length ?? 0} strokes.`);
      drawHistoryRef.current = history || []; // Store stroke history
      // If no snapshot was received previously, redraw from history
      if (!initialStateLoaded) {
          console.log("No snapshot received, redrawing from initial history.");
          redrawCanvasFromHistory(); // Use the ref now
          initialStateLoaded = true;
      }
    });

    //Handle receiving redraw command (after undo/redo) - REMOVED, replaced by strokeUndoStateChanged

    // Handle receiving a full canvas state update (snapshot)
    socket.on("canvasState", (dataURL) => {
      if (!canvas || !ctx) return;
       // Only apply snapshot if initial history hasn't been processed OR if snapshot is newer
       //prevents snapshot overriding history redraws from undo/redo
       if (!initialStateLoaded /* || snapshotIsNewer logic needed */ ) {
            console.log("Received canvas state snapshot for initial load");
            initialStateLoaded = true;
            const img = new Image();
            img.onload = () => {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvasDataRef.current = dataURL;
                console.log("Canvas updated from snapshot.");
            };
            img.onerror = (err) => { console.error("Failed to load canvas state image:", err); }
            img.src = dataURL;
       } else {
           console.log("Skipping snapshot application, history already processed.");
       }
    });


    //Listener for individual 'draw' segments (live preview) from OTHER users
    socket.on("draw", (segmentData) => {
        // Ensure segmentData and its properties exist
        if (!segmentData || typeof segmentData.x0 !== 'number' || typeof segmentData.y0 !== 'number' ||
            typeof segmentData.x1 !== 'number' || typeof segmentData.y1 !== 'number' ||
            typeof segmentData.color !== 'string' || typeof segmentData.size !== 'number') {
            console.warn("Received invalid segment data:", segmentData);
            return;
        }

        // Check if canvas and context are ready
        if (!canvas || !ctx) return;


        const { x0, y0, x1, y1, color, size } = segmentData;

        // Save current context settings to avoid interference with local drawing
        const originalStrokeStyle = ctx.strokeStyle;
        const originalLineWidth = ctx.lineWidth;
        const originalLineCap = ctx.lineCap;
        const originalLineJoin = ctx.lineJoin;

        // Apply styles for the received segment
        ctx.beginPath();
        ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
        ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
        ctx.strokeStyle = color;
        ctx.lineWidth = size;
        ctx.lineCap = "round"; // Ensure consistency
        ctx.lineJoin = "round";
        ctx.stroke();

        // Restore previous context settings immediately
        ctx.strokeStyle = originalStrokeStyle;
        ctx.lineWidth = originalLineWidth;
        ctx.lineCap = originalLineCap;
        ctx.lineJoin = originalLineJoin;
        ctx.beginPath(); // Reset path to avoid affecting subsequent local drawing
    });


    //Listener for completed strokes from others for history draw updating
    socket.on("newStroke", (newStroke) => {
        if (newStroke && newStroke.id) {
            // Avoid adding duplicate if client already added optimistically (optional)
            // For simplicity now, just add and prune
            // Check if stroke already exists to avoid duplicates
            if (!drawHistoryRef.current.some(s => s && s.id === newStroke.id)) {
                drawHistoryRef.current.push(newStroke);
                // Prune local history if it exceeds the client limit
                if (drawHistoryRef.current.length > MAX_DRAW_HISTORY_CLIENT) {
                     const removedCount = drawHistoryRef.current.length - MAX_DRAW_HISTORY_CLIENT;
                     drawHistoryRef.current = drawHistoryRef.current.slice(removedCount);
                }
                //console.log(`Added stroke ${newStroke.id} to local history`); // Less verbose
            }
        } else {
            console.warn("Received invalid new stroke data:", newStroke);
        }

    });

    // Listener for undo/redo state changes from server
    socket.on("strokeUndoStateChanged", ({ strokeId, undone }) => {
        if (!strokeId) return;
        console.log(`Received undo state change for stroke ${strokeId}: ${undone}`);
        // Find the stroke in the local history
        const strokeIndex = drawHistoryRef.current.findIndex(s => s && s.id === strokeId);
        if (strokeIndex !== -1) {
            // Update the undone status
            drawHistoryRef.current[strokeIndex].undone = undone;
            // Trigger a full redraw based on the updated local history
            redrawCanvasFromHistory();
        } else {
            console.warn(`Stroke ${strokeId} not found in local history for undo/redo update.`);
            // Maybe request full history sync here if state seems inconsistent?
        }
    });


    //Handle canvas clear event from server
    socket.on("clear", () => {
      if (!canvas || !ctx) return;
      console.log("Received clear event");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvasDataRef.current = null; //Clear local snapshot
      drawHistoryRef.current = []; //Clear local history (of strokes)
      initialStateLoaded = true; //mark state as loaded (empty)
      //Resetting local undo stack
    });

    // ... (userMouseMove, requestCanvasSnapshot remain the same)
    socket.on("userMouseMove", (users) => {
      const otherUsers = { ...users };
      if (socket.id && otherUsers[socket.id]) {
        delete otherUsers[socket.id]; // Exclude self
      }
      const boundedUsers = {};
      Object.entries(otherUsers).forEach(([id, data]) => {
        if (data && typeof data.x === 'number' && typeof data.y === 'number') {
             const bounded = clipToBounds(data.x, data.y);
             // Use the drawing status directly from the server update
             boundedUsers[id] = { ...data, x: bounded.x, y: bounded.y };
        }
      });
      setActiveUsers(boundedUsers); // Update state for cursor rendering
    });
    socket.on("requestCanvasSnapshot", () => {
      if (!canvas || !socket.connected) return;
      console.log("Server requested canvas snapshot");
      try {
        
        const snapshotDataUrl = canvas.toDataURL("image/png", 0.9); // Slightly compressed PNG
        socket.emit("canvasSnapshot", snapshotDataUrl);
      } catch (error) {
        console.warn("Could not send requested snapshot:", error.message);
      }
    });

    //Connect Socket
    socket.connect();

    //Periodic Backup (Optional) - Removed as snapshots are sent on stopDrawing
    // const intervalId = setInterval(() => { ... }, 60000);

    //Cleanup
    return () => {
      console.log("Cleaning up canvas effect");
      socket.disconnect();
      // clearInterval(intervalId); // Removed backup interval
      window.removeEventListener("resize", handleResize);
      if (canvas) {
        // Remove specific listeners added to canvas
        // Note: Need named func for removal if using preventDefault directly
        canvas.removeEventListener("contextmenu", e => e.preventDefault()); // might not remove correctly
        canvas.removeEventListener("mousedown", startDrawing);
        canvas.removeEventListener("mousemove", draw);
        canvas.removeEventListener("mouseup", stopDrawing);
        canvas.removeEventListener("mouseleave", stopDrawing);
        canvas.removeEventListener("touchstart", startDrawing);
        canvas.removeEventListener("touchmove", draw);
        canvas.removeEventListener("touchend", stopDrawing);
        canvas.removeEventListener("touchcancel", stopDrawing);
      }
      // Turn off all socket listeners specific to component instance
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("initialHistory");
      socket.off("redrawCanvas");   // Ensure off (though it's replaced)
      socket.off("canvasState");
      socket.off("newStroke");      // Cleanup new listener
      socket.off("strokeUndoStateChanged"); // Cleanup new listener
      socket.off("draw");
      socket.off("clear");
      socket.off("userMouseMove");
      socket.off("requestCanvasSnapshot");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, redrawCanvasFromHistory]); // Added redrawCanvasFromHistory dependency


  //mod Undo/redo handling effect (emits events to server)
  useEffect(() => {
    let isUndoRedoKeyDown = false; // Flag to track if Ctrl+Z/Y is already down

    const handleKeyDown = (e) => {
      const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey;
      const isRedo = (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"));

      // Check if the event target is the body or the canvas container to avoid interfering with text inputs
      const targetIsBodyOrCanvas = document.body === e.target || canvasContainerRef.current?.contains(e.target);

      if (targetIsBodyOrCanvas && (isUndo || isRedo) && !isUndoRedoKeyDown) {
        e.preventDefault(); // Prevent browser default
        isUndoRedoKeyDown = true; // Set flag

        if (socket.connected) {
          if (isUndo) {
            console.log("Sending undo event to server (single press)");
            socket.emit("undo"); // Emit undo request
          } else if (isRedo) {
            console.log("Sending redo event to server (single press)");
            socket.emit("redo"); // Emit redo request
          }
        }
      }
    };

     const handleKeyUp = (e) => {
      // Reset flag when Ctrl, Meta, Z, or Y key is released
      if (['Control', 'Meta', 'z', 'Z', 'y', 'Y'].includes(e.key)) {
          isUndoRedoKeyDown = false;
      }
    };

    // Add the event listeners to the window
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    // Cleanup function to remove the event listeners when the component unmounts
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []); // Empty dependency array means effect runs once on mount

  //Effect to emit username when it changes
  useEffect(() => { if (username && socket.connected) { socket.emit("setUsername", username); } }, [username]);

  // Determine cursor style
  const isErasingMode = tool === "eraser" || tempEraser;
  const canvasCursor = tool === 'eyedropper' ? 'crosshair' : (isErasingMode ? 'grab' : 'default');


  return (
    <>
      {/* Connection Status Indicator (Optional) */}
      {!isConnected && (
          <div style={{ color: 'red', textAlign: 'center', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              ⚠️ Disconnected from server. Trying to reconnect...
          </div>
      )}

      {/* Toolbar */}
      <div className="toolbar">
        {}
        <button onClick={() => setTool("brush")} className={tool === "brush" ? "active" : ""} title="Brush Tool (Right-click to erase)">BRUSH</button>
        <button onClick={() => setTool("eraser")} className={tool === "eraser" ? "active" : ""} title="Eraser Tool">ERASE</button>
        <label htmlFor="size-slider">Size:
          <input id="size-slider" type="range" min={1} max={20} value={size} onChange={e => setSize(Number(e.target.value))} />
          <span>{size}px</span>
        </label>
        <label htmlFor="color-picker">Color:
          <input id="color-picker" type="color" value={color} onChange={e => setColor(e.target.value)} disabled={isErasingMode || tool === 'eyedropper'} />
        </label>
        <button onClick={() => setTool("eyedropper")} className={tool === "eyedropper" ? "active" : ""} title="Color Picker Tool">COLOR MATCH</button>
      </div>

      {/*canvas Area*/}
      <div className="canvas-container" ref={canvasContainerRef}>
        <canvas ref={canvasRef} style={{ cursor: canvasCursor }} />

        {/*Eraser Preview Circle*/}
        {isErasingMode && cursorPos.x > -100 && (
          <div
            className="eraser-preview"
            style={{
              position: "absolute", left: `${cursorPos.x}px`, top: `${cursorPos.y}px`,
              width: `${size}px`, height: `${size}px`, border: "1px dashed grey",
              borderRadius: "50%", transform: 'translate(-50%, -50%)', pointerEvents: "none", zIndex: 10
            }}
            aria-hidden="true"
          />
        )}

        {/*Other Users Cursors Overlay*/}
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5 }}>
          {/*cursor rendering updated to use server drawing status*/}
           {canvasContainerRef.current && Object.entries(activeUsers).map(([id, data]) => (
            <div key={id} style={{
              position: "absolute",
              left: `${data.x * canvasContainerRef.current.clientWidth}px`,
              top: `${data.y * canvasContainerRef.current.clientHeight}px`,
              transition: "left 0.05s linear, top 0.05s linear",
              transform: 'translateY(-100%)'
            }}>
              {/* Use data.drawing directly from the server state */}
              <div className="cursor-pointer" style={{ color: data.drawing ? 'black' : 'gray' }}>▼</div>
              <div className="username-tag" style={{ backgroundColor: 'rgba(0,0,0,0.5)', color: 'white', padding: '2px 4px', borderRadius: '3px', fontSize: '0.8em', whiteSpace: 'nowrap' }}>
                  {data.username || 'Anonymous'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/*chatbox*/}
      {/* Pass isConnected state to Chatbox */}
      {socket && username && (
          <Chatbox socket={socket} username={username} />
      )}
    </>
  );
}
