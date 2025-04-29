//src/chatbox.js
import { useEffect, useRef, useState } from "react";
import "./chatbox.css"; // Import styles

//Simple helper to format ISO timestamp to HH:MM
function formatTime(isoString) {
    if (!isoString) return '';
    try {
        const date = new Date(isoString);
        //local time formatting :>
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
    } catch (e) {
        console.error("Error formatting time:", e);
        return ''; //empty string on error
    }
}


export default function Chatbox({ socket, username }) { //Receive own username as prop
  const [isOpen, setIsOpen] = useState(false); //Chatbox open/closed state
  const [message, setMessage] = useState("");   //Current message input value
  const [messages, setMessages] = useState([]); //Array of chat message objects
  //Add state to track connection status
  const [isConnected, setIsConnected] = useState(socket ? socket.connected : false);
  const messagesEndRef = useRef(null);          //Ref for scrolling to bottom

  // Function to scroll message container to the bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  //effect for handling socket events related to chat
  useEffect(() => {
    if (!socket) return; //Don't run if socket isn't ready

    //Update connection state based on initial socket status
    setIsConnected(socket.connected);

    // Handler for receiving a single new chat message
    const handleChatMessage = (msg) => {
      setMessages((prevMessages) => {
        const updatedMessages = [...prevMessages, msg];
        // Keep only the last N messages (e.g., 20 to match server)
        return updatedMessages.slice(-20);
      });
    };

    // Handler for receiving initial chat history
    const handleChatHistory = (history) => {
        console.log("Received chat history:", history);
        setMessages(Array.isArray(history) ? history : []); // Ensure history is an array
    };

    // *** Listener for socket connection ***
    const handleConnect = () => {
        console.log('Chatbox socket connected');
        setIsConnected(true);
    };

    //Listener for socket disconnection
    const handleDisconnect = (reason) => {
        console.log('Chatbox socket disconnected:', reason);
        setIsConnected(false);
        // Optionally, you could add logic here to show a "disconnected" message
        // or attempt a manual reconnect if auto-reconnect fails persistently.
    };

    //Register listeners
    socket.on("chatMessage", handleChatMessage);
    socket.on("chatHistory", handleChatHistory);
    socket.on("connect", handleConnect);       // Add connect listener
    socket.on("disconnect", handleDisconnect); // Add disconnect listener

    //Cleanup, remove listeners when component unmounts or socket changes
    return () => {
      socket.off("chatMessage", handleChatMessage);
      socket.off("chatHistory", handleChatHistory);
      socket.off("connect", handleConnect);       // Remove connect listener
      socket.off("disconnect", handleDisconnect); // Remove disconnect listener
    };
  }, [socket]); //Dependency: re-run if socket instance changes

  //effect to scroll down when messages update or chat opens
  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [messages, isOpen]); //dependencies: messages array, open state

  // Function to handle sending a message
  const sendMessage = (e) => {
    e.preventDefault(); // Prevent form submission page reload
    // *** Check isConnected state instead of socket.connected directly ***
    if (!message.trim() || !socket || !isConnected) return; // Basic validation

    //Emit message to server
    socket.emit("sendMessage", {
      text: message,
      //Username and timestamp are added server-side
    });

    setMessage(""); // Clear input field
  };

  //Render the chatbox UI
  return (
    <div className={`chatbox-container ${isOpen ? "open" : "closed"}`}>
      {/* Header toggles open/closed state */}
      <div className="chatbox-header" onClick={() => setIsOpen(!isOpen)}>
        {isOpen ? "Chat (Click to Minimize)" : "Chat (Click to Open)"}
        {/* Optionally indicate connection status in header */}
        {!isConnected && isOpen && <span style={{color: 'red', marginLeft: '10px', fontSize: '0.8em'}}>(Offline)</span>}
      </div>

      {/* Only render content when open */}
      {isOpen && (
        <>
          {/* Static warning message */}
          <div className="chat-warning">
          ⚠️WARNING⚠️ This is a public chatroom. Strangers can be weird. Please be cautious and respectful. 
          </div>

          {/* Messages display area */}
          <div className="messages-container">
            {/* Map over messages and render each one */}
            {messages.map((msg, index) => {
              const isOwnMessage = msg.username === username;
              return (
                <div key={index} className="message">
                  <span className="message-username">
                    {isOwnMessage ? `You (${msg.username || 'User'})` : (msg.username || 'User')}:
                  </span>
                  <span className="message-text"> {msg.text}</span>
                  <span className="message-time">
                      {formatTime(msg.timestamp)}
                  </span>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Message input form */}
          <form onSubmit={sendMessage} className="chat-input-form">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={isConnected ? "Type a message..." : "Connecting..."} // Change placeholder when disconnected
              maxLength={200}
              aria-label="Chat message input"
              disabled={!isConnected} // Also disable input field if not connected
            />
            {/* *** Update disabled prop to use isConnected state *** */}
            <button type="submit" disabled={!isConnected}>
                Send
            </button>
          </form>
        </>
      )}
    </div>
  );
}
