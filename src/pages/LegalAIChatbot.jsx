import React, { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Shell from "@/components/layout/Shell";
import { chatWithDocument } from "@/lib/api";
import { 
  Send, 
  ArrowLeft, 
  Sparkles, 
  User, 
  Bot, 
  ArrowUpRight,
  Mic,
  MicOff,
  Volume2,
  VolumeX
} from "lucide-react";

export default function LegalAIChatbot() {
  const { id } = useParams();
  const navigate = useNavigate();
  
  const [messages, setMessages] = useState([
    {
      id: 1,
      role: "assistant",
      content: "Hello! I'm your AI Legal Assistant. I've analyzed the uploaded document. Ask me anything about the clauses, risks, obligations, or terms in this contract.",
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [inputVal, setInputVal] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);

  // Voice States
  const [isListening, setIsListening] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState(null);
  const [voiceLang, setVoiceLang] = useState("en-US");
  const recognitionRef = useRef(null);
  const startInputRef = useRef("");

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = window.WindowsSpeechRecognition || window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = voiceLang;

      rec.onstart = () => {
        setIsListening(true);
      };

      rec.onend = () => {
        setIsListening(false);
      };

      rec.onresult = (event) => {
        let speechTranscript = "";
        for (let i = 0; i < event.results.length; i++) {
          speechTranscript += event.results[i][0].transcript;
        }
        if (speechTranscript) {
          const base = startInputRef.current || "";
          setInputVal(base + (base ? " " : "") + speechTranscript.trim());
        }
      };

      rec.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        setIsListening(false);
      };

      recognitionRef.current = rec;
    }

    return () => {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Dynamically update recognition language on selection change
  useEffect(() => {
    if (recognitionRef.current) {
      recognitionRef.current.lang = voiceLang;
    }
  }, [voiceLang]);

  const toggleListening = () => {
    if (!recognitionRef.current) {
      alert("Speech recognition is not supported in this browser. Please use Google Chrome, Edge, or Safari.");
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
    } else {
      try {
        startInputRef.current = inputVal;
        recognitionRef.current.start();
      } catch (err) {
        console.error("Failed to start SpeechRecognition:", err);
      }
    }
  };

  const handleSpeak = (text, msgId) => {
    if (!window.speechSynthesis) {
      alert("Text-to-speech is not supported in this browser.");
      return;
    }

    if (window.speechSynthesis.speaking || window.activeFallbackAudio) {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }
      if (window.activeFallbackAudio) {
        window.activeFallbackAudio.pause();
        window.activeFallbackAudio = null;
      }
      if (speakingMsgId === msgId) {
        setSpeakingMsgId(null);
        return;
      }
    }

    // Clean formatting characters to sound more natural
    const cleanText = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[*_#\-`]/g, "");

    // Fallback for Telugu (te-IN) if native Telugu voice is missing
    if (voiceLang.startsWith("te")) {
      const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      const matchingVoice = voices.find(v => v.lang.startsWith("te"));
      
      if (!matchingVoice) {
        try {
          // Robust Telugu sentence-to-chunk parser ensuring all chunks are <= 180 characters
          const sentences = cleanText.match(/[^.!?\n]+[.!?\n]+(\s|$)|[^.!?\n]+$/g) || [cleanText];
          const chunks = [];
          let currentChunk = "";

          const addChunk = (text) => {
            text = text.trim();
            if (!text) return;
            if (text.length <= 180) {
              chunks.push(text);
            } else {
              // Split long sentences by words to avoid exceeding API limits
              const words = text.split(/\s+/);
              let subChunk = "";
              for (const word of words) {
                if ((subChunk + " " + word).trim().length > 180) {
                  if (subChunk) chunks.push(subChunk.trim());
                  subChunk = word;
                } else {
                  subChunk += (subChunk ? " " : "") + word;
                }
              }
              if (subChunk) {
                chunks.push(subChunk.trim());
              }
            }
          };

          for (const sentence of sentences) {
            if ((currentChunk + " " + sentence).trim().length > 180) {
              if (currentChunk) {
                addChunk(currentChunk);
              }
              currentChunk = sentence;
            } else {
              currentChunk += (currentChunk ? " " : "") + sentence;
            }
          }
          if (currentChunk) {
            addChunk(currentChunk);
          }

          if (chunks.length === 0) return;

          let chunkIndex = 0;
          const playNextChunk = () => {
            if (chunkIndex >= chunks.length) {
              setSpeakingMsgId(null);
              window.activeFallbackAudio = null;
              return;
            }
            const chunkText = chunks[chunkIndex];
            // Use translate.googleapis.com with client=gtx to avoid CORS/Forbidden errors
            const url = `https://translate.googleapis.com/translate_tts?client=gtx&tl=te&ie=UTF-8&q=${encodeURIComponent(chunkText)}`;
            const audio = new Audio(url);
            window.activeFallbackAudio = audio;
            audio.onended = () => {
              chunkIndex++;
              playNextChunk();
            };
            audio.onerror = (e) => {
              console.error("Audio playback error:", e);
              setSpeakingMsgId(null);
              window.activeFallbackAudio = null;
            };
            audio.play().catch(err => {
              console.error("Audio playback failed:", err);
              setSpeakingMsgId(null);
              window.activeFallbackAudio = null;
            });
          };

          setSpeakingMsgId(msgId);
          playNextChunk();
          return;
        } catch (err) {
          console.error("Google TTS fallback failed:", err);
        }
      }
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = voiceLang;

    // Try finding matching language voice
    if (window.speechSynthesis) {
      const voices = window.speechSynthesis.getVoices();
      const matchingVoice = voices.find(v => v.lang.startsWith(voiceLang.split('-')[0]));
      if (matchingVoice) {
        utterance.voice = matchingVoice;
      }
    }
    
    utterance.onend = () => {
      setSpeakingMsgId(null);
    };

    utterance.onerror = () => {
      setSpeakingMsgId(null);
    };

    setSpeakingMsgId(msgId);
    window.speechSynthesis.speak(utterance);
  };

  const suggestionChips = [
    "What is the termination clause?",
    "Are there compliance risks?",
    "Summarize this contract.",
    "Identify risky obligations."
  ];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const handleSend = async (text) => {
    if (!text.trim() || isTyping) return;

    // Add user message
    const userMsg = {
      id: messages.length + 1,
      role: "user",
      content: text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setMessages(prev => [...prev, userMsg]);
    setInputVal("");
    setIsTyping(true);

    // Cancel text speech when sending new message
    if (window.speechSynthesis || window.activeFallbackAudio) {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (window.activeFallbackAudio) {
        window.activeFallbackAudio.pause();
        window.activeFallbackAudio = null;
      }
      setSpeakingMsgId(null);
    }

    try {
      // Call real backend /chat endpoint
      const response = await chatWithDocument(id, text);
      
      const assistantMsg = {
        id: messages.length + 2,
        role: "assistant",
        content: response.answer,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      console.error("Chat failed:", err);
      const errorMsg = {
        id: messages.length + 2,
        role: "assistant",
        content: `I encountered an error processing your question: ${err.response?.data?.detail || err.message || "Unknown error"}. Please try again.`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isError: true
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <Shell>
      <div className="flex flex-col h-[calc(100vh-180px)] space-y-4">
        
        {/* Chat Header Bar */}
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => navigate(`/analysis/${id}`)}
              className="p-1.5 border border-border bg-white rounded text-text-secondary hover:text-primary transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-md font-semibold text-primary">LexiconAI Legal Assistant</h1>
              <p className="text-[11px] text-text-secondary flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-risk-green rounded-full"></span>
                <span>Contextualized to Document: {id?.substring(0, 8)}...</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-risk-blue animate-pulse" />
            <span className="text-[11px] font-bold text-text-secondary uppercase tracking-wider">AI Contract Intelligence</span>
          </div>
        </div>

        {/* Messages Body */}
        <div className="flex-1 overflow-y-auto pr-2 space-y-4 border border-border rounded bg-white p-5 shadow-xs">
          {messages.map((msg) => {
            const isAI = msg.role === "assistant";
            return (
              <div 
                key={msg.id} 
                className={`flex gap-3 max-w-[85%] ${isAI ? "self-start" : "ml-auto flex-row-reverse"}`}
              >
                {/* Avatar */}
                <div className={`w-8 h-8 rounded shrink-0 flex items-center justify-center border ${
                  isAI ? "bg-primary-100 border-primary/10 text-primary" : "bg-primary text-white border-primary"
                }`}>
                  {isAI ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
                </div>

                {/* Bubble content */}
                <div className="space-y-1">
                  <div className={`p-3.5 rounded text-[13px] leading-relaxed shadow-xs ${
                    isAI 
                      ? `${msg.isError ? "bg-risk-red-light/50 border border-risk-red/20" : "bg-primary-50/70 border border-border"} text-primary rounded-tl-none` 
                      : "bg-primary text-white rounded-tr-none"
                  }`}>
                    {msg.content}
                  </div>
                  <div className={`text-[10px] text-text-muted flex items-center gap-2 ${isAI ? "" : "justify-end"}`}>
                    <span>{msg.time}</span>
                    {isAI && (
                      <button
                        onClick={() => handleSpeak(msg.content, msg.id)}
                        className={`p-1 rounded hover:bg-slate-100 transition-colors text-text-secondary hover:text-primary focus:outline-none flex items-center gap-0.5 ${
                          speakingMsgId === msg.id ? "text-risk-blue animate-pulse" : ""
                        }`}
                        title={speakingMsgId === msg.id ? "Stop Speaking" : "Read Aloud"}
                      >
                        {speakingMsgId === msg.id ? (
                          <VolumeX className="w-3.5 h-3.5" />
                        ) : (
                          <Volume2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Typing indicator */}
          {isTyping && (
            <div className="flex gap-3 max-w-[85%] self-start">
              <div className="w-8 h-8 rounded shrink-0 flex items-center justify-center bg-primary-100 border border-primary/10 text-primary">
                <Bot className="w-4 h-4" />
              </div>
              <div className="p-3 bg-primary-50/70 border border-border rounded rounded-tl-none flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-text-secondary rounded-full animate-bounce"></div>
                <div className="w-1.5 h-1.5 bg-text-secondary rounded-full animate-bounce [animation-delay:0.2s]"></div>
                <div className="w-1.5 h-1.5 bg-text-secondary rounded-full animate-bounce [animation-delay:0.4s]"></div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Presets and Input Area */}
        <div className="space-y-3 pt-2">
          {/* Suggestion Chips */}
          <div className="flex flex-wrap items-center gap-2">
            {suggestionChips.map((chip, idx) => (
              <button
                key={idx}
                onClick={() => handleSend(chip)}
                disabled={isTyping}
                className="px-3 py-1 bg-white border border-border rounded text-[11px] text-text-secondary font-medium hover:border-primary hover:text-primary transition-all flex items-center gap-1 group shadow-xs disabled:opacity-50"
              >
                <span>{chip}</span>
                <ArrowUpRight className="w-3 h-3 text-text-muted group-hover:text-primary" />
              </button>
            ))}
          </div>

          {/* Form */}
          <form 
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(inputVal);
            }} 
            className="flex items-center gap-2"
          >
            <input
              type="text"
              placeholder="Ask a question about the contract clauses, risks, or obligations..."
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              disabled={isTyping}
              className="flex-1 px-4 py-2 border border-border rounded text-[13px] text-primary placeholder-text-muted focus:outline-none focus:border-primary bg-white shadow-xs disabled:opacity-50"
            />
            <select
              value={voiceLang}
              onChange={(e) => setVoiceLang(e.target.value)}
              className="px-2 py-2 border border-border rounded text-[11px] font-semibold text-text-secondary bg-white focus:outline-none focus:border-primary shadow-xs"
              title="Voice Language"
            >
              <option value="en-US">English</option>
              <option value="te-IN">Telugu (తెలుగు)</option>
              <option value="hi-IN">Hindi (हिन्दी)</option>
            </select>
            <button
              type="button"
              onClick={toggleListening}
              disabled={isTyping}
              className={`p-2 border border-border rounded transition-all duration-200 flex items-center justify-center shadow-xs disabled:opacity-50 ${
                isListening 
                  ? "bg-risk-red text-white border-risk-red animate-pulse scale-105" 
                  : "bg-white text-text-secondary hover:text-primary hover:border-primary"
              }`}
              title={isListening ? "Listening... Click to Stop" : "Speak Query"}
            >
              {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <button
              type="submit"
              disabled={isTyping || !inputVal.trim()}
              className="px-4 py-2 bg-primary text-white text-[13px] font-semibold rounded hover:bg-primary-light transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>

      </div>
    </Shell>
  );
}
