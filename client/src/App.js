// src/App.js

import React, { useEffect } from "react";
import Canvas from "./canvas";
import "./App.css";

function App() {
  useEffect(() => {
    // 1) Prevent Ctrl+wheel (Win/Linux) or ⌘+wheel (macOS)
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    // 2) Prevent Ctrl + (+, -, =, 0) or ⌘ + same on macOS
    const onKeyDown = (e) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        ["+", "-", "=", "0"].includes(e.key)
      ) {
        e.preventDefault();
      }
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="app">
      <h1>gone2morrow (“Everything is Temporary”)</h1>
      <Canvas />
    </div>
  );
}

export default App;
