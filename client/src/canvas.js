// src/canvas.js
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import Chatbox from "./chatbox";

//Create socket but don't auto-connect initially
const socket = io("http://localhost:4000", { autoConnect: false });

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

  const undoStackRef = useRef([]); //undo stack
  const redoStackRef = useRef([]); //redo stack

  //Username name generation / and name save state
  useEffect(() => {
    //Check if a username exists in localStorage
    let storedUsername = localStorage.getItem('canvasUsername');

    if (storedUsername) {
      //If found, use it
      setUsername(storedUsername);
      console.log("Retrieved username from localStorage:", storedUsername);
    } else {
      //If not found, generate a new one
      const id = Math.floor(Math.random() * 1000);
      const newUsername = `Anonymous${id}`;
      setUsername(newUsername);
      //Save the new username to localStorage
      localStorage.setItem('canvasUsername', newUsername);
      console.log("Generated and saved new username:", newUsername);
    }
    //eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  //main Canvas and Socket setup effect
  useEffect(() => {
    if (!username) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const baseWidth = 1800;
    const baseHeight = 830;

    const setupCanvas = () => {
      if (!canvasContainerRef.current || !canvas) return;
      const containerRect = canvasContainerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      const aspectRatio = baseHeight / baseWidth;
      const containerHeight = containerWidth * aspectRatio;

      if (canvas.width !== baseWidth || canvas.height !== baseHeight) {
        if (canvas.width > 0 && canvas.height > 0 && ctx) {
          try {
            canvasDataRef.current = canvas.toDataURL("image/png");
          } catch (error) {
            console.warn("Could not cache canvas during setup:", error.message);
          }
        }
        canvas.width = baseWidth;
        canvas.height = baseHeight;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = sizeRef.current;
        ctx.strokeStyle = colorRef.current;

        if (canvasDataRef.current) {
          const img = new Image();
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            //Initialize undo stack after restoring initial image
            try {
                undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
                redoStackRef.current = [];
            } catch(e) { console.error("Error init undo stack on restore:", e); undoStackRef.current = []; }
          };
          img.src = canvasDataRef.current;
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            //Initialize undo stack with blank state
             try {
                undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
                redoStackRef.current = [];
            } catch(e) { console.error("Error init undo stack on blank:", e); undoStackRef.current = []; }
        }
      }
      canvas.style.width = `${containerWidth}px`;
      canvas.style.height = `${containerHeight}px`;
    };

    setupCanvas();

    let resizeTimeout = null;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(setupCanvas, 100);
    };
    window.addEventListener("resize", handleResize);

    const getPos = (e) => {
      //(getPos logic)
      if (!canvasRef.current) return { normX: 0, normY: 0, cssX: 0, cssY: 0 };
      const rect = canvasRef.current.getBoundingClientRect();
      let clientX, clientY;

      if (e.touches && e.touches.length > 0) {// Touch start/move
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if (e.changedTouches && e.changedTouches.length > 0) { // Touch end
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
      } else { // Mouse event
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

    const startDrawing = (e) => {
      if (e.touches) e.preventDefault();
      if (!canvas || !ctx) return;

      if (toolRef.current === 'eyedropper') {
        handleCanvasClick(e);
        return;
      }

      isRightClick = (e.button === 2);
      const isErasing = toolRef.current === "eraser" || (isRightClick && toolRef.current === "brush");

      if (isErasing && !tempEraserRef.current && isRightClick && toolRef.current === "brush") {
        setTempEraser(true);
      }

      drawing = true;
      const pos = getPos(e);
      const bounded = clipToBounds(pos.normX, pos.normY);
      lastNormX = bounded.x;
      lastNormY = bounded.y;

      ctx.strokeStyle = isErasing ? "#ffffff" : colorRef.current;
      ctx.lineWidth = sizeRef.current;

      ctx.beginPath();
      ctx.moveTo(lastNormX * canvas.width, lastNormY * canvas.height);

      if (socket.connected) {
        socket.emit("setUsername", usernameRef.current);
        socket.emit("startDrawing", { x: lastNormX, y: lastNormY, username: usernameRef.current });
      }
    };

    const draw = (e) => {
      // ... (draw logic remains largely the same)
      if (e.touches) e.preventDefault();
      if (!canvas || !ctx) return;

      const pos = getPos(e);
      setCursorPos({ x: pos.cssX, y: pos.cssY }); // Update local cursor position

      if (!drawing) {
        const now = Date.now();
        if (now - lastEmitTimeRef.current > 30) { // Throttle emit
          const bounded = clipToBounds(pos.normX, pos.normY);
          if (socket.connected) {
            socket.emit("mouseMove", { x: bounded.x, y: bounded.y, username: usernameRef.current });
          }
          lastEmitTimeRef.current = now;
        }
        return;
      }

      const isErasing = toolRef.current === "eraser" || tempEraserRef.current;
      ctx.strokeStyle = isErasing ? "#ffffff" : colorRef.current;
      ctx.lineWidth = sizeRef.current;

      const bounded = clipToBounds(pos.normX, pos.normY);

      ctx.lineTo(bounded.x * canvas.width, bounded.y * canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bounded.x * canvas.width, bounded.y * canvas.height);

      if (socket.connected) {
        socket.emit("draw", {
          x0: lastNormX, y0: lastNormY,
          x1: bounded.x, y1: bounded.y,
          color: isErasing ? "#ffffff" : colorRef.current,
          size: sizeRef.current,
          username: usernameRef.current,
        });
      }
      lastNormX = bounded.x;
      lastNormY = bounded.y;
    };

    const stopDrawing = () => {
      if (!drawing || !canvas || !ctx) return;
      drawing = false;

      if (tempEraserRef.current) {
        setTempEraser(false);
      }
      isRightClick = false;

      if (socket.connected) {
        socket.emit("stopDrawing", { username: usernameRef.current });

        try {
          //tet snapshot *after* drawing completes
          const snapshotDataUrl = canvas.toDataURL("image/webp", 0.8);
          canvasDataRef.current = canvas.toDataURL("image/png"); // Update local png cache too

      
          //pushing the state AFTER the drawing action is complete
          undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
          redoStackRef.current = []; // Clear redo stack on new action

          // Send snapshot to server
          socket.emit("canvasSnapshot", snapshotDataUrl);

        } catch (error) {
          console.warn("Could not get/send snapshot or save undo state on stopDrawing:", error.message);
        }
      }

      ctx.beginPath();
      setCursorPos({ x: -100, y: -100 });
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
        if (usernameRef.current) {
            socket.emit("setUsername", usernameRef.current);
        }
    });
    socket.on("disconnect", (reason) => console.log("Socket disconnected:", reason)); 
    socket.on("connect_error", (err) => console.error("Socket connection error:", err)); 


    //Handle receiving initial drawing history
    socket.on("initialCanvas", (history) => {
      if (!canvas || !ctx) return;
      console.log("Received initial draw history");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      history.forEach(({ x0, y0, x1, y1, color, size }) => {
        ctx.beginPath();
        ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
        ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
        ctx.strokeStyle = color;
        ctx.lineWidth = size;
        ctx.stroke();
      });

      //Save initial state for undo
      try {
        canvasDataRef.current = canvas.toDataURL("image/png");
        
        undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)]; //undo stack starts with this initial state
        redoStackRef.current = [];
        console.log("Initialized undo stack from initialCanvas");
      } catch (error) {
        console.error("Could not save initial undo state from history:", error);
        undoStackRef.current = [];
      }
    });

    //receiving a drawing segment from another user
    socket.on("draw", ({ x0, y0, x1, y1, color, size }) => {
      // ... (draw logic remains the same)
      if (!canvas || !ctx) return;
      const originalStrokeStyle = ctx.strokeStyle;
      const originalLineWidth = ctx.lineWidth;
      ctx.beginPath();
      ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
      ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.stroke();
      ctx.strokeStyle = originalStrokeStyle;
      ctx.lineWidth = originalLineWidth;
      ctx.beginPath();
    });

    //Handle canvas clear event from server
    socket.on("clear", () => {
      if (!canvas || !ctx) return;
      console.log("Received clear event");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvasDataRef.current = null;
      //Reset stacks and add cleared state
      try {
        undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
        redoStackRef.current = [];
         console.log("Initialized undo stack after clear");
      } catch (error) {
        console.error("Could not save undo state:", error);
         undoStackRef.current = [];
      }
    });

    //Handle receiving a full canvas state update (snapshot)
    socket.on("canvasState", (dataURL) => {
      if (!canvas || !ctx) return;
      console.log("Received canvas state snapshot");
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        //Reset local state based on snapshot
        try {
          canvasDataRef.current = dataURL;
           // *** Initialize undo stack with this snapshot state ***
          undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
          redoStackRef.current = [];
          console.log("Initialized undo stack from canvasState");
        } catch (error) {
          console.error("Could not save undo state after receiving snapshot:", error);
          undoStackRef.current = [];
        }
      };
      img.onerror = (err) => console.error("Failed to load canvas state image:", err);
      img.src = dataURL;
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
             boundedUsers[id] = { ...data, x: bounded.x, y: bounded.y };
        }
      });
      setActiveUsers(boundedUsers);
    });
    socket.on("requestCanvasSnapshot", () => {
      if (!canvas || !socket.connected) return;
      console.log("Server requested canvas snapshot");
      try {
        socket.emit("canvasSnapshot", canvas.toDataURL("image/webp", 0.8));
      } catch (error) {
        console.warn("Could not send requested snapshot:", error.message);
      }
    });

    //Connect Socket
    socket.connect();

    //Periodic Backup (Optional)
    //(backup interval remains the same)
    const intervalId = setInterval(() => {
      if (socket.connected && canvas && !drawing) {
        try {
          canvasDataRef.current = canvas.toDataURL("image/png");
        } catch (error) { }
      }
    }, 60000);

    //Cleanup
    return () => {
      console.log("Cleaning up canvas effect");
      socket.disconnect();
      clearInterval(intervalId);
      window.removeEventListener("resize", handleResize);
      if (canvas) {
        canvas.removeEventListener("contextmenu", e => e.preventDefault());
        canvas.removeEventListener("mousedown", startDrawing);
        canvas.removeEventListener("mousemove", draw);
        canvas.removeEventListener("mouseup", stopDrawing);
        canvas.removeEventListener("mouseleave", stopDrawing);
        canvas.removeEventListener("touchstart", startDrawing);
        canvas.removeEventListener("touchmove", draw);
        canvas.removeEventListener("touchend", stopDrawing);
        canvas.removeEventListener("touchcancel", stopDrawing);
      }
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("initialCanvas");
      socket.off("draw");
      socket.off("clear");
      socket.off("canvasState");
      socket.off("userMouseMove");
      socket.off("requestCanvasSnapshot");
    };
  }, [username]);


  //Undo and redo handling effect
  //state saving after stopDrawing ***
  useEffect(() => {
    const handler = (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Undo: Ctrl+Z or Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (undoStackRef.current.length > 1) {
          let currentState = null;
          try {
            currentState = undoStackRef.current.pop();
            redoStackRef.current.push(currentState);
            const previousState = undoStackRef.current[undoStackRef.current.length - 1];
            ctx.putImageData(previousState, 0, 0);
            canvasDataRef.current = canvas.toDataURL("image/png");
            if (socket.connected) {
              //Send the *restored* state
              socket.emit("canvasState", canvas.toDataURL("image/webp", 0.8));
            }
          } catch (error) {
            console.error("Undo failed:", error);
            if (currentState && redoStackRef.current[redoStackRef.current.length - 1] === currentState) {
                redoStackRef.current.pop();
            }
            if (currentState) {
                undoStackRef.current.push(currentState);
            }
          }
        } else {
            console.log("Undo stack empty or only contains initial state.");
        }
      }
      //Redo: Ctrl+Y or Cmd+Shift+Z
      else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "Z"))) {
        e.preventDefault();
        const nextState = redoStackRef.current.pop();
        if (nextState) {
          try {
            undoStackRef.current.push(nextState);
            ctx.putImageData(nextState, 0, 0);
            canvasDataRef.current = canvas.toDataURL("image/png");
            if (socket.connected) {
               //Send the restored state  (redo)
              socket.emit("canvasState", canvas.toDataURL("image/webp", 0.8));
            }
          } catch (error) {
            console.error("Redo failed:", error);
            redoStackRef.current.push(nextState);
            if (undoStackRef.current[undoStackRef.current.length - 1] === nextState) {
                undoStackRef.current.pop();
            }
          }
        } else {
             console.log("Redo stack empty.");
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  //Effect to emit username when it changes
  useEffect(() => {
    if (username && socket.connected) {
      socket.emit("setUsername", username);
    }
  }, [username]);

  // Determine cursor style
  const isErasingMode = tool === "eraser" || tempEraser;
  const canvasCursor = tool === 'eyedropper' ? 'crosshair' : (isErasingMode ? 'grab' : 'default');

 
  return (
    <>
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
          {/*cursor rendering remains the same*/}
           {canvasContainerRef.current && Object.entries(activeUsers).map(([id, data]) => (
            <div key={id} style={{
              position: "absolute",
              left: `${data.x * canvasContainerRef.current.clientWidth}px`,
              top: `${data.y * canvasContainerRef.current.clientHeight}px`,
              transition: "left 0.05s linear, top 0.05s linear",
              transform: 'translateY(-100%)'
            }}>
              <div className="cursor-pointer" style={{ color: data.drawing ? 'black' : 'gray' }}>▼</div>
              <div className="username-tag" style={{ backgroundColor: 'rgba(0,0,0,0.5)', color: 'white', padding: '2px 4px', borderRadius: '3px', fontSize: '0.8em', whiteSpace: 'nowrap' }}>
                  {data.username || 'Anonymous'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/*chatbox*/}
      {socket && username && (
          <Chatbox socket={socket} username={username} />
      )}
    </>
  );
}
