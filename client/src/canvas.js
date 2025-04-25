import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

//Create socket but don't auto-connect
const socket = io("http://localhost:4000", { autoConnect: false });

export default function Canvas() {
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);

  //tools & user state
  const [tool, setTool] = useState("brush");
  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState(2);
  const [username, setUsername] = useState("");
  const [activeUsers, setActiveUsers] = useState({});
  const [cursorPos, setCursorPos] = useState({ x: -100, y: -100 });

  // New state for tracking temporary eraser mode (for right click)
  const [tempEraser, setTempEraser] = useState(false);

  //keep latest props in refs
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

  //undo/redo stacks
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);

  //generate a random username once
  useEffect(() => {
    if (!username) {
      const id = Math.floor(Math.random() * 1000) + 1;
      setUsername(`Anonymous${id}`);
    }
  }, [username]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const canvasWidth = 1800;
    const canvasHeight = 830;
    
    //1) Setup DPI-correct canvas
    const setupCanvas = () => {
      const containerRect = canvasContainerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      
      //Set display size (CSS pixels)
      canvas.style.width = `${containerWidth}px`;
      canvas.style.height = `${canvasHeight * (containerWidth / canvasWidth)}px`;
      
      //Set actual size in memory (scaled for DPI)
      const scale = window.devicePixelRatio || 1;
      canvas.width = containerWidth * scale;
      canvas.height = (canvasHeight * (containerWidth / canvasWidth)) * scale;
      
      //Scale the context to ensure correct drawing operations
      ctx.scale(scale, scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    };
    
    setupCanvas();
    
    const handleResize = () => {
      //Temporarily store the canvas content
      let tempCanvas = document.createElement('canvas');
      let tempCtx = tempCanvas.getContext('2d');
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      tempCtx.drawImage(canvas, 0, 0);
      
      //Resize and reset the canvas
      setupCanvas();
      
      //Draw back the content scaled to the new size
      ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, 
                    0, 0, canvas.width / (window.devicePixelRatio || 1), 
                    canvas.height / (window.devicePixelRatio || 1));
    };
    
    window.addEventListener("resize", handleResize);

    //Get position in normalized coordinates
    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      
      //Return both normalized (0-1) and actual CSS pixel coordinates
      return { 
        normX: cssX / rect.width,
        normY: cssY / rect.height,
        cssX: cssX,
        cssY: cssY
      };
    };

    let drawing = false;
    let lastNormX = 0, lastNormY = 0;
    let isRightClick = false;

    const startDrawing = (e) => {
      // Set right-click flag
      isRightClick = (e.button === 2);
      
      // Handle tool behavior
      // 1. If currently using eraser tool - always erase
      // 2. If using brush with right-click - temporarily erase
      // 3. If using brush with left-click - draw
      
      if (toolRef.current === "eraser" || isRightClick) {
        // Set the temporary eraser state if right-clicking while in brush mode
        if (isRightClick && toolRef.current === "brush") {
          setTempEraser(true);
        }
      }

      //snapshot for undo
      undoStackRef.current.push(
        ctx.getImageData(0, 0, canvas.width, canvas.height)
      );
      redoStackRef.current = [];

      drawing = true;
      const pos = getPos(e);
      lastNormX = pos.normX;
      lastNormY = pos.normY;
      
      ctx.beginPath();
      ctx.moveTo(pos.cssX, pos.cssY);
      socket.emit("setUsername", usernameRef.current);
      socket.emit("startDrawing", { 
        x: pos.normX, 
        y: pos.normY, 
        username: usernameRef.current 
      });
    };

    const draw = (e) => {
      //update cursor for preview
      const pos = getPos(e);
      setCursorPos({ x: pos.cssX, y: pos.cssY });

      if (!drawing) {
        socket.emit("mouseMove", { 
          x: pos.normX, 
          y: pos.normY, 
          username: usernameRef.current 
        });
        return;
      }

      //Draw locally
      ctx.lineTo(pos.cssX, pos.cssY);
      
      // Decide if we're in erasing mode
      const isErasing = toolRef.current === "eraser" || tempEraserRef.current;
      
      ctx.strokeStyle = isErasing ? "#ffffff" : colorRef.current;
      ctx.lineWidth = sizeRef.current;
      ctx.stroke();

      //Send to server using normalized coordinates
      socket.emit("draw", {
        x0: lastNormX,
        y0: lastNormY,
        x1: pos.normX,
        y1: pos.normY,
        color: isErasing ? "#ffffff" : colorRef.current,
        size: sizeRef.current,
        username: usernameRef.current,
      });

      lastNormX = pos.normX;
      lastNormY = pos.normY;
    };

    const stopDrawing = () => {
      if (!drawing) return;
      
      drawing = false;
      
      // Reset the temporary eraser when right-click is released
      if (isRightClick && toolRef.current === "brush") {
        setTempEraser(false);
      }
      isRightClick = false;
      
      socket.emit("stopDrawing", { username: usernameRef.current });
      
      //Send canvas state after stopping drawing to ensure server has latest
      socket.emit("canvasSnapshot", canvas.toDataURL());
    };
    
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("mousedown", startDrawing);
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", stopDrawing);
    canvas.addEventListener("mouseleave", stopDrawing);

    //Socket event handlers
    socket.on("initialCanvas", (history) => {
      //Clear canvas first
      ctx.clearRect(0, 0, canvas.width / (window.devicePixelRatio || 1), 
                    canvas.height / (window.devicePixelRatio || 1));
      
      //Apply draw history with coordinate conversion
      history.forEach(({ x0, y0, x1, y1, color, size }) => {
        const rect = canvas.getBoundingClientRect();
        
        //Convert normalized coordinates to this canvas's pixels
        const cssX0 = x0 * rect.width;
        const cssY0 = y0 * rect.height;
        const cssX1 = x1 * rect.width;
        const cssY1 = y1 * rect.height;
        
        ctx.beginPath();
        ctx.moveTo(cssX0, cssY0);
        ctx.lineTo(cssX1, cssY1);
        ctx.strokeStyle = color;
        ctx.lineWidth = size;
        ctx.stroke();
      });
      
      undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
    });

    socket.on("draw", ({ x0, y0, x1, y1, color, size }) => {
      const rect = canvas.getBoundingClientRect();
      
      //Convert normalized coordinates to this canvas's pixels
      const cssX0 = x0 * rect.width;
      const cssY0 = y0 * rect.height;
      const cssX1 = x1 * rect.width;
      const cssY1 = y1 * rect.height;
      
      ctx.beginPath();
      ctx.moveTo(cssX0, cssY0);
      ctx.lineTo(cssX1, cssY1);
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.stroke();
    });

    socket.on("clear", () => {
      ctx.clearRect(0, 0, canvas.width / (window.devicePixelRatio || 1), 
                   canvas.height / (window.devicePixelRatio || 1));
      undoStackRef.current = [];
      redoStackRef.current = [];
    });

    socket.on("canvasState", (dataURL) => {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width / (window.devicePixelRatio || 1), 
                      canvas.height / (window.devicePixelRatio || 1));
        
        ctx.drawImage(img, 0, 0, canvas.width / (window.devicePixelRatio || 1), 
                           canvas.height / (window.devicePixelRatio || 1));
                           
        undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
        redoStackRef.current = [];
      };
      img.src = dataURL;
    });

    socket.on("userMouseMove", (users) => {
      setActiveUsers(users);
    });

    //Handle server requesting a canvas snapshot
    socket.on("requestCanvasSnapshot", () => {
      socket.emit("canvasSnapshot", canvas.toDataURL());
    });

    //4) Finally connect
    socket.connect();

    //Periodically ensure server has latest canvas state
    const intervalId = setInterval(() => {
      //If we're connected, send a snapshot
      if (socket.connected) {
        socket.emit("canvasSnapshot", canvas.toDataURL());
      }
    }, 60000); //Every minute

    //Clean up on unmount
    return () => {
      socket.disconnect();
      clearInterval(intervalId);
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("mousedown", startDrawing);
      canvas.removeEventListener("mousemove", draw);
      canvas.removeEventListener("mouseup", stopDrawing);
      canvas.removeEventListener("mouseleave", stopDrawing);
      socket.off("initialCanvas");
      socket.off("draw");
      socket.off("clear");
      socket.off("canvasState");
      socket.off("userMouseMove");
      socket.off("requestCanvasSnapshot");
    };
  }, [username]);

  //5) Global undo/redo
  useEffect(() => {
    const handler = (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      

      if (e.ctrlKey && e.key === "z") {
        e.preventDefault(); //Prevent browser default
        const last = undoStackRef.current.pop();
        if (last) {
          redoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
          ctx.putImageData(last, 0, 0);
          socket.emit("canvasState", canvas.toDataURL());
        }
      }
      if (e.ctrlKey && e.key === "y") {
        e.preventDefault(); //Prevent browser default
        const next = redoStackRef.current.pop();
        if (next) {
          undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
          ctx.putImageData(next, 0, 0);
          socket.emit("canvasState", canvas.toDataURL());
        }
      }
    };


    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  //Send our current username when it changes
  useEffect(() => {
    if (username && socket.connected) {
      socket.emit("setUsername", username);
    }
  }, [username]);

  //fixed size multiplier - adjust if needed to make brush consistent on different devices
  const fixedSizeMultiplier = 1;

  // Determine if we're currently in eraser mode (either selected or temporary)
  const isErasingMode = tool === "eraser" || tempEraser;

  return (
    <>
      <div className="toolbar">
        <button onClick={() => setTool("brush")} style={{ background: tool === "brush" ? "#ccc" : "#eee" }}>
          Brush
        </button>
        <button onClick={() => setTool("eraser")} style={{ background: tool === "eraser" ? "#ccc" : "#eee" }}>
          Eraser
        </button>
        <label>
          Size:
          <input type="range" min={1} max={20} value={size} onChange={e => setSize(+e.target.value)} />
          <span>{size}px</span>
        </label>
        <label>
          Color:
          <input type="color" value={color} onChange={e => setColor(e.target.value)} disabled={isErasingMode} />
        </label>
      </div>

      <p style={{ fontSize: "0.8rem", color: "#666" }}>
        Tip: Press <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo, <kbd>Ctrl</kbd>+<kbd>Y</kbd> to redo. Right-click to temporarily erase while in brush mode.
      </p>

      <div className="canvas-container" ref={canvasContainerRef}>
        <canvas ref={canvasRef} />
        {/* eraser preview circle */}
        {isErasingMode && (
          <div style={{
            position: "absolute",
            left: cursorPos.x,
            top: cursorPos.y,
            width: `${size * fixedSizeMultiplier * 2}px`,
            height: `${size * fixedSizeMultiplier * 2}px`,
            borderRadius: "50%",
            border: "1px solid black",
            backgroundColor: "rgba(255, 255, 255, 0.3)",
            transform: "translate(-50%, -50%)",
            pointerEvents: "none"
          }}></div>
        )}
        {/* User cursor indicators with normalized coordinates */}
        {Object.entries(activeUsers).map(([id, data]) =>
          id !== socket.id && canvasContainerRef.current && (
            <div key={id} style={{ 
              position: "absolute", 
              left: `${data.x * canvasContainerRef.current.getBoundingClientRect().width}px`,
              top: `${data.y * canvasContainerRef.current.getBoundingClientRect().height}px`, 
              pointerEvents: "none" 
            }}>
              <div className="cursor-pointer">▼</div>
              <div className="username-tag">{data.username}</div>
            </div>
          )
        )}
      </div>
    </>
  );
}