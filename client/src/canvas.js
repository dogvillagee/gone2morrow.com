// src/canvas.js
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

//Create socket but don't auto-connect
const socket = io("http://localhost:4000", { autoConnect: false });

export default function Canvas() {
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  //Create lastEmitTimeRef at component level
  const lastEmitTimeRef = useRef(0);

  //Tools & user state
  const [tool, setTool] = useState("brush");
  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState(5); //Set a default size
  const [username, setUsername] = useState("");
  const [activeUsers, setActiveUsers] = useState({});
  const [cursorPos, setCursorPos] = useState({ x: -100, y: -100 }); //State for eraser preview position
  const [tempEraser, setTempEraser] = useState(false); //State for temporary eraser mode (right-click)

  //Keep latest props in refs for event handlers
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

  // Username generation effect
  useEffect(() => {
    if (!username) {
      const id = Math.floor(Math.random() * 1000);
      setUsername(`Anonymous${id}`);
    }
  }, [username]);

  // Main setup effect for canvas, context, and listeners
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const canvasWidth = 1800;
    const canvasHeight = 830;

    //Setup DPI-correct canvas
    const setupCanvas = () => {
      if (!canvasContainerRef.current || !canvas) return;
      const containerRect = canvasContainerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      const containerHeight = canvasHeight * (containerWidth / canvasWidth);

      //Set display size (CSS pixels)
      canvas.style.width = `${containerWidth}px`;
      canvas.style.height = `${containerHeight}px`;

      //Set actual size in memory (scaled for DPI)
      const scale = window.devicePixelRatio || 1;
      canvas.width = containerWidth * scale;
      canvas.height = containerHeight * scale;

      //Scale the context drawings
      ctx.scale(scale, scale);
      //Set drawing defaults after scaling
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = sizeRef.current;
      ctx.strokeStyle = colorRef.current;
    };

    setupCanvas();

    // Resize handler
    const handleResize = () => {
      let tempCanvas = document.createElement('canvas');
      let tempCtx = tempCanvas.getContext('2d');
      const scale = window.devicePixelRatio || 1;
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      tempCtx.drawImage(canvas, 0, 0);

      setupCanvas();

      ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height,
                   0, 0, canvas.width / scale, canvas.height / scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = sizeRef.current;
      ctx.strokeStyle = colorRef.current;
    };

    window.addEventListener("resize", handleResize);

    //Get position in normalized coordinates, handles mouse and touch
    const getPos = (e) => {
      if (!canvasRef.current) return { normX: 0, normY: 0, cssX: 0, cssY: 0 };
      const rect = canvasRef.current.getBoundingClientRect();
      let clientX, clientY;

      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if (e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }

      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;

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

    //Eyedropper click handler
    const handleCanvasClick = (e) => {
      if (toolRef.current !== 'eyedropper' || !canvas || !ctx) return;

      const pos = getPos(e);
      const scale = window.devicePixelRatio || 1;

      try {
        const imageData = ctx.getImageData(pos.cssX * scale, pos.cssY * scale, 1, 1).data;
        const r = imageData[0];
        const g = imageData[1];
        const b = imageData[2];

        const hexColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

        setColor(hexColor);
        setTool('brush');
      } catch (error) {
        console.error("Error getting image data for eyedropper:", error);
        setTool('brush');
      }
    };

    let drawing = false;
    let lastNormX = 0, lastNormY = 0;
    let isRightClick = false;

    const startDrawing = (e) => {
      if (e.touches) {
        e.preventDefault();
      }
      if (!canvas || !ctx) return;

      if (toolRef.current === 'eyedropper') {
        handleCanvasClick(e);
        return;
      }

      isRightClick = (e.button === 2);

      const isErasing = toolRef.current === "eraser" || (isRightClick && toolRef.current === "brush");
      if (isErasing && !tempEraserRef.current) {
        if (isRightClick && toolRef.current === "brush") {
          setTempEraser(true);
        }
      }

      try {
        undoStackRef.current.push(
          ctx.getImageData(0, 0, canvas.width, canvas.height)
        );
        redoStackRef.current = [];
      } catch (error) {
        console.error("Could not get ImageData for undo:", error);
      }

      drawing = true;
      const pos = getPos(e);
      const bounded = clipToBounds(pos.normX, pos.normY);
      lastNormX = bounded.x;
      lastNormY = bounded.y;

      ctx.strokeStyle = isErasing ? "#ffffff" : colorRef.current;
      ctx.lineWidth = sizeRef.current;

      ctx.beginPath();
      ctx.moveTo(lastNormX * canvas.clientWidth, lastNormY * canvas.clientHeight);

      if (socket.connected) {
        socket.emit("setUsername", usernameRef.current);
        socket.emit("startDrawing", {
          x: lastNormX,
          y: lastNormY,
          username: usernameRef.current
        });
      } else {
        console.warn("Socket not connected, cannot start drawing.");
      }
    };

    const draw = (e) => {
      if (e.touches) {
        e.preventDefault();
      }
      if (!canvas || !ctx) return;

      const pos = getPos(e);
      setCursorPos({ x: pos.cssX, y: pos.cssY });

      if (!drawing) {
        const now = Date.now();
        if (now - lastEmitTimeRef.current > 50) {
          const bounded = clipToBounds(pos.normX, pos.normY);
          if (socket.connected) {
            socket.emit("mouseMove", {
              x: bounded.x,
              y: bounded.y,
              username: usernameRef.current
            });
          }
          lastEmitTimeRef.current = now;
        }
        return;
      }

      const isErasing = toolRef.current === "eraser" || tempEraserRef.current;

      ctx.strokeStyle = isErasing ? "#ffffff" : colorRef.current;
      ctx.lineWidth = sizeRef.current;

      const bounded = clipToBounds(pos.normX, pos.normY);

      ctx.lineTo(bounded.x * canvas.clientWidth, bounded.y * canvas.clientHeight);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(bounded.x * canvas.clientWidth, bounded.y * canvas.clientHeight);

      if (socket.connected) {
        socket.emit("draw", {
          x0: lastNormX,
          y0: lastNormY,
          x1: bounded.x,
          y1: bounded.y,
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
          socket.emit("canvasSnapshot", canvas.toDataURL("image/webp", 0.8));
        } catch (error) {
          console.error("Could not get canvas data URL on stopDrawing:", error);
        }
      }

      ctx.beginPath();
      setCursorPos({ x: -100, y: -100 });
    };

    // Event Listeners
    canvas.addEventListener("contextmenu", e => e.preventDefault());

    canvas.addEventListener("mousedown", startDrawing);
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", stopDrawing);
    canvas.addEventListener("mouseleave", stopDrawing);

    canvas.addEventListener("touchstart", startDrawing, { passive: false });
    canvas.addEventListener("touchmove", draw, { passive: false });
    canvas.addEventListener("touchend", stopDrawing);
    canvas.addEventListener("touchcancel", stopDrawing);

    // Socket event handlers
    socket.on("initialCanvas", (history) => {
      if (!canvas || !ctx) return;
      const scale = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width / scale, canvas.height / scale);

      history.forEach(({ x0, y0, x1, y1, color, size }) => {
        const rect = canvas.getBoundingClientRect();

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

      try {
        undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
        redoStackRef.current = [];
      } catch (error) {
        console.error("Could not get ImageData for initial undo state:", error);
        undoStackRef.current = [];
      }
    });

    socket.on("draw", ({ x0, y0, x1, y1, color, size }) => {
      if (!canvasRef.current || !canvas || !ctx) return;
      const rect = canvasRef.current.getBoundingClientRect();

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
      if (!canvas || !ctx) return;
      const scale = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width / scale, canvas.height / scale);
      undoStackRef.current = [];
      redoStackRef.current = [];

      try {
        undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      } catch (error) {
        console.error("Could not get ImageData for undo after clear:", error);
      }
    });

    socket.on("canvasState", (dataURL) => {
      if (!canvas || !ctx) return;
      const img = new Image();
      img.onload = () => {
        const scale = window.devicePixelRatio || 1;
        ctx.clearRect(0, 0, canvas.width / scale, canvas.height / scale);
        ctx.drawImage(img, 0, 0, canvas.width / scale, canvas.height / scale);

        try {
          undoStackRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
          redoStackRef.current = [];
        } catch (error) {
          console.error("Could not get ImageData for undo after receiving state:", error);
          undoStackRef.current = [];
        }
      };
      img.onerror = (err) => {
        console.error("Failed to load canvas state image:", err);
      };
      img.src = dataURL;
    });

    socket.on("userMouseMove", (users) => {
      const boundedUsers = {};
      const otherUsers = { ...users };
      if (socket.id && otherUsers[socket.id]) {
        delete otherUsers[socket.id];
      }

      Object.entries(otherUsers).forEach(([id, data]) => {
        const bounded = clipToBounds(data.x, data.y);
        boundedUsers[id] = { ...data, x: bounded.x, y: bounded.y };
      });
      setActiveUsers(boundedUsers);
    });

    socket.on("requestCanvasSnapshot", () => {
      if (!canvas) return;
      try {
        socket.emit("canvasSnapshot", canvas.toDataURL("image/webp", 0.8));
      } catch (error) {
        console.error("Could not get canvas data URL for snapshot request:", error);
      }
    });

    socket.connect();

    const intervalId = setInterval(() => {
      if (socket.connected && canvas) {
        try {
          socket.emit("canvasSnapshot", canvas.toDataURL("image/webp", 0.7));
        } catch (error) {
          // Ignore errors for periodic backup
        }
      }
    }, 60000);

    // Clean up
    return () => {
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
      socket.off("initialCanvas");
      socket.off("draw");
      socket.off("clear");
      socket.off("canvasState");
      socket.off("userMouseMove");
      socket.off("requestCanvasSnapshot");
    };
  }, [username]);

  // Undo and redo handling effect
  useEffect(() => {
    const handler = (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key === "z") {
          e.preventDefault();
          if (undoStackRef.current.length > 1) {
            const lastState = undoStackRef.current.pop();
            try {
              redoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
              ctx.putImageData(lastState, 0, 0);
              if (socket.connected) {
                socket.emit("canvasState", canvas.toDataURL("image/webp", 0.8));
              }
            } catch (error) {
              console.error("Could not get/put ImageData for undo:", error);
              if (lastState) undoStackRef.current.push(lastState);
            }
          }
        } else if (e.key === "y") {
          e.preventDefault();
          const nextState = redoStackRef.current.pop();
          if (nextState) {
            try {
              undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
              ctx.putImageData(nextState, 0, 0);
              if (socket.connected) {
                socket.emit("canvasState", canvas.toDataURL("image/webp", 0.8));
              }
            } catch (error) {
              console.error("Could not get/put ImageData for redo:", error);
              redoStackRef.current.push(nextState);
            }
          }
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (username && socket.connected) {
      socket.emit("setUsername", username);
    }
  }, [username]);

  const isErasingMode = tool === "eraser" || tempEraser;
  const canvasCursor = tool === 'eyedropper' ? 'pointer' : (isErasingMode ? 'grab' : 'default');

  return (
    <>
      <div className="toolbar">
        <button
          onClick={() => setTool("brush")}
          className={tool === "brush" ? "active" : ""}
          title="Brush Tool"
        >
          BRUSH
        </button>
        <button
          onClick={() => setTool("eraser")}
          className={tool === "eraser" ? "active" : ""}
          title="Eraser Tool"
        >
          ERASE
        </button>

        <label htmlFor="size-slider">
          Size:
          <input
            id="size-slider"
            type="range"
            min={1}
            max={20}
            value={size}
            onChange={e => setSize(+e.target.value)}
          />
          <span>{size}px</span>
        </label>
        <label htmlFor="color-picker">
          Color:
          <input
            id="color-picker"
            type="color"
            value={color}
            onChange={e => setColor(e.target.value)}
            disabled={isErasingMode || tool === 'eyedropper'}
          />
        </label>

        <button
          onClick={() => setTool("eyedropper")}
          className={tool === "eyedropper" ? "active" : ""}
          title="Color Picker Tool"
        >
          COLOR MATCH
        </button>
      </div>

      <div className="canvas-container" ref={canvasContainerRef}>
        <canvas
          ref={canvasRef}
          style={{ cursor: canvasCursor }}
        />

        {isErasingMode && cursorPos.x > -100 && (
          <div
            className="eraser-preview"
            style={{
              position: "absolute",
              left: `${cursorPos.x}px`,
              top: `${cursorPos.y}px`,
              width: `${size}px`,
              height: `${size}px`,
              border: "1px dashed grey",
              borderRadius: "50%",
              transform: 'translate(-50%, -50%)',
              pointerEvents: "none",
              zIndex: 10
            }}
            aria-hidden="true"
          />
        )}

        <div style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 5
        }}>
          {canvasContainerRef.current && Object.entries(activeUsers).map(([id, data]) => (
            <div key={id} style={{
              position: "absolute",
              left: `${data.x * canvasContainerRef.current.clientWidth}px`,
              top: `${data.y * canvasContainerRef.current.clientHeight}px`,
              transition: "left 0.05s linear, top 0.05s linear"
            }}>
              <div className="cursor-pointer">▼</div>
              <div className="username-tag">{data.username}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
