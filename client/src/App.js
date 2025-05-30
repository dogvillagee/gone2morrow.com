// src/App.js 

import React, { useEffect, useState } from "react";
import Canvas from "./canvas"; 
import "./App.css"; 

//youtube tutorial attempt at trying to disable inspect element
document.oncontextmenu = () => { 
  return false;
}
document.onkeydown = (e) => { 
  if (e.key === "F12") {
    alert("TRALALERO TRALALA."); //F12 case
    return false;
  }
  if (e.ctrlkey && e.key === "u") {
    alert("CTRL+U is disabled on this page."); //page sources case (doesnt work though?)
    return false;
  }

};


function App() {
  const [timeLeft, setTimeLeft] = useState("");

  
  useEffect(() => {
    //Prevent Ctrl+wheel Win/Linux and macOS 
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    const onKeyDown = (e) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        ["+", "-", "=", "0"].includes(e.key) //Prevent Ctrl + (+, -, =, 0) + macos
      ) {
        e.preventDefault();
      }
    };
    
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    //Set up countdown timer
    const updateCountdown = () => {
      const now = new Date();
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0); // Next midnight

      let diff = midnight - now;
      // Added check for negative diff
      if (diff < 0) diff += 24 * 60 * 60 * 1000;

      const hours = Math.floor(diff / (1000 * 60 * 60));
      diff -= hours * (1000 * 60 * 60);
      const minutes = Math.floor(diff / (1000 * 60));
      diff -= minutes * (1000 * 60);
      const seconds = Math.floor(diff / 1000);

      setTimeLeft(`${hours}h ${minutes}m ${seconds}s`); //formatting timer
    };

    updateCountdown();
    const intervalId = setInterval(updateCountdown, 1000);

    //cleanup
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      clearInterval(intervalId);
    };
  }, []);

  return (
    <>
    <div className="animated-background"></div>
    <div className="app">
      <div className="header">
        
        <h1>gone2morrow</h1>
        <p className="tagline">One Shared Canvas. Create Or Destroy. Nothing Lasts Forever!</p>
      </div>

      <div className="info-box">
        <div className="shortcut-tip">
          {}
          <span>Tip: Hold <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo, hold <kbd>Ctrl</kbd>+<kbd>Y</kbd> to redo, right click to erase</span>
        </div>
        <div>
          Canvas resets in: <span className="countdown">{timeLeft}</span>
        </div>
      </div>

      {}
      <Canvas />

      <div className="footer">
        &copy; {new Date().getFullYear()} gone2morrow
      </div>
    </div>
    </>
  );
}

export default App;
