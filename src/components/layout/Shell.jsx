import React, { useState, useEffect, useRef } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { getAnalysis, chatWithDocument } from "@/lib/api";
import { useTranslation } from "@/lib/LanguageContext";
import { 
  Scale, 
  FileText, 
  AlertTriangle, 
  MessageSquare, 
  Activity, 
  Folder, 
  History, 
  Settings, 
  HelpCircle, 
  LogOut,
  UploadCloud,
  ChevronRight,
  TrendingUp,
  User,
  Plus,
  Columns,
  Calendar,
  Bot,
  Send,
  X,
  Menu,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Sun,
  Moon
} from "lucide-react";

export default function Shell({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { id: docId } = useParams();
  const { user, signOut, userRole } = useAuth();
  
  // Translation hook
  const { lang, setLang, t } = useTranslation();

  // Dark Mode states
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("theme");
      if (stored) return stored === "dark";
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return false;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [darkMode]);
  // Floating chatbot states
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hello! I am your LexiconAI assistant. How can I help you today?" }
  ]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Voice states for floating chatbot
  const [isListening, setIsListening] = useState(false);
  const [speakingMsgIdx, setSpeakingMsgIdx] = useState(null);
  const voiceLang = lang === "en" ? "en-US" : lang === "te" ? "te-IN" : "hi-IN";
  const recognitionRef = useRef(null);
  const startInputRef = useRef("");

  // Initialize Speech Recognition for floating chatbot
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
          setInput(base + (base ? " " : "") + speechTranscript.trim());
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
        startInputRef.current = input;
        recognitionRef.current.start();
      } catch (err) {
        console.error("Failed to start SpeechRecognition:", err);
      }
    }
  };

  const handleSpeak = (text, idx) => {
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
      if (speakingMsgIdx === idx) {
        setSpeakingMsgIdx(null);
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
              setSpeakingMsgIdx(null);
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
              setSpeakingMsgIdx(null);
              window.activeFallbackAudio = null;
            };
            audio.play().catch(err => {
              console.error("Audio playback failed:", err);
              setSpeakingMsgIdx(null);
              window.activeFallbackAudio = null;
            });
          };

          setSpeakingMsgIdx(idx);
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
      setSpeakingMsgIdx(null);
    };

    utterance.onerror = () => {
      setSpeakingMsgIdx(null);
    };

    setSpeakingMsgIdx(idx);
    window.speechSynthesis.speak(utterance);
  };

  const [activeDocName, setActiveDocName] = useState(() => t("activeDocLoading", "common"));
  const [activeDocVer, setActiveDocVer] = useState("");

  useEffect(() => {
    if (docId) {
      getAnalysis(docId)
        .then(data => {
          setActiveDocName(data.filename || t("legalContract", "common"));
          setActiveDocVer(data.metadata?.document_type || "NDA");
          
          setMessages([
            { role: "assistant", content: `${t("docGreeting", "chatbot")} "${data.filename || t("legalContract", "common")}".` }
          ]);
        })
        .catch(() => {
          setActiveDocName(t("legalContract", "common"));
          setActiveDocVer("");
          setMessages([
            { role: "assistant", content: `${t("docGreeting", "chatbot")} "${t("legalContract", "common")}".` }
          ]);
        });
    } else {
      setActiveDocName("");
      setActiveDocVer("");
      setMessages([
        { role: "assistant", content: t("generalGreeting", "chatbot") }
      ]);
    }
  }, [docId, lang]);

  const handleChatSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || typing) return;
    
    const userMsg = { role: "user", content: input };
    setMessages(prev => [...prev, userMsg]);
    const question = input;
    setInput("");
    setTyping(true);

    if (window.speechSynthesis || window.activeFallbackAudio) {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (window.activeFallbackAudio) {
        window.activeFallbackAudio.pause();
        window.activeFallbackAudio = null;
      }
      setSpeakingMsgIdx(null);
    }
    
    try {
      const response = await chatWithDocument(docId || "general", question);
      setMessages(prev => [...prev, { role: "assistant", content: response.answer || "No reply received." }]);
    } catch (err) {
      console.error("Floating chatbot error:", err);
      setMessages(prev => [...prev, { role: "assistant", content: "I encountered an error connecting to the LexiconAI advisor. Please verify the backend server is running." }]);
    } finally {
      setTyping(false);
    }
  };

  const isDocActiveView = 
    location.pathname.startsWith("/analysis") || 
    location.pathname.startsWith("/clauses") || 
    location.pathname.startsWith("/risk-assessment") || 
    location.pathname.startsWith("/chat");

  const mainNavLinks = [
    { label: t("dashboard", "nav"), path: "/dashboard" },
    { label: t("library", "nav"), path: "/library" },
    { label: "AI Negotiator", path: "/negotiate" },
    { label: "Analytics", path: "/analytics" }
  ];

  const handleSignOut = async () => {
    if (!window.confirm("Are you sure you want to log out?")) return;
    try {
      await signOut();
      navigate("/login");
    } catch (err) {
      console.error("Sign out failed:", err);
    }
  };

  // Extract display name from user metadata or email
  const displayName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "User";
  const userInitials = displayName.slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen bg-background text-primary flex flex-col font-sans select-none antialiased">
      {/* Top Fixed Header */}
      <header className="fixed top-0 left-0 right-0 h-14 bg-white border-b border-border z-40 flex items-center justify-between px-6">
        <div className="flex items-center gap-8">
          {/* Logo */}
          <Link to="/dashboard" className="flex items-center gap-2.5">
            <Scale className="w-[18px] h-[18px] text-primary" strokeWidth={2.2} />
            <span className="font-semibold text-[15px] tracking-tight uppercase">LexiconAI</span>
          </Link>

          {/* Toggle Sidebar Button */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 hover:bg-slate-100 rounded text-text-secondary hover:text-primary transition-colors focus:outline-none"
            title={sidebarOpen ? "Collapse Sidebar" : "Expand Sidebar"}
          >
            <Menu className="w-4 h-4" />
          </button>
          
          {/* Main Navigation */}
          <nav className="flex items-center h-14">
            {mainNavLinks.map((link) => {
              const isActive = location.pathname.startsWith(link.path);
              return (
                <Link
                  key={link.path}
                  to={link.path}
                  className={`h-full px-5 flex items-center text-[13px] font-medium transition-colors border-b-2 relative top-[1px] ${
                    isActive 
                      ? "border-primary text-primary font-semibold" 
                      : "border-transparent text-text-secondary hover:text-primary"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-3">
          {/* Dark Mode Toggle Button */}
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-1.5 hover:bg-slate-100 rounded text-text-secondary hover:text-primary transition-colors focus:outline-none cursor-pointer"
            title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {darkMode ? (
              <Sun className="w-4.5 h-4.5 text-amber-500 hover:rotate-45 transition-transform duration-300" />
            ) : (
              <Moon className="w-4.5 h-4.5 text-slate-500 hover:-rotate-12 transition-transform duration-300" />
            )}
          </button>
          {/* Global Language Selector Dropdown */}
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="px-2 py-1 bg-white border border-border rounded text-[11px] font-semibold text-text-secondary hover:border-primary focus:outline-none transition-all cursor-pointer shadow-xs mr-1"
            title="Choose Language / భాషను ఎంచుకోండి / भाषा चुनें"
          >
            <option value="en">English</option>
            <option value="te">తెలుగు</option>
            <option value="hi">हिन्दी</option>
          </select>

          <Link 
            to="/settings" 
            className="flex items-center gap-2 px-3 py-1.5 rounded text-[13px] text-text-secondary hover:text-primary transition-colors"
          >
            <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold">
              {userInitials}
            </div>
            <span className="hidden sm:inline">{displayName}</span>
          </Link>
          <button 
            onClick={() => navigate("/upload")}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-[13px] font-medium rounded hover:bg-primary-light transition-colors"
          >
            <Plus className="w-[15px] h-[15px]" />
            <span>{t("newAnalysis", "nav")}</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div className="flex-1 pt-14 flex items-stretch">
        
        {/* Context-Sensitive Sidebar */}
        <aside className={`bg-white border-r border-border fixed left-0 top-14 bottom-0 flex flex-col justify-between z-30 transition-all duration-300 ${
          sidebarOpen ? "w-64 translate-x-0" : "w-0 -translate-x-full overflow-hidden"
        }`}>
          <div className="p-4 flex-1 overflow-y-auto">
            {isDocActiveView ? (
              /* Active Document Context Navigation */
              <div className="space-y-6">
                <div>
                  <div className="flex items-center gap-2 text-text-muted mb-1 text-[11px] font-semibold uppercase tracking-wider">
                    <FileText className="w-[11px] h-[11px]" />
                    <span>{t("activeDoc", "common")}</span>
                  </div>
                  <h4 className="font-semibold text-[14px] leading-tight truncate text-primary">{activeDocName}</h4>
                  <p className="text-[11px] text-text-secondary mt-0.5">{activeDocVer}</p>
                </div>
                
                <hr className="border-border" />
                
                <nav className="space-y-1">
                  <Link
                    to={`/analysis/${docId}`}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname.startsWith("/analysis")
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <FileText className="w-4 h-4" />
                    <span>{t("documentOverview", "nav")}</span>
                  </Link>

                  <Link
                    to={`/clauses/${docId}`}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname.startsWith("/clauses")
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <Activity className="w-4 h-4" />
                    <span>{t("clauseAnalysis", "nav")}</span>
                  </Link>

                  <Link
                    to={`/risk-assessment/${docId}`}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname.startsWith("/risk-assessment")
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <AlertTriangle className="w-4 h-4" />
                    <span>{t("riskAssessment", "nav")}</span>
                  </Link>

                  <Link
                    to={`/chat/${docId}`}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname.startsWith("/chat")
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <MessageSquare className="w-4 h-4" />
                    <span>{t("aiAssistant", "nav")}</span>
                  </Link>

                  <Link
                    to={`/messages/${docId}`}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname.startsWith("/messages")
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <MessageSquare className="w-4 h-4 text-emerald-600" />
                    <span>{t("collaborationChat", "nav")}</span>
                  </Link>

                  <Link
                    to={`/split-view?docA=${docId}`}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors hover:bg-primary-50 hover:text-primary ${
                      location.pathname.startsWith("/split-view") ? "bg-primary-100 text-primary font-semibold" : "text-text-secondary"
                    }`}
                  >
                    <Columns className="w-4 h-4" />
                    <span>{t("splitComparison", "nav")}</span>
                  </Link>
                </nav>
              </div>
            ) : (
              /* Global Context Navigation */
              <div className="space-y-6">
                <div>
                  <div className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
                    {t("workspace", "common")}
                  </div>
                  <h4 className="font-semibold text-[14px] mt-1 text-primary">LexiconAI</h4>
                  <p className="text-[11px] text-text-secondary">{userRole === "client" ? t("clientPortal", "common") : t("platform", "common")}</p>
                </div>

                <hr className="border-border" />

                <nav className="space-y-1">
                  <Link
                    to="/dashboard"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/dashboard"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <Activity className="w-4 h-4" />
                    <span>{t("dashboard", "nav")}</span>
                  </Link>

                  <Link
                    to="/library"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/library"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <Folder className="w-4 h-4" />
                    <span>{t("library", "nav")}</span>
                  </Link>

                  <Link
                    to="/history"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/history"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <History className="w-4 h-4" />
                    <span>{t("history", "nav")}</span>
                  </Link>

                  <Link
                    to="/upload"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/upload"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <UploadCloud className="w-4 h-4" />
                    <span>{t("newAnalysis", "nav")}</span>
                  </Link>

                  <Link
                    to="/notes"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/notes"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <FileText className="w-4 h-4 text-amber-600" />
                    <span>{t("notes", "nav")}</span>
                  </Link>

                  <Link
                    to="/messages"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/messages"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <MessageSquare className="w-4 h-4 text-emerald-600" />
                    <span>{t("messages", "nav")}</span>
                  </Link>

                  <Link
                    to="/appointments"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/appointments"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <Calendar className="w-4 h-4 text-purple-600" />
                    <span>{t("appointments", "nav")}</span>
                  </Link>

                  <Link
                    to="/split-view"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/split-view"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <Columns className="w-4 h-4 text-blue-600" />
                    <span>{t("split", "nav")}</span>
                  </Link>
                  <Link
                    to="/negotiate"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/negotiate"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <Bot className="w-4 h-4 text-purple-600" />
                    <span>AI Negotiator Sandbox</span>
                  </Link>

                  <Link
                    to="/analytics"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                      location.pathname === "/analytics"
                        ? "bg-primary-100 text-primary font-semibold"
                        : "text-text-secondary hover:bg-primary-50 hover:text-primary"
                    }`}
                  >
                    <TrendingUp className="w-4 h-4 text-rose-600" />
                    <span>Portfolio Analytics</span>
                  </Link>
                </nav>
              </div>
            )}
          </div>

          {/* Sidebar Footer */}
          <div className="p-4 border-t border-border bg-primary-50 space-y-3">
            <Link to="/settings" className="flex items-center gap-2.5 text-[13px] text-text-secondary hover:text-primary transition-colors">
              <Settings className="w-4 h-4" />
              <span>{t("settings", "nav")}</span>
            </Link>
            <hr className="border-border" />
            <button 
              onClick={handleSignOut}
              className="flex items-center gap-2.5 text-[13px] text-risk-red hover:text-risk-red font-medium transition-colors w-full"
            >
              <LogOut className="w-4 h-4" />
              <span>{t("signout", "nav")}</span>
            </button>
          </div>
        </aside>

        {/* Content Body */}
        <main className={`flex-1 overflow-x-hidden transition-all duration-300 ${
          sidebarOpen ? "pl-64" : "pl-0"
        }`}>
          <div className="p-8 max-w-7xl mx-auto min-h-full flex flex-col justify-between">
            <div className="page-transition">
              {children}
            </div>
            
            {/* Footer */}
            <footer className="mt-16 pt-8 border-t border-border flex items-center justify-between text-[11px] text-text-muted">
              <div>
                <span>© {new Date().getFullYear()} {t("rightsReserved", "common")}</span>
              </div>
              <div className="flex items-center gap-6">
                <Link to="/privacy" className="cursor-pointer hover:text-primary">{t("privacyPolicy", "common")}</Link>
                <Link to="/terms" className="cursor-pointer hover:text-primary">{t("termsOfService", "common")}</Link>
                <Link to="/security" className="cursor-pointer hover:text-primary">{t("securityArch", "common")}</Link>
              </div>
            </footer>
          </div>
        </main>
      </div>

      {/* Floating Global Chatbot Widget */}
      <div className="fixed bottom-20 right-12 z-50 flex flex-col items-end select-text">
        {/* Chat Window Popup */}
        {chatOpen && (
          <div className="mb-3 w-80 sm:w-96 h-[400px] bg-white border border-border rounded-lg shadow-xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
            {/* Header */}
            <div className="bg-primary text-white p-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-emerald-300 animate-pulse" />
                <span className="font-semibold text-xs tracking-tight uppercase">
                  {docId ? `${t("aiAssistant", "nav")}: ${activeDocVer || "NDA"}` : `LexiconAI ${t("aiAssistant", "nav")}`}
                </span>
              </div>
              <button 
                onClick={() => setChatOpen(false)}
                className="text-white hover:text-emerald-200 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Chat Body */}
            <div className="flex-1 p-4 overflow-y-auto space-y-3 bg-slate-50/50">
              {messages.map((msg, index) => (
                <div 
                  key={index}
                  className={`flex gap-2 max-w-[85%] ${msg.role === "user" ? "ml-auto flex-row-reverse" : "self-start"}`}
                >
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border text-[9px] font-bold ${
                    msg.role === "user" 
                      ? "bg-primary text-white border-primary" 
                      : "bg-emerald-50 border-emerald-100 text-emerald-800"
                  }`}>
                    {msg.role === "user" ? "ME" : <Bot className="w-3.5 h-3.5" />}
                  </div>
                  <div className="space-y-1">
                    <div className={`p-2.5 rounded-md text-[11px] leading-relaxed shadow-xs ${
                      msg.role === "user" 
                        ? "bg-primary text-white rounded-tr-none" 
                        : "bg-white border border-border text-primary rounded-tl-none"
                    }`}>
                      {msg.content}
                    </div>
                    {msg.role === "assistant" && (
                      <div className="flex items-center gap-1 pl-1">
                        <button
                          type="button"
                          onClick={() => handleSpeak(msg.content, index)}
                          className={`p-0.5 rounded hover:bg-slate-200 transition-colors text-text-secondary hover:text-primary focus:outline-none flex items-center gap-0.5 ${
                            speakingMsgIdx === index ? "text-risk-blue animate-pulse" : ""
                          }`}
                          title={speakingMsgIdx === index ? t("stop", "chatbot") : t("speak", "chatbot")}
                        >
                          {speakingMsgIdx === index ? (
                            <VolumeX className="w-3.5 h-3.5 text-risk-red" />
                          ) : (
                            <Volume2 className="w-3.5 h-3.5 text-risk-blue" />
                          )}
                          <span className="text-[9px] font-medium text-text-muted">
                            {speakingMsgIdx === index ? t("stop", "chatbot") : t("speak", "chatbot")}
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {typing && (
                <div className="flex gap-2 max-w-[85%] self-start">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center bg-emerald-50 border border-emerald-100 text-emerald-800">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                  <div className="p-2.5 bg-white border border-border rounded rounded-tl-none flex items-center gap-1">
                    <div className="w-1 h-1 bg-text-secondary rounded-full animate-bounce"></div>
                    <div className="w-1 h-1 bg-text-secondary rounded-full animate-bounce [animation-delay:0.2s]"></div>
                    <div className="w-1 h-1 bg-text-secondary rounded-full animate-bounce [animation-delay:0.4s]"></div>
                  </div>
                </div>
              )}
            </div>

            {/* Input Bar */}
            <form onSubmit={handleChatSubmit} className="p-2 bg-white border-t border-border flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={typing}
                placeholder={t("placeholder", "chatbot")}
                className="flex-1 px-3 py-1.5 border border-border rounded text-xs bg-slate-50 focus:outline-none focus:border-primary disabled:opacity-50"
              />
              <button
                type="button"
                onClick={toggleListening}
                disabled={typing}
                className={`p-1.5 border border-border rounded transition-all duration-200 flex items-center justify-center disabled:opacity-50 ${
                  isListening 
                    ? "bg-risk-red text-white border-risk-red animate-pulse scale-105" 
                    : "bg-white text-text-secondary hover:text-primary hover:border-primary"
                }`}
                title={isListening ? t("listening", "chatbot") : t("speakQuery", "chatbot")}
              >
                {isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              </button>
              <button
                type="submit"
                disabled={!input.trim() || typing}
                className="px-2.5 py-1.5 bg-primary hover:bg-primary-light text-white rounded text-xs transition-colors disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>
        )}

        {/* Floating Circular Button */}
        <button
          onClick={() => setChatOpen(!chatOpen)}
          className="w-12 h-12 bg-primary text-white rounded-full shadow-lg hover:bg-primary-light transition-all flex items-center justify-center relative hover:scale-105"
        >
          {chatOpen ? <X className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
        </button>
      </div>
    </div>
  );
}
