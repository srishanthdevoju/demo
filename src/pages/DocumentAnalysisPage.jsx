import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Shell from "@/components/layout/Shell";
import { useAuth } from "@/lib/AuthContext";
import { supabase } from "@/lib/supabase";
import { 
  getAnalysis, 
  getAnalysisText, 
  downloadReport, 
  getNotes, 
  saveNote, 
  deleteNote,
  shareDocument,
  getMessages,
  sendMessage,
  shareAnalysisByEmail,
  uploadDocument,
  createAppointment,
  chatWithDocument,
  getAppointments,
  getLawyers,
  sendDirectMessage
} from "@/lib/api";
import { 
  ZoomIn, 
  ZoomOut, 
  Download, 
  Search, 
  Sparkles, 
  MessageSquare,
  RefreshCw,
  FileText,
  ArrowRight,
  AlertCircle,
  Columns,
  Share2,
  Trash2,
  Plus,
  X,
  CheckCircle2,
  Calendar,
  Send,
  Mail,
  Bot,
  User,
  Clock,
  Video,
  ChevronRight,
  Activity,
  Maximize2
} from "lucide-react";

const renderFormattedContent = (content) => {
  if (!content) return null;
  
  const lines = content.split('\n');
  const elements = [];
  
  let inCodeBlock = false;
  let codeBlockLines = [];
  let codeLanguage = '';
  
  const renderInlineFormatting = (text) => {
    // 1. Process inline code `code`
    const codeParts = text.split(/(`[^`]+`)/g);
    return codeParts.flatMap((cp, cpIdx) => {
      if (cp.startsWith('`') && cp.endsWith('`')) {
        return (
          <code key={`code-${cpIdx}`} className="bg-slate-100 text-risk-red px-1.5 py-0.5 rounded font-mono text-[11px] border border-slate-200">
            {cp.slice(1, -1)}
          </code>
        );
      }
      
      // 2. Process bold **bold**
      const boldParts = cp.split(/(\*\*.*?\*\*)/g);
      return boldParts.flatMap((bp, bpIdx) => {
        if (bp.startsWith('**') && bp.endsWith('**')) {
          return (
            <strong key={`bold-${bpIdx}`} className="font-bold">
              {bp.slice(2, -2)}
            </strong>
          );
        }
        
        // 3. Process italic *italic* or _italic_
        const italicParts = bp.split(/(\*.*?\*|_.*?_)/g);
        return italicParts.map((ip, ipIdx) => {
          if ((ip.startsWith('*') && ip.endsWith('*')) || (ip.startsWith('_') && ip.endsWith('_'))) {
            return (
              <em key={`italic-${ipIdx}`} className="italic opacity-90">
                {ip.slice(1, -1)}
              </em>
            );
          }
          return ip;
        });
      });
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for code block boundary
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        const codeText = codeBlockLines.join('\n');
        elements.push(
          <div key={`code-block-${i}`} className="my-3 rounded-lg overflow-hidden border border-slate-700/30 bg-slate-900 shadow-sm font-mono text-[12px]">
            {codeLanguage && (
              <div className="bg-slate-800 text-slate-450 px-4 py-1.5 text-[10px] font-bold border-b border-slate-700/50 uppercase select-none">
                {codeLanguage}
              </div>
            )}
            <pre className="p-4 overflow-x-auto text-slate-100 select-text whitespace-pre leading-normal">
              <code>{codeText}</code>
            </pre>
          </div>
        );
        inCodeBlock = false;
        codeBlockLines = [];
        codeLanguage = '';
      } else {
        inCodeBlock = true;
        codeLanguage = line.trim().slice(3).trim();
      }
      continue;
    }
    
    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }
    
    const trimmedLine = line.trimStart();
    const leadingSpaces = line.length - trimmedLine.length;
    
    // Check for blockquote
    if (trimmedLine.startsWith('>')) {
      const quoteText = trimmedLine.slice(1).trim();
      elements.push(
        <blockquote key={i} className="border-l-4 border-slate-300 pl-3 italic opacity-80 my-2 leading-relaxed text-[12.5px]">
          {renderInlineFormatting(quoteText)}
        </blockquote>
      );
      continue;
    }
    
    // Check for lists (numbered, bullet, or asterisk)
    const listMatch = trimmedLine.match(/^(\d+\.|\*|-|•)\s+(.*)/);
    if (listMatch) {
      const bullet = listMatch[1];
      const rest = listMatch[2];
      
      const isUnordered = bullet === '*' || bullet === '-' || bullet === '•';
      
      if (isUnordered) {
        elements.push(
          <div 
            key={i} 
            className="flex items-start gap-2 my-1.5 leading-relaxed text-[12.5px]"
            style={{ marginLeft: `${leadingSpaces > 0 ? (leadingSpaces * 8) + 16 : 16}px` }}
          >
            <span className="shrink-0 mt-2 w-1.5 h-1.5 rounded-full bg-current opacity-60" />
            <span className="flex-1">{renderInlineFormatting(rest)}</span>
          </div>
        );
      } else {
        elements.push(
          <div 
            key={i} 
            className="flex items-start gap-2 my-1.5 leading-relaxed text-[12.5px]"
            style={{ marginLeft: `${leadingSpaces > 0 ? (leadingSpaces * 8) + 16 : 16}px` }}
          >
            <span className="font-semibold shrink-0 select-none min-w-[15px] opacity-80">{bullet}</span>
            <span className="flex-1">{renderInlineFormatting(rest)}</span>
          </div>
        );
      }
      continue;
    }
    
    // Handle horizontal line
    if (trimmedLine === '---' || trimmedLine === '***' || trimmedLine === '___') {
      elements.push(<hr key={i} className="my-4 border-t border-border/85" />);
      continue;
    }
    
    // Handle empty line spacing
    if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
      continue;
    }
    
    // Standard paragraph
    elements.push(
      <p key={i} className="my-1.5 leading-relaxed text-[12.5px]">
        {renderInlineFormatting(line)}
      </p>
    );
  }
  
  return elements;
};

export default function DocumentAnalysisPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, userRole } = useAuth();
  
  // Split Screen Adjustable Width state
  const [leftWidth, setLeftWidth] = useState(50); // percentage
  const containerRef = useRef(null);

  // Active Document states
  const [activeId, setActiveId] = useState(id);
  const [zoom, setZoom] = useState(100);
  const [activeHighlight, setActiveHighlight] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [documentText, setDocumentText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Tabs state
  const [activeTab, setActiveTab] = useState("overview"); // overview, chatbot, discussion, notes, clauses

  // Notes state
  const [notes, setNotes] = useState([]);
  const [newNote, setNewNote] = useState("");
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Sharing state
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [sharing, setSharing] = useState(false);
  const [shareSuccess, setShareSuccess] = useState("");
  const [shareError, setShareError] = useState("");

  // Email brief export states
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailRecipient, setEmailRecipient] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSuccess, setEmailSuccess] = useState("");

  // Related upload states
  const [uploadingRelated, setUploadingRelated] = useState(false);
  const [uploadError, setUploadError] = useState("");

  // Chatbot states (contextual to document)
  const [botMessages, setBotMessages] = useState([
    {
      id: 1,
      role: "assistant",
      content: "Hello! I am your AI Contract Assistant. I've analyzed this contract. Ask me any questions about its liability clauses, termination periods, risk parameters, or other specific legal details.",
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [botInput, setBotInput] = useState("");
  const [botTyping, setBotTyping] = useState(false);
  const botEndRef = useRef(null);

  // Discussion / Messaging states
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // Chat scheduling panel state
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [meetTitle, setMeetTitle] = useState("");
  const [meetDate, setMeetDate] = useState("");
  const [meetTime, setMeetTime] = useState("");

  // Send to Lawyer / Auto-share states
  const [showShareChatModal, setShowShareChatModal] = useState(false);
  const [sharingToChat, setSharingToChat] = useState(false);
  const [shareChatSuccess, setShareChatSuccess] = useState("");
  const [shareChatError, setShareChatError] = useState("");
  
  // Inline booking form states (if no appointment scheduled)
  const [needsBooking, setNeedsBooking] = useState(false);
  const [lawyersList, setLawyersList] = useState([]);
  const [selectedLawyerId, setSelectedLawyerId] = useState("");
  const [bookingDate, setBookingDate] = useState("");
  const [bookingTime, setBookingTime] = useState("");
  const [bookingSlots, setBookingSlots] = useState([]);

  useEffect(() => {
    if (selectedLawyerId) {
      const selectedLawyer = lawyersList.find(l => l.id === selectedLawyerId);
      if (selectedLawyer && selectedLawyer.available_slots) {
        setBookingSlots(selectedLawyer.available_slots.split(",").map(s => s.trim()));
      } else {
        setBookingSlots(["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]);
      }
    } else {
      setBookingSlots(["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]);
    }
    setBookingTime("");
  }, [selectedLawyerId, lawyersList]);

  const handleSendToLawyer = async () => {
    setSharingToChat(true);
    setShareChatSuccess("");
    setShareChatError("");
    setNeedsBooking(false);
    setShowShareChatModal(true);
    
    try {
      // 1. Fetch appointments
      const appts = await getAppointments();
      const upcoming = appts.filter(a => 
        (a.status === "scheduled" || a.status === "accepted") && 
        a.lawyer_id
      );
      
      if (upcoming.length > 0) {
        // We have an upcoming appointment! Send to direct chat.
        const appt = upcoming[0];
        const lawyerId = appt.lawyer_id;
        
        const displayName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Client";
        const msgContent = `📄 [ATTACHMENT: ANALYSIS REPORT]\n` +
          `Document: ${analysis?.filename || "Contract"}\n` +
          `Risk Score: ${riskScore}/10.0\n` +
          `Summary: ${summary?.tldr || summary?.main_summary || "No summary available."}\n` +
          `View Report: ${window.location.origin}/analysis/${activeId}`;
        
        // Send direct message
        await sendDirectMessage(lawyerId, msgContent);
        // Also send to document discussion if possible
        try {
          await sendMessage(activeId, msgContent, userRole, displayName);
        } catch (e) {
          console.error("Failed to post to doc discussion thread:", e);
        }
        
        setShareChatSuccess("Successfully sent report and analysis to your lawyer via chat!");
        setTimeout(() => setShowShareChatModal(false), 3000);
      } else {
        // No upcoming appointment found. Must book first.
        setNeedsBooking(true);
        // Fetch lawyers list
        const lawyersData = await getLawyers();
        setLawyersList(lawyersData || []);
      }
    } catch (err) {
      console.error("Failed to share with lawyer:", err);
      setShareChatError("Failed to verify appointment status. Please try again.");
    } finally {
      setSharingToChat(false);
    }
  };

  const handleBookAndShare = async (e) => {
    e.preventDefault();
    if (!selectedLawyerId || !bookingDate || !bookingTime) return;
    
    setSharingToChat(true);
    setShareChatSuccess("");
    setShareChatError("");
    
    try {
      // 1. Create appointment
      const apptTitle = `Consultation: ${analysis?.filename || "Contract Analysis"}`;
      const apptDescription = `Scheduled automatically when sharing analysis for ${analysis?.filename || "Contract"}`;
      
      await createAppointment({
        lawyer_id: selectedLawyerId,
        title: apptTitle,
        description: apptDescription,
        appointment_date: bookingDate,
        appointment_time: bookingTime,
        share_phone_with_lawyer: true
      });
      
      // 2. Send report analysis to chat
      const displayName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Client";
      const msgContent = `📄 [ATTACHMENT: ANALYSIS REPORT]\n` +
        `Document: ${analysis?.filename || "Contract"}\n` +
        `Risk Score: ${riskScore}/10.0\n` +
        `Summary: ${summary?.tldr || summary?.main_summary || "No summary available."}\n` +
        `View Report: ${window.location.origin}/analysis/${activeId}`;
        
      await sendDirectMessage(selectedLawyerId, msgContent);
      
      // Also send to doc discussion
      try {
        await sendMessage(activeId, msgContent, userRole, displayName);
      } catch (e) {
        console.error("Failed to post to doc discussion thread:", e);
      }
      
      setShareChatSuccess("Consultation booked and analysis successfully shared with your lawyer!");
      setTimeout(() => {
        setShowShareChatModal(false);
        setNeedsBooking(false);
      }, 3000);
    } catch (err) {
      console.error("Failed to book and share:", err);
      setShareChatError("Failed to book consultation and share. Please try again.");
    } finally {
      setSharingToChat(false);
    }
  };

  // Scroll to bottom helper
  const scrollToRef = (ref) => {
    ref.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Drag resizing handler
  const startResize = (e) => {
    e.preventDefault();
    const onMouseMove = (moveEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      if (newWidth > 25 && newWidth < 75) {
        setLeftWidth(newWidth);
      }
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // Fetch document analysis data
  const fetchDocDetails = async (docId) => {
    setLoading(true);
    setError("");
    try {
      const [analysisData, textData] = await Promise.all([
        getAnalysis(docId),
        getAnalysisText(docId).catch(() => ""),
      ]);
      setAnalysis(analysisData);
      setDocumentText(textData || "");
      
      // Auto-populate default email address for exports
      if (userRole === "client" && user?.id) {
        // Find lawyer email
        const { data } = await supabase
          .from("clients")
          .select("lawyers(email)")
          .eq("id", user.id)
          .single();
        if (data && data.lawyers) {
          setEmailRecipient(data.lawyers.email);
        }
      }
    } catch (err) {
      console.error("Failed to fetch analysis details:", err);
      setError("Failed to load analysis. Please check your network connection.");
    } finally {
      setLoading(false);
    }
  };

  // Fetch shared notes
  const fetchSharedNotes = async () => {
    setLoadingNotes(true);
    try {
      const notesData = await getNotes(activeId);
      setNotes(notesData || []);
    } catch (err) {
      console.error("Failed to load notes:", err);
    } finally {
      setLoadingNotes(false);
    }
  };

  // Fetch collaboration chat messages
  const fetchChatMessages = async () => {
    setChatLoading(true);
    try {
      const msgs = await getMessages(activeId);
      setChatMessages(msgs || []);
    } catch (err) {
      console.error("Failed to load chat messages:", err);
    } finally {
      setChatLoading(false);
    }
  };

  // Trigger loads on ID change
  useEffect(() => {
    if (activeId) {
      fetchDocDetails(activeId);
    }
  }, [activeId]);

  // Tab trigger loads
  useEffect(() => {
    if (activeTab === "notes" && activeId) {
      fetchSharedNotes();
    }
    if (activeTab === "discussion" && activeId) {
      fetchChatMessages();
    }
  }, [activeTab, activeId]);

  // Auto scroll chat interfaces
  useEffect(() => {
    if (activeTab === "chatbot") scrollToRef(botEndRef);
    if (activeTab === "discussion") scrollToRef(chatEndRef);
  }, [botMessages, chatMessages, botTyping, activeTab]);

  // Handle Note Addition
  const handleAddNote = async (e) => {
    e.preventDefault();
    if (!newNote.trim()) return;
    try {
      await saveNote(activeId, newNote);
      setNewNote("");
      fetchSharedNotes();
    } catch (err) {
      console.error("Failed to save note:", err);
    }
  };

  // Handle Note Deletion
  const handleDeleteNote = async (noteId) => {
    if (!window.confirm("Delete this note?")) return;
    try {
      await deleteNote(noteId);
      fetchSharedNotes();
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  };

  // Handle Document Sharing Modal submit
  const handleShareSubmit = async (e) => {
    e.preventDefault();
    if (!shareEmail.trim()) return;
    setSharing(true);
    setShareSuccess("");
    setShareError("");
    try {
      await shareDocument(activeId, shareEmail);
      setShareSuccess(`Document shared with ${shareEmail}!`);
      setShareEmail("");
      setTimeout(() => setShowShareModal(false), 2000);
    } catch (err) {
      setShareError(err.response?.data?.detail || "Sharing failed.");
    } finally {
      setSharing(false);
    }
  };

  // Handle Email Brief Export submit
  const handleEmailExportSubmit = async (e) => {
    e.preventDefault();
    if (!emailRecipient.trim()) return;
    setSendingEmail(true);
    setEmailSuccess("");
    try {
      await shareAnalysisByEmail(activeId, emailRecipient);
      setEmailSuccess(`Analysis brief exported successfully to ${emailRecipient}!`);
      setTimeout(() => {
        setShowEmailModal(false);
        setEmailSuccess("");
      }, 2500);
    } catch (err) {
      console.error("Email share failed:", err);
      alert("Failed to export email brief. Please try again.");
    } finally {
      setSendingEmail(false);
    }
  };

  // Handle Related PDF Upload
  const handleRelatedUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("Only PDF documents are accepted.");
      return;
    }
    setUploadingRelated(true);
    setUploadError("");
    try {
      // 1. Upload the related file
      const result = await uploadDocument(file);
      
      // 2. Link it in metadata with the current group ID
      const groupId = analysis?.metadata?.group_id || (window.crypto?.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36));
      const updatedLinkedDocs = [
        ...(analysis?.metadata?.linked_docs || []),
        { document_id: result.document_id, filename: result.metadata?.document_type || "Related NDA" }
      ];
      
      const newMetadata = {
        ...(analysis?.metadata || {}),
        group_id: groupId,
        linked_docs: updatedLinkedDocs
      };

      // Save updated links for both active and new document
      const db_agent = supabase;
      await db_agent.from("analyses").update({ metadata: newMetadata }).eq("document_id", activeId);
      
      const siblingLinkedDocs = [
        ...(analysis?.metadata?.linked_docs || []),
        { document_id: activeId, filename: analysis?.metadata?.document_type || "Linked NDA" }
      ].filter(d => d.document_id !== result.document_id);

      const siblingMetadata = {
        ...(result.metadata || {}),
        group_id: groupId,
        linked_docs: siblingLinkedDocs
      };
      await db_agent.from("analyses").update({ metadata: siblingMetadata }).eq("document_id", result.document_id);

      // Re-trigger load for linked list update
      fetchDocDetails(activeId);
      alert(`${file.name} uploaded and linked successfully to this contract group!`);
    } catch (err) {
      console.error("Related upload failed:", err);
      setUploadError("Upload failed. Verify backend services are active.");
    } finally {
      setUploadingRelated(false);
    }
  };

  // Handle AI Chatbot send
  const handleBotSend = async (e) => {
    e.preventDefault();
    if (!botInput.trim() || botTyping) return;

    const userMsg = {
      id: botMessages.length + 1,
      role: "user",
      content: botInput,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setBotMessages(prev => [...prev, userMsg]);
    setBotInput("");
    setBotTyping(true);

    try {
      const llmResponse = await chatWithDocument(activeId, userMsg.content);

      const botMsg = {
        id: botMessages.length + 2,
        role: "assistant",
        content: llmResponse.answer || "No response received.",
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setBotMessages(prev => [...prev, botMsg]);
    } catch (err) {
      console.error("Bot chat failed:", err);
      const errMsg = {
        id: botMessages.length + 2,
        role: "assistant",
        content: "I encountered an error retrieving contract details. Please make sure the backend server is active.",
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isError: true
      };
      setBotMessages(prev => [...prev, errMsg]);
    } finally {
      setBotTyping(false);
    }
  };

  // Handle Discussion Chat send
  const handleChatSend = async (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const displayName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "User";
    try {
      await sendMessage(activeId, chatInput, userRole, displayName);
      setChatInput("");
      fetchChatMessages();
    } catch (err) {
      console.error("Failed to send message:", err);
    }
  };

  // Handle appointment scheduling from chat discussion panel
  const handleInChatSchedule = async (e) => {
    e.preventDefault();
    if (!meetTitle.trim() || !meetDate || !meetTime) return;

    const formattedRequest = `[APPOINTMENT_REQUEST: ${meetTitle} | Date: ${meetDate} | Time: ${meetTime}]`;
    const displayName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "User";

    try {
      await sendMessage(activeId, formattedRequest, userRole, displayName);
      setShowScheduleForm(false);
      setMeetTitle("");
      setMeetDate("");
      setMeetTime("");
      fetchChatMessages();
    } catch (err) {
      console.error("Failed to send schedule message:", err);
    }
  };

  // Accept Appointment inside Chat message
  const handleAcceptAppointment = async (apptText, senderId) => {
    // Parse: "[APPOINTMENT_REQUEST: Title | Date: YYYY-MM-DD | Time: HH:MM]"
    try {
      const cleanText = apptText.replace("[APPOINTMENT_REQUEST:", "").replace("]", "");
      const [titlePart, datePart, timePart] = cleanText.split("|");
      const title = titlePart.trim();
      const date = datePart.replace("Date:", "").trim();
      const time = timePart.replace("Time:", "").trim();

      // Create appointment in appointments table
      await createAppointment({
        lawyer_id: user.id, // Current lawyer is accepting
        title: `Consultation: ${title}`,
        description: `Scheduled via Document Discussion Thread`,
        appointment_date: date,
        appointment_time: time
      });

      // Post confirmation message to chat
      const displayName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "User";
      const confirmationMsg = `[APPOINTMENT_CONFIRMED: ${title} | Date: ${date} | Time: ${time}]`;
      await sendMessage(activeId, confirmationMsg, userRole, displayName);
      
      fetchChatMessages();
      alert("Appointment accepted and logged in calendar!");
    } catch (err) {
      console.error("Failed to accept appointment:", err);
      alert("Error logging appointment.");
    }
  };

  // Render structured appointment cards inside chat message bubbles
  const renderChatMessage = (msg) => {
    const isRequest = msg.content.startsWith("[APPOINTMENT_REQUEST:");
    const isConfirmed = msg.content.startsWith("[APPOINTMENT_CONFIRMED:");

    if (isRequest) {
      const cleanText = msg.content.replace("[APPOINTMENT_REQUEST:", "").replace("]", "");
      const [titlePart, datePart, timePart] = cleanText.split("|");
      const title = titlePart.trim();
      const date = datePart.replace("Date:", "").trim();
      const time = timePart.replace("Time:", "").trim();

      return (
        <div className="bg-purple-50/70 border border-purple-200 rounded-md p-4 text-[12px] text-primary space-y-2.5 max-w-sm shadow-xs font-sans">
          <div className="flex items-start gap-2.5">
            <Calendar className="w-5 h-5 text-purple-600 shrink-0 mt-0.5" />
            <div>
              <h5 className="font-bold text-purple-950">Consultation Meeting Request</h5>
              <p className="text-[11px] text-text-secondary mt-0.5">{title}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-[11px] bg-white p-2 border border-purple-100 rounded text-text-secondary">
            <p><span className="font-semibold text-purple-900">Date:</span> {date}</p>
            <p><span className="font-semibold text-purple-900">Time:</span> {time}</p>
          </div>
          {userRole === "lawyer" ? (
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => handleAcceptAppointment(msg.content, msg.sender_id)}
                className="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded text-[10px] font-bold shadow-xs transition-colors"
              >
                Accept
              </button>
            </div>
          ) : (
            <div className="text-[10px] italic text-purple-700/80">Pending Counsel's approval...</div>
          )}
        </div>
      );
    }

    if (isConfirmed) {
      const cleanText = msg.content.replace("[APPOINTMENT_CONFIRMED:", "").replace("]", "");
      const [titlePart, datePart, timePart] = cleanText.split("|");
      const title = titlePart.trim();
      const date = datePart.replace("Date:", "").trim();
      const time = timePart.replace("Time:", "").trim();

      return (
        <div className="bg-emerald-50 border border-emerald-200 rounded-md p-4 text-[12px] text-primary space-y-3 max-w-sm shadow-xs font-sans">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <h5 className="font-bold text-emerald-950">Consultation Scheduled</h5>
              <p className="text-[11px] text-emerald-900 mt-0.5">{title}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-[11px] bg-white p-2 border border-emerald-100 rounded text-text-secondary">
            <p><span className="font-semibold text-emerald-800">Date:</span> {date}</p>
            <p><span className="font-semibold text-emerald-800">Time:</span> {time}</p>
          </div>
          <a
            href="https://meet.google.com/new"
            target="_blank"
            rel="noreferrer"
            className="w-full flex items-center justify-center gap-1 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] font-bold shadow-xs transition-colors text-center"
          >
            <Video className="w-3.5 h-3.5" />
            <span>Join Meeting Room</span>
          </a>
        </div>
      );
    }

    return <div className="text-[12.5px] whitespace-pre-wrap">{renderFormattedContent(msg.content)}</div>;
  };

  // Primary loader states
  if (loading && !analysis) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-32 bg-background">
          <div className="flex flex-col items-center gap-3">
            <RefreshCw className="w-6 h-6 text-primary animate-spin" />
            <span className="text-[13px] text-text-secondary">Analyzing workspace contract...</span>
          </div>
        </div>
      </Shell>
    );
  }

  const { summary, risks, clauses, metadata } = analysis || {};
  const totalRisks = risks?.length || 0;
  const riskScore = totalRisks > 0
    ? ((risks.reduce((sum, r) => sum + (r.severity_weight || 1), 0) / (totalRisks * 3)) * 10).toFixed(1)
    : "0.0";

  return (
    <Shell>
      <div className="flex flex-col h-[calc(100vh-120px)] space-y-4">
        
        {/* Workspace Toolbar */}
        <div className="flex flex-wrap items-center justify-between p-4 bg-white border border-border rounded-lg shadow-sm gap-4 shrink-0">
          <div className="flex flex-wrap items-center gap-3">
            <button 
              onClick={() => downloadReport(activeId)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-border hover:bg-slate-50 rounded text-[11px] font-semibold text-text-secondary hover:text-primary transition-colors shadow-xs"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Report</span>
            </button>

            <button 
              onClick={() => setShowEmailModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-border hover:bg-slate-50 rounded text-[11px] font-semibold text-text-secondary hover:text-primary transition-colors shadow-xs"
            >
              <Mail className="w-3.5 h-3.5 text-purple-600" />
              <span>Email Analysis Brief</span>
            </button>

            {userRole === "client" && (
              <button 
                onClick={handleSendToLawyer}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-border hover:bg-slate-50 rounded text-[11px] font-semibold text-text-secondary hover:text-primary transition-colors shadow-xs"
              >
                <Send className="w-3.5 h-3.5 text-emerald-600" />
                <span>Send to Lawyer</span>
              </button>
            )}
            
            {userRole === "lawyer" && (
              <button 
                onClick={() => setShowShareModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary-light rounded text-[11px] font-semibold text-white transition-colors shadow-xs"
              >
                <Share2 className="w-3.5 h-3.5" />
                <span>Share with Client</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[10px] text-risk-blue font-bold uppercase tracking-wider bg-primary-100/50 px-2 py-1 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-risk-green"></span>
              <span>Workspace Sync Active</span>
            </span>
          </div>
        </div>

        {/* DRAGGABLE SPLIT SCREEN CONTAINER */}
        <div 
          ref={containerRef} 
          className="flex-1 flex border border-border bg-white rounded-lg overflow-hidden shadow-sm relative min-h-0 select-none"
        >
          {/* LEFT PANEL: Document View + Group Linking */}
          <div 
            style={{ width: `${leftWidth}%` }}
            className="flex flex-col h-full min-w-0"
          >
            {/* Left Panel Header */}
            <div className="p-3 bg-slate-50 border-b border-border flex items-center justify-between shrink-0 select-none">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-primary shrink-0" />
                <span className="text-[12px] font-bold text-primary truncate uppercase tracking-tight">
                  {metadata?.document_type || "Legal Contract"}
                </span>
              </div>
              
              <div className="flex items-center gap-3 shrink-0">
                {/* Related Document Uploader */}
                <input
                  type="file"
                  id="related-pdf-upload"
                  className="hidden"
                  accept=".pdf"
                  onChange={handleRelatedUpload}
                  disabled={uploadingRelated}
                />
                <label
                  htmlFor="related-pdf-upload"
                  className="cursor-pointer text-[10px] font-bold text-text-secondary hover:text-primary flex items-center gap-1 bg-white border border-border px-2 py-1 rounded shadow-xs"
                >
                  {uploadingRelated ? (
                    <RefreshCw className="w-3 h-3 animate-spin text-primary" />
                  ) : (
                    <Plus className="w-3 h-3 text-primary" />
                  )}
                  <span>{uploadingRelated ? "Uploading..." : "Link PDF"}</span>
                </label>
              </div>
            </div>

            {/* Linked Documents Batch strip */}
            {metadata?.linked_docs && metadata.linked_docs.length > 0 && (
              <div className="px-4 py-2.5 bg-slate-100/70 border-b border-border/60 flex items-center gap-2 overflow-x-auto shrink-0 select-none">
                <span className="text-[9px] font-bold text-text-secondary uppercase tracking-wider shrink-0">Linked set:</span>
                <button
                  onClick={() => setActiveId(id)}
                  className={`px-2.5 py-1 text-[11px] font-semibold border rounded-md transition-colors shrink-0 ${
                    activeId === id 
                      ? "bg-primary text-white border-primary" 
                      : "bg-white text-text-secondary border-border hover:text-primary"
                  }`}
                >
                  Main contract
                </button>
                {metadata.linked_docs.map((doc) => (
                  <button
                    key={doc.document_id}
                    onClick={() => setActiveId(doc.document_id)}
                    className={`px-2.5 py-1 text-[11px] font-semibold border rounded-md transition-colors shrink-0 ${
                      activeId === doc.document_id 
                        ? "bg-primary text-white border-primary" 
                        : "bg-white text-text-secondary border-border hover:text-primary"
                    }`}
                  >
                    {doc.filename}
                  </button>
                ))}
              </div>
            )}

            {/* File display text area */}
            <div className="flex-1 overflow-y-auto p-10 font-serif text-[13.5px] leading-[1.8] text-primary select-text whitespace-pre-line relative selection:bg-primary-100">
              <div className="flex justify-between items-center text-[9px] text-text-muted font-sans border-b border-border/40 pb-3 mb-6 font-semibold uppercase tracking-wider select-none">
                <span>Contract Analysis Workspace</span>
                <span>{metadata?.document_type || "NDA"}</span>
              </div>
              
              {documentText ? (
                <p className="text-justify">{documentText}</p>
              ) : (
                <p className="text-text-secondary text-center italic mt-16 font-sans text-xs">No text preview available.</p>
              )}

              <div className="h-24"></div>

              <div className="absolute bottom-6 left-10 right-10 flex justify-between items-center text-[9px] text-text-muted font-sans border-t border-border/40 pt-3 select-none">
                <span>Parties: {metadata?.parties?.join(", ") || "Unknown"}</span>
                <span>Effective: {metadata?.effective_date || "Unknown"}</span>
              </div>
            </div>
          </div>

          {/* RESIZABLE DIVIDER DRAGGER */}
          <div 
            onMouseDown={startResize}
            className="w-1.5 hover:w-2 bg-border hover:bg-primary cursor-col-resize flex items-center justify-center shrink-0 transition-all group z-30 relative select-none"
          >
            <div className="absolute top-1/2 -translate-y-1/2 w-1.5 h-10 bg-slate-400 group-hover:bg-white rounded-full"></div>
          </div>

          {/* RIGHT PANEL: Tab Portal */}
          <div 
            style={{ width: `${100 - leftWidth}%` }}
            className="flex flex-col h-full min-w-0 bg-slate-50 border-l border-border"
          >
            {/* Tabs Selector Bar */}
            <div className="flex border-b border-border bg-white shrink-0 overflow-x-auto select-none">
              {[
                { id: "overview", label: "Overview & Risks", icon: AlertCircle },
                { id: "chatbot", label: "AI Chatbot", icon: Bot },
                { id: "discussion", label: "Discussion Thread", icon: MessageSquare },
                { id: "notes", label: "Shared Notes", icon: FileText },
                { id: "clauses", label: "Clauses", icon: Activity }
              ].map(tab => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-4 py-3 text-[12px] font-semibold flex items-center gap-1.5 border-b-2 transition-colors shrink-0 ${
                      activeTab === tab.id
                        ? "border-primary text-primary font-bold bg-slate-50"
                        : "border-transparent text-text-secondary hover:text-primary hover:bg-slate-50/50"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Tab Body Contents */}
            <div className="flex-1 overflow-y-auto p-5 min-h-0 flex flex-col">
              
              {/* TAB 1: OVERVIEW & RISKS */}
              {activeTab === "overview" && (
                <div className="space-y-6">
                  {/* Executive Tl;dr */}
                  <div className="bg-white border border-border rounded-lg p-5 shadow-xs space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">Executive Summary</h4>
                      <span className="text-[10px] bg-primary-100 text-primary font-bold px-2 py-0.5 rounded">
                        Risk Level: {riskScore}/10.0
                      </span>
                    </div>
                    <p className="text-[12.5px] leading-relaxed text-primary">
                      {summary?.tldr || summary?.main_summary || "No summary brief generated."}
                    </p>
                  </div>

                  {/* Multi-Document Cross Contradictions Findings */}
                  {metadata?.cross_contradictions?.inconsistencies && metadata.cross_contradictions.inconsistencies.length > 0 && (
                    <div className="bg-amber-50/40 border border-amber-200/50 rounded-lg p-5 space-y-3">
                      <div className="flex items-center justify-between border-b border-amber-200/40 pb-2">
                        <h4 className="text-[11px] font-bold text-amber-800 uppercase tracking-wider flex items-center gap-1.5">
                          <AlertCircle className="w-4 h-4 text-amber-600" />
                          <span>Linked Documents Contradictions</span>
                        </h4>
                        <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                          Index: {metadata.cross_contradictions.inconsistency_score}/10
                        </span>
                      </div>
                      
                      <div className="space-y-2.5">
                        {metadata.cross_contradictions.inconsistencies.map((inc, index) => (
                          <div key={index} className="bg-white p-3 border border-border rounded-md shadow-xs">
                            <div className="flex items-center justify-between">
                              <span className="text-[12px] font-bold text-primary">{inc.title}</span>
                              <span className="text-[8px] font-bold px-1.5 py-0.5 bg-amber-50 text-amber-800 border border-amber-200/30 rounded uppercase">
                                {inc.severity}
                              </span>
                            </div>
                            <p className="text-[11.5px] text-text-secondary mt-1 leading-relaxed">{inc.description}</p>
                            {inc.affected_sections && (
                              <p className="text-[9.5px] text-text-muted mt-2">Sections: {inc.affected_sections.join(", ")}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Risks List */}
                  <div className="space-y-3">
                    <h4 className="text-[11px] font-bold text-text-secondary uppercase tracking-wider">Identified Risk Findings</h4>
                    {risks && risks.length > 0 ? (
                      risks.map((risk, index) => {
                        const isHigh = risk.severity?.toLowerCase() === "high";
                        const isMed = risk.severity?.toLowerCase() === "medium";
                        const riskColor = isHigh ? "risk-red" : isMed ? "risk-amber" : "risk-green";
                        return (
                          <div 
                            key={index}
                            className="bg-white border border-border p-4 rounded-lg shadow-xs space-y-2 border-l-4"
                            style={{ borderLeftColor: `var(--color-${riskColor})` }}
                          >
                            <div className="flex justify-between items-start">
                              <h5 className="font-bold text-[12.5px] text-primary">{risk.title}</h5>
                              <span className={`text-[8.5px] font-extrabold px-1.5 py-0.5 rounded border uppercase tracking-wider bg-${riskColor}-light text-${riskColor} border-${riskColor}/15`}>
                                {risk.severity}
                              </span>
                            </div>
                            <p className="text-[12px] text-text-secondary leading-relaxed">{risk.description}</p>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-xs text-text-muted italic">No legal risks flagged in this contract.</p>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: AI CHATBOT (Dual-sided Document AI) */}
              {activeTab === "chatbot" && (
                <div className="flex-1 flex flex-col min-h-0">
                  {/* Chat feed */}
                  <div className="flex-1 overflow-y-auto space-y-4 pr-1 mb-4 bg-white border border-border rounded-lg p-4 min-h-0 select-text">
                    {botMessages.map(msg => (
                      <div key={msg.id} className={`flex gap-2.5 max-w-[85%] ${msg.role === "assistant" ? "self-start" : "ml-auto flex-row-reverse"}`}>
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border ${
                          msg.role === "assistant" ? "bg-primary-100 border-primary/10 text-primary" : "bg-primary text-white border-primary"
                        }`}>
                          {msg.role === "assistant" ? <Bot className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
                        </div>
                        <div className="space-y-1">
                          <div className={`p-3 rounded-md text-[12px] leading-relaxed shadow-xs ${
                            msg.role === "assistant" 
                              ? "bg-slate-50 border border-border text-primary rounded-tl-none" 
                              : "bg-primary text-white rounded-tr-none"
                          }`}>
                            {renderFormattedContent(msg.content)}
                          </div>
                          <div className={`text-[9px] text-text-muted ${msg.role === "assistant" ? "" : "text-right"}`}>{msg.time}</div>
                        </div>
                      </div>
                    ))}
                    {botTyping && (
                      <div className="flex gap-2.5 max-w-[85%] self-start">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center bg-primary-100 border border-primary/10 text-primary">
                          <Bot className="w-3.5 h-3.5" />
                        </div>
                        <div className="p-3 bg-slate-50 border border-border rounded rounded-tl-none flex items-center gap-1">
                          <div className="w-1 h-1 bg-text-secondary rounded-full animate-bounce"></div>
                          <div className="w-1 h-1 bg-text-secondary rounded-full animate-bounce [animation-delay:0.2s]"></div>
                          <div className="w-1 h-1 bg-text-secondary rounded-full animate-bounce [animation-delay:0.4s]"></div>
                        </div>
                      </div>
                    )}
                    <div ref={botEndRef} />
                  </div>

                  {/* Chat input form */}
                  <form onSubmit={handleBotSend} className="flex gap-2 shrink-0 select-none">
                    <input
                      type="text"
                      placeholder="Ask the AI about liabilities, compliance, or clauses..."
                      value={botInput}
                      onChange={(e) => setBotInput(e.target.value)}
                      disabled={botTyping}
                      className="flex-1 px-3 py-2 border border-border rounded text-[13px] bg-white focus:outline-none focus:border-primary disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={!botInput.trim() || botTyping}
                      className="px-3 py-2 bg-primary hover:bg-primary-light text-white rounded transition-colors disabled:opacity-50"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </form>
                </div>
              )}

              {/* TAB 3: DISCUSSION & SCHEDULING (Communication thread) */}
              {activeTab === "discussion" && (
                <div className="flex-1 flex flex-col min-h-0">
                  {/* Messages list */}
                  <div className="flex-1 overflow-y-auto space-y-4 pr-1 mb-4 bg-white border border-border rounded-lg p-4 min-h-0 select-text">
                    {chatMessages.length === 0 ? (
                      <div className="text-center py-12 text-text-muted italic text-[11px] font-sans">
                        No messages exchanged on this agreement yet. Use this channel to converse with counsel.
                      </div>
                    ) : (
                      chatMessages.map(msg => {
                        const isOwn = msg.sender_id === user?.id;
                        return (
                          <div key={msg.id} className={`flex gap-2.5 max-w-[85%] ${isOwn ? "ml-auto flex-row-reverse" : "self-start"}`}>
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border text-[10px] font-bold ${
                              isOwn ? "bg-primary text-white border-primary" : "bg-emerald-50 border-emerald-100 text-emerald-800"
                            }`}>
                              {msg.sender_name?.substring(0, 2).toUpperCase() || "ME"}
                            </div>
                            <div className="space-y-1">
                              <span className="text-[9px] text-text-secondary font-semibold block">{msg.sender_name} ({msg.sender_role})</span>
                              <div className={`p-3 rounded-md text-[12px] leading-relaxed shadow-xs ${
                                isOwn 
                                  ? "bg-primary text-white rounded-tr-none" 
                                  : "bg-slate-50 border border-border text-primary rounded-tl-none"
                              }`}>
                                {renderChatMessage(msg)}
                              </div>
                              <span className="text-[8px] text-text-muted block text-right">
                                {msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ""}
                              </span>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Scheduling popover panel inside chat tab */}
                  {showScheduleForm && (
                    <form onSubmit={handleInChatSchedule} className="bg-purple-50/50 border border-purple-200 rounded-lg p-4 mb-3 space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200 shrink-0 select-none">
                      <div className="flex items-center justify-between border-b border-purple-200/50 pb-1">
                        <span className="text-[11px] font-bold text-purple-900 flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          <span>Request Consultation</span>
                        </span>
                        <button type="button" onClick={() => setShowScheduleForm(false)} className="text-purple-900 text-xs">✕</button>
                      </div>
                      <div className="space-y-2">
                        <input
                          type="text"
                          required
                          placeholder="e.g. Discuss Risk Exceptions"
                          value={meetTitle}
                          onChange={(e) => setMeetTitle(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-purple-200/60 rounded text-xs bg-white focus:outline-none"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="date"
                            required
                            value={meetDate}
                            onChange={(e) => setMeetDate(e.target.value)}
                            className="w-full px-2.5 py-1.5 border border-purple-200/60 rounded text-xs bg-white focus:outline-none"
                          />
                          <input
                            type="time"
                            required
                            value={meetTime}
                            onChange={(e) => setMeetTime(e.target.value)}
                            className="w-full px-2.5 py-1.5 border border-purple-200/60 rounded text-xs bg-white focus:outline-none"
                          />
                        </div>
                      </div>
                      <button
                        type="submit"
                        className="w-full py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-[11px] font-bold shadow-xs transition-colors"
                      >
                        Request Appointment Card
                      </button>
                    </form>
                  )}

                  {/* Chat input forms and schedule trigger */}
                  <form onSubmit={handleChatSend} className="flex gap-2 shrink-0 select-none items-center">
                    {userRole === "client" && (
                      <button
                        type="button"
                        onClick={() => setShowScheduleForm(!showScheduleForm)}
                        title="Book appointment via messaging card"
                        className="p-2 bg-purple-100 hover:bg-purple-200 text-purple-700 rounded transition-colors shrink-0"
                      >
                        <Calendar className="w-4 h-4" />
                      </button>
                    )}
                    <input
                      type="text"
                      placeholder="Type a message to discuss changes..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      className="flex-1 px-3 py-2 border border-border rounded text-[13px] bg-white focus:outline-none focus:border-primary"
                    />
                    <button
                      type="submit"
                      disabled={!chatInput.trim()}
                      className="px-3 py-2 bg-primary hover:bg-primary-light text-white rounded transition-colors disabled:opacity-50"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </form>
                </div>
              )}

              {/* TAB 4: COLLABORATIVE SHARED NOTES */}
              {activeTab === "notes" && (
                <div className="flex flex-col flex-1 min-h-0 space-y-4">
                  {/* Notes Feed */}
                  <div className="flex-1 overflow-y-auto space-y-3 pr-1 bg-white border border-border rounded-lg p-4 min-h-0 select-text">
                    {loadingNotes ? (
                      <div className="text-center py-6 text-xs text-text-secondary">Retrieving shared notes...</div>
                    ) : notes.length === 0 ? (
                      <div className="text-center py-10 text-text-muted italic text-[11px]">
                        No shared notes created for this contract yet. Use the workspace notepad below.
                      </div>
                    ) : (
                      notes.map(note => (
                        <div key={note.id} className="p-3 bg-slate-50 border border-border rounded-lg relative group shadow-xs">
                          <p className="text-[12.5px] leading-relaxed text-primary whitespace-pre-wrap pr-6">{note.content}</p>
                          <div className="flex items-center gap-1.5 mt-2 text-[10px] text-text-muted font-sans border-t border-border/20 pt-1.5 select-none">
                            <span>Author: {note.user_id === user?.id ? "Me" : "Partner"}</span>
                            <span>•</span>
                            <span>{note.created_at ? new Date(note.created_at).toLocaleDateString() : ""}</span>
                          </div>
                          {note.user_id === user?.id && (
                            <button
                              onClick={() => handleDeleteNote(note.id)}
                              className="absolute right-2 top-2 text-text-muted hover:text-risk-red opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Delete note"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  {/* Add note input */}
                  <form onSubmit={handleAddNote} className="space-y-2 shrink-0 select-none">
                    <textarea
                      placeholder="Add a shared note on this agreement..."
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 border border-border rounded text-[12.5px] bg-white focus:outline-none focus:border-primary resize-none transition-all"
                    />
                    <button
                      type="submit"
                      disabled={!newNote.trim()}
                      className="w-full py-1.5 bg-primary hover:bg-primary-light text-white text-[11px] font-bold rounded flex items-center justify-center gap-1 disabled:opacity-50"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Save Note</span>
                    </button>
                  </form>
                </div>
              )}

              {/* TAB 5: CLAUSES */}
              {activeTab === "clauses" && (
                <div className="space-y-5 select-text">
                  {/* Standard Clauses */}
                  <div className="space-y-3">
                    <h4 className="text-[11px] font-bold text-text-secondary uppercase tracking-wider">Standard Clauses</h4>
                    {clauses?.standard_clauses && clauses.standard_clauses.length > 0 ? (
                      clauses.standard_clauses.map((c, idx) => (
                        <div key={idx} className="bg-white border border-border p-3.5 rounded-lg shadow-xs space-y-1.5">
                          <h5 className="font-semibold text-xs text-primary">{c.title}</h5>
                          <p className="text-[11.5px] text-text-secondary leading-relaxed bg-slate-50 p-2 rounded border border-border/40 font-serif whitespace-pre-wrap">{c.content}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-text-muted italic">No standard clauses extracted.</p>
                    )}
                  </div>

                  {/* Non-Standard Clauses */}
                  <div className="space-y-3">
                    <h4 className="text-[11px] font-bold text-text-secondary uppercase tracking-wider text-risk-amber">Non-Standard Clauses</h4>
                    {clauses?.non_standard_clauses && clauses.non_standard_clauses.length > 0 ? (
                      clauses.non_standard_clauses.map((c, idx) => (
                        <div key={idx} className="bg-white border border-border p-3.5 rounded-lg shadow-xs space-y-1.5 border-l-4 border-l-risk-amber">
                          <h5 className="font-semibold text-xs text-primary">{c.title}</h5>
                          <p className="text-[11.5px] text-text-secondary leading-relaxed bg-slate-50 p-2 rounded border border-border/40 font-serif whitespace-pre-wrap">{c.content}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-text-muted italic">No non-standard clauses flagged.</p>
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>

      </div>

      {/* Share Document Overlay Modal */}
      {showShareModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 select-none">
          <div className="bg-white border border-border rounded-lg shadow-xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-5 border-b border-border flex items-center justify-between bg-slate-50">
              <h3 className="font-semibold text-primary text-[14px] flex items-center gap-1.5">
                <Share2 className="w-4 h-4 text-primary" />
                <span>Share Legal Document</span>
              </h3>
              <button 
                onClick={() => { setShowShareModal(false); setShareError(""); setShareSuccess(""); }}
                className="text-text-muted hover:text-primary transition-colors text-xs"
              >
                ✕
              </button>
            </div>
            
            <form onSubmit={handleShareSubmit} className="p-5 space-y-4">
              <p className="text-[12px] text-text-secondary leading-relaxed">
                Enter your client's registered email. Once shared, the client can view this analysis in their read-only portal and coordinate messages with you.
              </p>
              
              {shareSuccess && (
                <div className="p-3 bg-risk-green-light border border-risk-green/20 rounded flex items-center gap-2 text-[12px] text-risk-green">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{shareSuccess}</span>
                </div>
              )}
              {shareError && (
                <div className="p-3 bg-risk-red-light border border-risk-red/20 rounded flex items-center gap-2 text-[12px] text-risk-red">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{shareError}</span>
                </div>
              )}

              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-text-secondary uppercase">Client Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="client@example.com"
                  value={shareEmail}
                  onChange={(e) => setShareEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded text-[13px] bg-background focus:outline-none focus:border-primary transition-colors"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowShareModal(false); setShareError(""); setShareSuccess(""); }}
                  className="px-3 py-2 border border-border rounded text-[12px] text-text-secondary hover:text-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sharing || !shareEmail.trim()}
                  className="px-4 py-2 bg-primary text-white rounded text-[12px] font-semibold hover:bg-primary-light transition-colors disabled:opacity-50"
                >
                  {sharing ? "Sharing..." : "Share Document"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Export Email Brief Overlay Modal */}
      {showEmailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 select-none">
          <div className="bg-white border border-border rounded-lg shadow-xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-5 border-b border-border flex items-center justify-between bg-slate-50">
              <h3 className="font-semibold text-primary text-[14px] flex items-center gap-1.5">
                <Mail className="w-4 h-4 text-purple-600" />
                <span>Export Brief to Email</span>
              </h3>
              <button 
                onClick={() => { setShowEmailModal(false); setEmailSuccess(""); }}
                className="text-text-muted hover:text-primary transition-colors text-xs"
              >
                ✕
              </button>
            </div>
            
            <form onSubmit={handleEmailExportSubmit} className="p-5 space-y-4">
              <p className="text-[12px] text-text-secondary leading-relaxed">
                Send a summary audit brief of this contract's main terms, risk flags, and inconsistencies directly to your partner's inbox.
              </p>
              
              {emailSuccess && (
                <div className="p-3 bg-risk-green-light border border-risk-green/20 rounded flex items-center gap-2 text-[12px] text-risk-green">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{emailSuccess}</span>
                </div>
              )}

              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-text-secondary uppercase">Recipient Email</label>
                <input
                  type="email"
                  required
                  placeholder="recipient@example.com"
                  value={emailRecipient}
                  onChange={(e) => setEmailRecipient(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded text-[13px] bg-background focus:outline-none focus:border-primary transition-colors"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowEmailModal(false); setEmailSuccess(""); }}
                  className="px-3 py-2 border border-border rounded text-[12px] text-text-secondary hover:text-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sendingEmail || !emailRecipient.trim()}
                  className="px-4 py-2 bg-primary text-white rounded text-[12px] font-semibold hover:bg-primary-light transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  {sendingEmail ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Sending...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Send Brief</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Send/Share to Lawyer Chat Modal */}
      {showShareChatModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 select-none animate-in fade-in duration-200">
          <div className="bg-white border border-border rounded-lg shadow-xl max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-5 border-b border-border flex items-center justify-between bg-slate-50">
              <h3 className="font-semibold text-primary text-[14px] flex items-center gap-1.5">
                <Send className="w-4 h-4 text-emerald-600" />
                <span>Send Analysis to Lawyer Chat</span>
              </h3>
              <button 
                onClick={() => { setShowShareChatModal(false); setShareChatError(""); setShareChatSuccess(""); setNeedsBooking(false); }}
                className="text-text-muted hover:text-primary transition-colors text-xs"
              >
                ✕
              </button>
            </div>
            
            <div className="p-5 space-y-4">
              {shareChatSuccess && (
                <div className="p-3 bg-risk-green-light border border-risk-green/20 rounded flex items-center gap-2 text-[12px] text-risk-green animate-in slide-in-from-top-1 duration-200">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{shareChatSuccess}</span>
                </div>
              )}
              {shareChatError && (
                <div className="p-3 bg-risk-red-light border border-risk-red/20 rounded flex items-center gap-2 text-[12px] text-risk-red animate-in slide-in-from-top-1 duration-200">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{shareChatError}</span>
                </div>
              )}

              {needsBooking ? (
                <form onSubmit={handleBookAndShare} className="space-y-4">
                  <div className="bg-amber-50 border border-amber-200/50 p-3.5 rounded text-[12px] text-amber-800 leading-relaxed space-y-1">
                    <span className="font-bold flex items-center gap-1">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>No Consultation Booked</span>
                    </span>
                    <p>To share this document's analysis with a lawyer, you must have an active or upcoming consultation scheduled. Please schedule a slot below to complete sharing.</p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-text-secondary uppercase">Select Lawyer</label>
                    <select
                      required
                      value={selectedLawyerId}
                      onChange={(e) => setSelectedLawyerId(e.target.value)}
                      className="w-full px-3 py-2 border border-border rounded text-[13px] bg-background focus:outline-none focus:border-primary transition-colors"
                    >
                      <option value="">Choose Counsel...</option>
                      {lawyersList.map(l => (
                        <option key={l.id} value={l.id}>{l.name} {l.specialty ? `(${l.specialty})` : ""}</option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-text-secondary uppercase">Select Date</label>
                      <input
                        type="date"
                        required
                        value={bookingDate}
                        onChange={(e) => setBookingDate(e.target.value)}
                        className="w-full px-3 py-2 border border-border rounded text-[13px] bg-white focus:outline-none focus:border-primary transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-text-secondary uppercase">Select Time Slot</label>
                      <select
                        required
                        value={bookingTime}
                        onChange={(e) => setBookingTime(e.target.value)}
                        className="w-full px-3 py-2 border border-border rounded text-[13px] bg-white focus:outline-none focus:border-primary transition-all"
                      >
                        <option value="">Slot...</option>
                        {bookingSlots.map((s, idx) => (
                          <option key={idx} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-2 border-t border-border mt-4">
                    <button
                      type="button"
                      onClick={() => { setShowShareChatModal(false); setNeedsBooking(false); }}
                      className="px-3 py-2 border border-border rounded text-[12px] text-text-secondary hover:text-primary transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={sharingToChat || !selectedLawyerId || !bookingDate || !bookingTime}
                      className="px-4 py-2 bg-primary text-white rounded text-[12px] font-semibold hover:bg-primary-light transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-sm"
                    >
                      {sharingToChat ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Scheduling...</span>
                        </>
                      ) : (
                        <>
                          <Calendar className="w-3.5 h-3.5" />
                          <span>Schedule & Send</span>
                        </>
                      )}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="space-y-4 py-2 text-center">
                  <div className="flex justify-center">
                    <RefreshCw className="w-8 h-8 text-primary animate-spin" />
                  </div>
                  <p className="text-[13px] text-text-secondary">Checking existing consultation details and matching counsel...</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </Shell>
  );
}
