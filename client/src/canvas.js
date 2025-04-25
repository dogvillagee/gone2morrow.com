import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

//Create socket but don't auto-connect
const socket = io("http://localhost:4000", { autoConnect: false });

export default function Canvas() {
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  // Create lastEmitTimeRef at component level, not in a callback
  const lastEmitTimeRef = useRef(0);

  //Tools & user state
  const [tool, setTool] = useState("brush");
  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState();
  const [username, setUsername] = useState("");
  const [activeUsers, setActiveUsers] = useState({});
 
  const [cursorPos, setCursorPos] = useState({ x: -100, y: -100 });  //Restore cursorPos state for eraser preview
  

  const [tempEraser, setTempEraser] = useState(false); //New state for tracking temporary eraser mode (for right click)

  //Keep latest props in refs
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

  //Undo/redo stacks
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);

  useEffect(() => {
    if (!username) {
      const id = Math.floor(Math.random() * 1000) + 1; // Generate a random username once
      setUsername(`Anonymous${id}`);
    }
  }, [username]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const canvasWidth = 1800;
    const canvasHeight = 830;
    
    //Setup DPI-correct canvas
    const setupCanvas = () => {
      const containerRect = canvasContainerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      
      //Set display size (CSS pixels)
      canvas.style.width = `${containerWidth}px`;
      canvas.style.height = `${canvasHeight * (containerWidth / canvasWidth)}px`;
      
      // Set actual size in memory (scaled for DPI)
      const scale = window.devicePixelRatio || 1;
      canvas.width = containerWidth * scale;
      canvas.height = (canvasHeight * (containerWidth / canvasWidth)) * scale;
      
      // Scale the context to ensure correct drawing operations
      ctx.scale(scale, scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    };
    
    setupCanvas();
    
    const handleResize = () => {
      // Temporarily store the canvas content
      let tempCanvas = document.createElement('canvas');
      let tempCtx = tempCanvas.getContext('2d');
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      tempCtx.drawImage(canvas, 0, 0);
      
      //Resize and reset the canvas
      setupCanvas();
      
      // Draw back the content scaled to the new size
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

    //Clip coordinates to bounds (0-1)
    const clipToBounds = (x, y) => {
      return {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y))
      };
    };

    let drawing = false;
    let lastNormX = 0, lastNormY = 0;
    let isRightClick = false;

    const startDrawing = (e) => {
      
      isRightClick = (e.button === 2); //right click
      
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

      //Snapshot for undo
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
      // Get position
      const pos = getPos(e);
      // Restore setting cursor position for eraser preview
      setCursorPos({ x: pos.cssX, y: pos.cssY });
      
      if (!drawing) {
        // Throttle mouse move events when not drawing
        const now = Date.now();
        if (now - lastEmitTimeRef.current > 50) { // Send at most every 50ms
          // Apply bounds checking before sending
          const bounded = clipToBounds(pos.normX, pos.normY);
          socket.emit("mouseMove", { 
            x: bounded.x, 
            y: bounded.y, 
            username: usernameRef.current 
          });
          lastEmitTimeRef.current = now;
        }
        return;
      }

      // Draw locally
      ctx.lineTo(pos.cssX, pos.cssY);
      
      // Decide if in erasing mode
      const isErasing = toolRef.current === "eraser" || tempEraserRef.current;
      
      ctx.strokeStyle = isErasing ? "#ffffff" : colorRef.current;
      ctx.lineWidth = sizeRef.current;
      ctx.stroke();

      // Apply bounds checking before sending
      const bounded = clipToBounds(pos.normX, pos.normY);

      //Send to server using normalized coordinates
      socket.emit("draw", {
        x0: lastNormX,
        y0: lastNormY,
        x1: bounded.x,
        y1: bounded.y,
        color: isErasing ? "#ffffff" : colorRef.current,
        size: sizeRef.current,
        username: usernameRef.current,
      });

      lastNormX = bounded.x;
      lastNormY = bounded.y;
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
      
      // Send canvas state after stopping drawing to ensure server has latest
      socket.emit("canvasSnapshot", canvas.toDataURL());
    };
    
    canvas.addEventListener("contextmenu", e => e.preventDefault()); //for right clicking to erase
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
      
      //Convert normalized coordinates to this canvas's pixels DO NOT TOUCH ANYTHING DO NOT TOUCH ANYTHING HERE 
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
      //Apply boundary checking to all incoming user positions
      const boundedUsers = {};
      Object.entries(users).forEach(([id, data]) => {
        //Ensure bounds are applied to incoming coordinates
        const bounded = clipToBounds(data.x, data.y);
        boundedUsers[id] = {...data, x: bounded.x, y: bounded.y};
      });
      setActiveUsers(boundedUsers);
    });

    //Handle server requesting a canvas snapshot
    socket.on("requestCanvasSnapshot", () => {
      socket.emit("canvasSnapshot", canvas.toDataURL());
    });

    
    socket.connect(); //connect

    //Periodically checking t ensure server has latest canvas state
    const intervalId = setInterval(() => {
      //If connected, send a snapshot
      if (socket.connected) {
        socket.emit("canvasSnapshot", canvas.toDataURL());
      }
    }, 60000); // Every minuteish

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

  //undo and redo handling
  useEffect(() => {
    const handler = (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault(); //
        const last = undoStackRef.current.pop();
        if (last) {
          redoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
          ctx.putImageData(last, 0, 0);
          socket.emit("canvasState", canvas.toDataURL());
        }
      }
      if (e.ctrlKey && e.key === "y") {
        e.preventDefault(); //
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

  //Send current username when it changes
  useEffect(() => {
    if (username && socket.connected) {
      socket.emit("setUsername", username);
    }
  }, [username]);

  const isErasingMode = tool === "eraser" || tempEraser; //Determine if  in eraser mode (either selected or temporary)

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
        
      </p>

      <div className="canvas-container" ref={canvasContainerRef}>
        <canvas ref={canvasRef} />
        
        {/* Eraser preview circle */}
        {isErasingMode && (
          <div
            className="eraser-preview"
            style={{
              position: "absolute",
              left: `${cursorPos.x - size / 2}px`,
              top: `${cursorPos.y - size / 2}px`,
              width: `${size}px`,
              height: `${size}px`,
              border: "1px solid #000",
              borderRadius: "50%",
              pointerEvents: "none",
              zIndex: 5
            }}
          />
        )}
        
        {/*User cursor indicators with normalized coordinates*/}
        <div style={{
          position: "absolute", //dont change
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          pointerEvents: "none",
          zIndex: 5
        }}>
          {Object.entries(activeUsers).map(([id, data]) =>
            id !== socket.id && canvasContainerRef.current && (
              <div key={id} style={{ 
                position: "absolute", 
                left: `${data.x * canvasContainerRef.current.getBoundingClientRect().width}px`,
                top: `${data.y * canvasContainerRef.current.getBoundingClientRect().height}px`,
                transition: "transform 0.05s ease-out, left 0.05s ease-out, top 0.05s ease-out" //Add smooth transitions 
              }}>
                <div className="cursor-pointer">▼</div>
                <div className="username-tag">{data.username}</div>
              </div>
            )
          )}
        </div>
      </div>
    </>
  );
}