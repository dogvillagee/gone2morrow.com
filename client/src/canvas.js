import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";
import Chatbox from "./chatbox";
import { v4 as uuidv4 } from 'uuid';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:4000";
const socket = io(BACKEND_URL, { autoConnect: false });
const MAX_DRAW_HISTORY_CLIENT = 500;
const BASE_CANVAS_WIDTH = 1800;
const BASE_CANVAS_HEIGHT = 830;
const MOUSE_MOVE_THROTTLE = 30;
const SNAPSHOT_DELAY = 50;

export default function Canvas() {
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const lastEmitTimeRef = useRef(0);
  const canvasDataRef = useRef(null);
  const drawHistoryRef = useRef([]);
  const currentStrokeIdRef = useRef(null);
  const currentSegmentsRef = useRef([]);
  const isDrawingRef = useRef(false);
  const redrawRequestIdRef = useRef(null);

  const [tool, setTool] = useState("brush");
  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState(5);
  const [username, setUsername] = useState("");
  const [activeUsers, setActiveUsers] = useState({});
  const [cursorPos, setCursorPos] = useState({ x: -100, y: -100 });
  const [tempEraser, setTempEraser] = useState(false);
  const [isConnected, setIsConnected] = useState(socket.connected);

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

  const getPos = useCallback((e) => {
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

    const normX = rect.width > 0 ? cssX / rect.width : 0;
    const normY = rect.height > 0 ? cssY / rect.height : 0;

    return { normX, normY, cssX, cssY };
  }, []);

  const clipToBounds = useCallback((x, y) => ({
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  }), []);

  const updateCanvasSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvasDataRef.current = canvas.toDataURL("image/png");
    } catch (e) {
      console.warn("Could not update canvas snapshot:", e);
    }
  }, []);

  const redrawCanvasFromHistory = useCallback(() => {
    if (redrawRequestIdRef.current) {
      cancelAnimationFrame(redrawRequestIdRef.current);
    }

    redrawRequestIdRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const strokeHistory = drawHistoryRef.current;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (!strokeHistory || strokeHistory.length === 0) {
        updateCanvasSnapshot();
        return;
      }

      const originalStrokeStyle = ctx.strokeStyle;
      const originalLineWidth = ctx.lineWidth;
      const originalLineCap = ctx.lineCap;
      const originalLineJoin = ctx.lineJoin;

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      strokeHistory.forEach((stroke, strokeIndex) => {
        if (stroke && !stroke.undone && Array.isArray(stroke.segments) && stroke.segments.length > 0) {
          stroke.segments.forEach((segment, segmentIndex) => {
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
            }
          });
        } else if (stroke && stroke.undone) {
        } else {
        }
      });

      ctx.strokeStyle = originalStrokeStyle;
      ctx.lineWidth = originalLineWidth;
      ctx.lineCap = originalLineCap;
      ctx.lineJoin = originalLineJoin;
      ctx.beginPath();

      updateCanvasSnapshot();
    });
  }, [updateCanvasSnapshot]);

  useEffect(() => {
    let storedUsername = localStorage.getItem('canvasUsername');
    if (storedUsername) {
      setUsername(storedUsername);
    } else {
      const id = Math.floor(Math.random() * 1000);
      const newUsername = `Anonymous${id}`;
      setUsername(newUsername);
      localStorage.setItem('canvasUsername', newUsername);
    }
  }, []);

  useEffect(() => {
    if (!username) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let initialStateLoaded = false;

    const setupCanvas = () => {
      if (!canvasContainerRef.current || !canvas) return;

      const containerRect = canvasContainerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;

      const aspectRatio = BASE_CANVAS_HEIGHT / BASE_CANVAS_WIDTH;
      const containerHeight = containerWidth * aspectRatio;

      const needsInternalResize = canvas.width !== BASE_CANVAS_WIDTH || canvas.height !== BASE_CANVAS_HEIGHT;

      if (needsInternalResize) {
        let previousDataUrl = null;
        if (canvas.width > 0 && canvas.height > 0) {
          try {
            previousDataUrl = canvasDataRef.current || canvas.toDataURL("image/png");
          } catch (error) {
            console.warn("Could not cache canvas during resize setup:", error);
          }
        }

        canvas.width = BASE_CANVAS_WIDTH;
        canvas.height = BASE_CANVAS_HEIGHT;

        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = sizeRef.current;
        ctx.strokeStyle = colorRef.current;

        if (previousDataUrl) {
          const img = new Image();
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            updateCanvasSnapshot();
          };
          img.onerror = () => {
            console.warn("Failed to load snapshot on resize, clearing canvas.");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            updateCanvasSnapshot();
          };
          img.src = previousDataUrl;
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          updateCanvasSnapshot();
        }
      }

      canvas.style.width = `${containerWidth}px`;
      canvas.style.height = `${containerHeight}px`;
    };

    setupCanvas();

    let resizeTimeout = null;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(setupCanvas, 150);
    };
    window.addEventListener("resize", handleResize);

    const handleCanvasClick = (e) => {
        if (toolRef.current !== 'eyedropper' || !canvas || !ctx) return;
        const pos = getPos(e);
        const canvasX = Math.floor(pos.cssX * (canvas.width / canvas.getBoundingClientRect().width));
        const canvasY = Math.floor(pos.cssY * (canvas.height / canvas.getBoundingClientRect().height));
        try {
            const imageData = ctx.getImageData(canvasX, canvasY, 1, 1).data;
            const hexColor = `#${imageData[0].toString(16).padStart(2, '0')}${imageData[1].toString(16).padStart(2, '0')}${imageData[2].toString(16).padStart(2, '0')}`;
            setColor(hexColor);
            setTool('brush');
        } catch (error) {
            console.error("Eyedropper failed:", error);
            setTool('brush');
        }
    };


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

      isDrawingRef.current = true;
      const pos = getPos(e);
      const bounded = clipToBounds(pos.normX, pos.normY);
      lastNormX = bounded.x;
      lastNormY = bounded.y;

      currentStrokeIdRef.current = uuidv4();
      currentSegmentsRef.current = [];

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
      if (e.touches) e.preventDefault();
      if (!canvas || !ctx) return;

      const pos = getPos(e);
      setCursorPos({ x: pos.cssX, y: pos.cssY });

      if (!isDrawingRef.current) {
        const now = Date.now();
        if (now - lastEmitTimeRef.current > MOUSE_MOVE_THROTTLE) {
          const bounded = clipToBounds(pos.normX, pos.normY);
          if (socket.connected) {
            socket.emit("mouseMove", { x: bounded.x, y: bounded.y, username: usernameRef.current });
          }
          lastEmitTimeRef.current = now;
        }
        return;
      }

      const isErasing = toolRef.current === "eraser" || tempEraserRef.current;
      const currentDrawColor = isErasing ? "#ffffff" : colorRef.current;
      const currentDrawSize = sizeRef.current;

      ctx.strokeStyle = currentDrawColor;
      ctx.lineWidth = currentDrawSize;

      const bounded = clipToBounds(pos.normX, pos.normY);

      ctx.lineTo(bounded.x * canvas.width, bounded.y * canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bounded.x * canvas.width, bounded.y * canvas.height);

      const segment = {
        x0: lastNormX, y0: lastNormY,
        x1: bounded.x, y1: bounded.y,
        color: currentDrawColor,
        size: currentDrawSize,
      };

      currentSegmentsRef.current.push(segment);

      if (socket.connected) {
        socket.emit("draw", segment);
      }

      lastNormX = bounded.x;
      lastNormY = bounded.y;
    };

    const stopDrawing = () => {
      if (!isDrawingRef.current || !canvas || !ctx) return;
      isDrawingRef.current = false;

      if (tempEraserRef.current) {
        setTempEraser(false);
      }
      isRightClick = false;

      if (socket.connected) {
        socket.emit("stopDrawing", { username: usernameRef.current });

        if (currentStrokeIdRef.current && currentSegmentsRef.current.length > 0) {
          const currentStroke = {
            id: currentStrokeIdRef.current,
            segments: currentSegmentsRef.current,
          };
          socket.emit("addStroke", currentStroke);
        } else {
        }

        currentStrokeIdRef.current = null;
        currentSegmentsRef.current = [];

        setTimeout(() => {
          if (!canvasRef.current) return;
          try {
            const snapshotDataUrl = canvasRef.current.toDataURL("image/webp", 0.8);
            updateCanvasSnapshot();
            socket.emit("canvasSnapshot", snapshotDataUrl);
          } catch (error) {
            console.warn("Could not get/send snapshot on stopDrawing:", error);
          }
        }, SNAPSHOT_DELAY);
      } else {
         updateCanvasSnapshot();
      }

      ctx.beginPath();
      setCursorPos({ x: -100, y: -100 });
    };


    const preventDefault = e => e.preventDefault();
    canvas.addEventListener("contextmenu", preventDefault);
    canvas.addEventListener("mousedown", startDrawing);
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", stopDrawing);
    canvas.addEventListener("mouseleave", stopDrawing);
    canvas.addEventListener("touchstart", startDrawing, { passive: false });
    canvas.addEventListener("touchmove", draw, { passive: false });
    canvas.addEventListener("touchend", stopDrawing);
    canvas.addEventListener("touchcancel", stopDrawing);

    const onConnect = () => {
      setIsConnected(true);
      if (usernameRef.current) {
        socket.emit("setUsername", usernameRef.current);
      }
      if (!initialStateLoaded) {
      }
    };

    const onDisconnect = (reason) => {
      setIsConnected(false);
      setActiveUsers({});
    };

    const onConnectError = (error) => {
      console.error("Socket connection error:", error);
      setIsConnected(false);
    };

    const onInitialHistory = (history) => {
      if (!canvas || !ctx) return;
      drawHistoryRef.current = Array.isArray(history) ? history : [];
      if (!initialStateLoaded) {
        redrawCanvasFromHistory();
        initialStateLoaded = true;
      } else {
      }
    };

    const onCanvasState = (dataURL) => {
      if (!canvas || !ctx) return;
      if (!initialStateLoaded) {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          updateCanvasSnapshot();
          initialStateLoaded = true;
        };
        img.onerror = () => {
          console.error("Failed to load canvas state snapshot image.");
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          updateCanvasSnapshot();
          initialStateLoaded = true;
        };
        img.src = dataURL;
      } else {
      }
    };

    const onDrawSegment = (segmentData) => {
      if (!segmentData || typeof segmentData.x0 !== 'number' || typeof segmentData.y0 !== 'number' ||
          typeof segmentData.x1 !== 'number' || typeof segmentData.y1 !== 'number' ||
          typeof segmentData.color !== 'string' || typeof segmentData.size !== 'number') {
        console.warn("Received invalid draw segment data:", segmentData);
        return;
      }
      if (!canvas || !ctx) return;

      const { x0, y0, x1, y1, color, size } = segmentData;

      const originalStrokeStyle = ctx.strokeStyle;
      const originalLineWidth = ctx.lineWidth;
      const originalLineCap = ctx.lineCap;
      const originalLineJoin = ctx.lineJoin;

      ctx.beginPath();
      ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
      ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();

      ctx.strokeStyle = originalStrokeStyle;
      ctx.lineWidth = originalLineWidth;
      ctx.lineCap = originalLineCap;
      ctx.lineJoin = originalLineJoin;
      ctx.beginPath();

    };

    const onNewStroke = (newStroke) => {
      if (newStroke && newStroke.id && Array.isArray(newStroke.segments)) {
        const existingIndex = drawHistoryRef.current.findIndex(s => s && s.id === newStroke.id);
        if (existingIndex === -1) {
          drawHistoryRef.current.push(newStroke);
          if (drawHistoryRef.current.length > MAX_DRAW_HISTORY_CLIENT) {
            drawHistoryRef.current = drawHistoryRef.current.slice(-MAX_DRAW_HISTORY_CLIENT);
          }
        } else {
        }
      } else {
        console.warn("Received invalid new stroke data:", newStroke);
      }
    };

    const onStrokeUndoStateChanged = ({ strokeId, undone }) => {
      if (!strokeId) {
        console.warn("Received invalid strokeUndoStateChanged event: missing strokeId");
        return;
      }
      const strokeIndex = drawHistoryRef.current.findIndex(s => s && s.id === strokeId);
      if (strokeIndex !== -1) {
        drawHistoryRef.current[strokeIndex].undone = undone;
        redrawCanvasFromHistory();
      } else {
        console.warn(`Stroke ${strokeId} not found in local history for undo/redo update. Redrawing anyway.`);
        redrawCanvasFromHistory();
      }
    };

    const onClear = () => {
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvasDataRef.current = null;
      drawHistoryRef.current = [];
      initialStateLoaded = true;
      updateCanvasSnapshot();
    };

    const onUserMouseMove = (users) => {
      const otherUsers = { ...users };
      if (socket.id && otherUsers[socket.id]) {
        delete otherUsers[socket.id];
      }
      const boundedUsers = {};
      Object.entries(otherUsers).forEach(([id, data]) => {
        if (data && typeof data.x === 'number' && typeof data.y === 'number') {
          const bounded = clipToBounds(data.x, data.y);
          boundedUsers[id] = { ...data, x: bounded.x, y: bounded.y };
        } else {
        }
      });
      setActiveUsers(boundedUsers);
    };

    const onRequestCanvasSnapshot = () => {
      if (!canvasRef.current || !socket.connected) return;
      try {
        const snapshotDataUrl = canvasRef.current.toDataURL("image/png", 0.9);
        socket.emit("canvasSnapshot", snapshotDataUrl);
      } catch (error) {
        console.warn("Could not generate or send requested snapshot:", error);
      }
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("initialHistory", onInitialHistory);
    socket.on("canvasState", onCanvasState);
    socket.on("draw", onDrawSegment);
    socket.on("newStroke", onNewStroke);
    socket.on("strokeUndoStateChanged", onStrokeUndoStateChanged);
    socket.on("clear", onClear);
    socket.on("userMouseMove", onUserMouseMove);
    socket.on("requestCanvasSnapshot", onRequestCanvasSnapshot);

    socket.connect();

    return () => {
      socket.disconnect();
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("initialHistory", onInitialHistory);
      socket.off("canvasState", onCanvasState);
      socket.off("draw", onDrawSegment);
      socket.off("newStroke", onNewStroke);
      socket.off("strokeUndoStateChanged", onStrokeUndoStateChanged);
      socket.off("clear", onClear);
      socket.off("userMouseMove", onUserMouseMove);
      socket.off("requestCanvasSnapshot", onRequestCanvasSnapshot);
      window.removeEventListener("resize", handleResize);
      if (canvas) {
        canvas.removeEventListener("contextmenu", preventDefault);
        canvas.removeEventListener("mousedown", startDrawing);
        canvas.removeEventListener("mousemove", draw);
        canvas.removeEventListener("mouseup", stopDrawing);
        canvas.removeEventListener("mouseleave", stopDrawing);
        canvas.removeEventListener("touchstart", startDrawing);
        canvas.removeEventListener("touchmove", draw);
        canvas.removeEventListener("touchend", stopDrawing);
        canvas.removeEventListener("touchcancel", stopDrawing);
      }
      if (redrawRequestIdRef.current) {
        cancelAnimationFrame(redrawRequestIdRef.current);
      }
      clearTimeout(resizeTimeout);
    };
  }, [username, redrawCanvasFromHistory, getPos, clipToBounds, updateCanvasSnapshot]);


  useEffect(() => {
    let isUndoRedoKeyDown = false;

    const handleKeyDown = (e) => {
      const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey;
      const isRedo = (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"));

      const targetIsInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;

      if (!targetIsInput && (isUndo || isRedo) && !isUndoRedoKeyDown) {
        e.preventDefault();
        isUndoRedoKeyDown = true;

        if (socket.connected) {
          if (isUndo) {
            socket.emit("undo");
          } else if (isRedo) {
            socket.emit("redo");
          }
        } else {
          console.warn("Cannot undo/redo: Socket not connected.");
        }
      }
    };

    const handleKeyUp = (e) => {
      if (['Control', 'Meta', 'z', 'Z', 'y', 'Y'].includes(e.key)) {
        isUndoRedoKeyDown = false;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);


  useEffect(() => {
    if (username && socket.connected) {
      socket.emit("setUsername", username);
    }
  }, [username]);


  const isErasingMode = tool === "eraser" || tempEraser;
  const canvasCursor = tool === 'eyedropper' ? 'crosshair' : (isErasingMode ? 'grab' : 'default');

  return (
    <>
      {!isConnected && (
        <div style={{ color: 'red', textAlign: 'center', marginBottom: '0.5rem', fontWeight: 'bold' }}>
          ⚠️ Disconnected from server. Trying to reconnect...
        </div>
      )}

      <div className="toolbar">
        <button
          onClick={() => setTool("brush")}
          className={tool === "brush" ? "active" : ""}
          title="Brush Tool (Right-click and drag to erase)"
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
            max={50}
            value={size}
            onChange={e => setSize(Number(e.target.value))}
            aria-label="Brush size"
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
            aria-label="Brush color"
          />
        </label>
        <button
          onClick={() => setTool("eyedropper")}
          className={tool === "eyedropper" ? "active" : ""}
          title="Color Picker Tool (Click on canvas to pick color)"
        >
          PICK COLOR
        </button>
      </div>

      <div className="canvas-container" ref={canvasContainerRef}>
        <canvas ref={canvasRef} style={{ cursor: canvasCursor }} />

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

        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5 }}>
          {canvasContainerRef.current && Object.entries(activeUsers).map(([id, data]) => (
            <div
              key={id}
              style={{
                position: "absolute",
                left: `${data.x * canvasContainerRef.current.clientWidth}px`,
                top: `${data.y * canvasContainerRef.current.clientHeight}px`,
                transition: "left 0.05s linear, top 0.05s linear",
                transform: 'translateY(-100%)'
              }}
            >
              <div className="cursor-pointer" style={{ color: data.drawing ? 'red' : 'black' }}>
                ▼
              </div>
              <div className="username-tag">
                {data.username || 'Anonymous'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {socket && username && (
        <Chatbox socket={socket} username={username} />
      )}
    </>
  );
}
